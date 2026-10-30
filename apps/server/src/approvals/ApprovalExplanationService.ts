import {
  HookApprovalBypass,
  RuntimeRequestId,
  type ApprovalExplanationInput,
  type ApprovalExplanationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as HookApprovalRegistry from "../hooks/HookApprovalRegistry.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApprovalExplanationGenerator from "./ApprovalExplanationGenerator.ts";

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
const isHttpError = Schema.is(ApprovalExplanationGenerator.ApprovalExplanationHttpError);
const explanationKey = (input: ApprovalExplanationInput) =>
  JSON.stringify([input.threadId, input.source, input.requestId]);
const encodeBypass = Schema.encodeSync(Schema.fromJsonString(HookApprovalBypass));
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
  const generation = yield* ApprovalExplanationGenerator.ApprovalExplanationGenerator;
  const events = yield* EventSink.EventSinkV2;
  const scope = yield* Effect.scope;
  const pending = new Map<
    string,
    {
      readonly input: ApprovalExplanationInput;
      readonly snapshot: string;
      readonly result: Deferred.Deferred<ApprovalExplanationResult>;
      readonly scope: Scope.Closeable;
    }
  >();

  const invalidate = Effect.fn("ApprovalExplanationService.invalidate")(function* (
    key: string,
    entry = pending.get(key),
  ) {
    if (!entry) return;
    if (pending.get(key) === entry) pending.delete(key);
    yield* Deferred.succeed(entry.result, unavailable);
    yield* Scope.close(entry.scope, Exit.void);
  });

  const readCommand = Effect.fn("ApprovalExplanationService.readCommand")(function* (
    input: ApprovalExplanationInput,
  ) {
    if (input.source === "hook") {
      const request = yield* hooks.getPending(input.requestId);
      if (request?.threadId !== input.threadId) return undefined;
      const thread = yield* projections.getThread(input.threadId);
      return thread.deletedAt === null
        ? {
            command: request.command,
            cwd: request.cwd,
            reason: request.bypass
              ? `${request.reason}\nBypass detection: ${encodeBypass(request.bypass)}`
              : request.reason,
          }
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
    function* (input: ApprovalExplanationInput, background = false) {
      const key = explanationKey(input);
      const command = yield* readCommand(input);
      if (command === undefined || command === "not_command") {
        yield* invalidate(key);
        return command === undefined
          ? unavailable
          : ({ status: "unavailable", reason: command } as const);
      }
      const snapshot = encodeCommandSnapshot(command);
      const response = yield* Effect.gen(function* () {
        const result = yield* Deferred.make<ApprovalExplanationResult>();
        const jobScope = yield* Scope.fork(scope);
        const existing = pending.get(key);
        const completed =
          existing && !background ? yield* Deferred.poll(existing.result) : Option.none();
        const retry = Option.isSome(completed) && (yield* completed.value).status === "error";
        if (existing?.snapshot === snapshot && !retry) {
          yield* Scope.close(jobScope, Exit.void);
          return existing.result;
        }
        pending.set(key, { input, snapshot, result, scope: jobScope });
        yield* Effect.gen(function* () {
          const current = yield* readCommand(input);
          if (
            current === undefined ||
            current === "not_command" ||
            encodeCommandSnapshot(current) !== snapshot
          )
            return unavailable;
          const thread = yield* projections.getThread(input.threadId);
          const project = yield* projects.get(thread.projectId);
          if (Option.isNone(project)) {
            return { status: "unavailable", reason: "project_unavailable" } as const;
          }
          const content = yield* generation.generate({
            cwd: command.cwd ?? thread.worktreePath ?? project.value.workspaceRoot,
            workingDirectory: command.cwd,
            command: command.command,
            reason: command.reason,
          });
          return { status: "ready", ...content } as const;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Approval explanation failed", {
              threadId: input.threadId,
              cause,
            }).pipe(
              Effect.as(
                cause._tag === "TextGenerationError" && isHttpError(cause.cause)
                  ? ({ status: "error", message: cause.cause.message } as const)
                  : cause._tag === "TextGenerationError" &&
                      cause.detail === "Approval explanation API key is not configured."
                    ? ({ status: "error", message: cause.detail } as const)
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
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Approval explanation could not finish", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(generationFailure)),
          ),
          Effect.flatMap((value) => Deferred.succeed(result, value)),
          Effect.onExit((exit) =>
            (Exit.isFailure(exit)
              ? Deferred.succeed(
                  result,
                  Cause.hasInterruptsOnly(exit.cause) ? unavailable : generationFailure,
                )
              : Effect.void
            ).pipe(Effect.andThen(Scope.close(jobScope, exit))),
          ),
          Effect.interruptible,
          Effect.forkIn(jobScope),
        );
        if (existing) yield* invalidate(key, existing);
        return result;
      }).pipe(Effect.uninterruptible);
      return background ? unavailable : yield* Deferred.await(response);
    },
    (effect, input, _background = false) =>
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
      Effect.gen(function* () {
        const ids = new Set(requests.map((request) => request.requestId as string));
        for (const [key, entry] of pending) {
          if (entry.input.source === "hook" && !ids.has(entry.input.requestId))
            yield* invalidate(key);
        }
        for (const request of requests) {
          yield* explain(
            { source: "hook", threadId: request.threadId, requestId: request.requestId },
            true,
          );
        }
      }),
    ),
    Effect.forkScoped,
  );
  const afterSequence = yield* events.latestSequence();
  yield* Stream.merge(
    events.stream({ afterSequence, eventType: "runtime-request.updated" }),
    Stream.merge(
      events.stream({ afterSequence, eventType: "thread.deleted" }),
      events.stream({ afterSequence, eventType: "turn-item.updated" }),
    ),
  ).pipe(
    Stream.runForEach(({ event }) =>
      Effect.gen(function* () {
        if (event.type === "thread.deleted") {
          for (const [key, entry] of pending) {
            if (entry.input.threadId === event.threadId) yield* invalidate(key);
          }
          return;
        }
        const requestId =
          event.type === "runtime-request.updated"
            ? event.payload.id
            : event.type === "turn-item.updated" && event.payload.type === "approval_request"
              ? event.payload.requestId
              : undefined;
        if (!requestId || requestId.startsWith("custom-hook:")) return;
        yield* explain({ threadId: event.threadId, source: "native", requestId }, true);
      }),
    ),
    Effect.tapError((cause) =>
      Effect.logError("Approval explanation lifecycle stream failed", { cause }),
    ),
    Effect.orDie,
    Effect.forkScoped,
  );

  const snapshot = yield* projections.getShellSnapshot();
  for (const thread of snapshot.threads) {
    if (!thread.pendingRuntimeRequest || thread.deletedAt !== null) continue;
    const { runtimeRequests } = yield* projections.getThreadRecords(thread.id, ["runtimeRequests"]);
    for (const request of runtimeRequests) {
      if (
        request.status === "pending" &&
        request.kind === "command" &&
        !request.id.startsWith("custom-hook:")
      ) {
        yield* explain({ source: "native", threadId: thread.id, requestId: request.id }, true);
      }
    }
  }

  return ApprovalExplanationService.of({ explain });
});

export const layer = Layer.effect(ApprovalExplanationService, make);
