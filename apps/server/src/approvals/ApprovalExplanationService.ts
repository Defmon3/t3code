import {
  RuntimeRequestId,
  type ApprovalExplanationInput,
  type ApprovalExplanationResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as HookApprovalRegistry from "../hooks/HookApprovalRegistry.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class ApprovalExplanationService extends Context.Service<
  ApprovalExplanationService,
  {
    readonly explain: (input: ApprovalExplanationInput) => Effect.Effect<ApprovalExplanationResult>;
  }
>()("t3/approvals/ApprovalExplanationService") {}

const unavailable = {
  status: "unavailable",
  reason: "request_not_pending",
} as const;
const generationFailure = {
  status: "error",
  message: "The AI explanation could not be generated. Review the command before deciding.",
} as const;
const explanationKey = (input: ApprovalExplanationInput) =>
  JSON.stringify([input.threadId, input.source, input.requestId]);
const encodeCommandSnapshot = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      command: Schema.String,
      reason: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
    }),
  ),
);

const make = Effect.gen(function* () {
  const hooks = yield* HookApprovalRegistry.HookApprovalRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const events = yield* EventSink.EventSinkV2;
  const scope = yield* Effect.scope;
  const pending = new Map<
    string,
    {
      readonly input: ApprovalExplanationInput;
      readonly snapshot: string;
      readonly result: Deferred.Deferred<ApprovalExplanationResult>;
    }
  >();

  const readCommand = Effect.fn("ApprovalExplanationService.readCommand")(function* (
    input: ApprovalExplanationInput,
  ) {
    if (input.source === "hook") {
      const request = yield* hooks.getPending(input.requestId);
      return request?.threadId === input.threadId
        ? { command: request.command, cwd: request.cwd, reason: request.reason }
        : undefined;
    }
    const thread = yield* projections.getThread(input.threadId);
    if (thread.deletedAt !== null) return undefined;
    const { request, item } = yield* projections.getRuntimeResponseContext(
      input.threadId,
      RuntimeRequestId.make(input.requestId),
    );
    if (request?.status !== "pending") return undefined;
    if (request.kind !== "command" || item?.type !== "approval_request" || !item.command?.trim()) {
      return "not_command" as const;
    }
    return { command: item.command, reason: item.reason, cwd: item.cwd };
  });

  const explain = Effect.fn("ApprovalExplanationService.explain")(
    function* (input: ApprovalExplanationInput) {
      const command = yield* readCommand(input);
      if (command === undefined) return unavailable;
      if (command === "not_command") return { status: "unavailable", reason: command } as const;
      const key = explanationKey(input);
      const snapshot = encodeCommandSnapshot(command);
      const result = yield* Deferred.make<ApprovalExplanationResult>();
      const existing = pending.get(key);
      if (existing?.snapshot === snapshot) return yield* Deferred.await(existing.result);
      pending.set(key, { input, snapshot, result });
      yield* Effect.gen(function* () {
        const thread = yield* projections.getThread(input.threadId);
        const project = yield* projects.get(thread.projectId);
        if (Option.isNone(project)) {
          return { status: "unavailable", reason: "project_unavailable" } as const;
        }
        const resolvedSettings = resolveProjectSettings(
          yield* settings.getSettings,
          thread.projectId,
        ).settings;
        const content = yield* generation.generateApprovalExplanation({
          cwd: command.cwd ?? thread.worktreePath ?? project.value.workspaceRoot,
          workingDirectory: command.cwd,
          command: command.command,
          reason: command.reason,
          modelSelection: resolvedSettings.textGenerationModelSelection,
        });
        return { status: "ready", ...content } as const;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Approval explanation failed", {
            threadId: input.threadId,
            cause,
          }).pipe(
            Effect.as(
              cause._tag === "TextGenerationError" && cause.reason === "provider_unsupported"
                ? ({ status: "unavailable", reason: "provider_unsupported" } as const)
                : generationFailure,
            ),
          ),
        ),
        Effect.flatMap((value) =>
          readCommand(input).pipe(
            Effect.map((current) =>
              current === undefined ||
              current === "not_command" ||
              encodeCommandSnapshot(current) !== snapshot
                ? unavailable
                : value,
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Approval explanation could not finish", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(generationFailure)),
        ),
        Effect.flatMap((value) => Deferred.succeed(result, value)),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Deferred.succeed(result, generationFailure) : Effect.void,
        ),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(result);
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Approval explanation request failed", {
            threadId: input.threadId,
            cause,
          }).pipe(
            Effect.as({
              status: "error",
              message: "The approval could not be read. Review the command before deciding.",
            } as const),
          ),
        ),
      ),
  );

  yield* hooks.subscribe().pipe(
    Stream.runForEach((requests) =>
      Effect.sync(() => {
        const ids = new Set(requests.map((request) => request.requestId as string));
        for (const [key, entry] of pending) {
          if (entry.input.source === "hook" && !ids.has(entry.input.requestId)) pending.delete(key);
        }
      }),
    ),
    Effect.forkScoped,
  );
  const afterSequence = yield* events.latestSequence();
  yield* Stream.merge(
    events.stream({ afterSequence, eventType: "runtime-request.updated" }),
    events.stream({ afterSequence, eventType: "thread.deleted" }),
  ).pipe(
    Stream.runForEach(({ event }) =>
      Effect.sync(() => {
        if (event.type === "thread.deleted") {
          for (const [key, entry] of pending) {
            if (entry.input.threadId === event.threadId) pending.delete(key);
          }
          return;
        }
        if (event.type !== "runtime-request.updated" || event.payload.status === "pending") return;
        pending.delete(
          explanationKey({
            threadId: event.threadId,
            source: "native",
            requestId: event.payload.id,
          }),
        );
      }),
    ),
    Effect.tapError((cause) =>
      Effect.logError("Approval explanation lifecycle stream failed", { cause }),
    ),
    Effect.orDie,
    Effect.forkScoped,
  );

  return ApprovalExplanationService.of({ explain });
});

export const layer = Layer.effect(ApprovalExplanationService, make);
