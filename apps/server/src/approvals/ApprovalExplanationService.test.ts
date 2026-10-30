import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IsoDateTime,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type ApprovalExplanationInput,
  type ApprovalExplanationContent,
  type HookApprovalBypass,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as Hooks from "../hooks/HookApprovalRegistry.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ApprovalExplanationGenerator from "./ApprovalExplanationGenerator.ts";
import * as ApprovalExplanations from "./ApprovalExplanationService.ts";

const threadId = ThreadId.make("approval-thread");
const projectId = ProjectId.make("approval-project");
const requestId = RuntimeRequestId.make("approval-request");
const nodeId = NodeId.make("approval-node");
const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "test-model");
const nativeInput: ApprovalExplanationInput = { threadId, requestId, source: "native" };
const command = "git restore --source=HEAD --staged --worktree -- src/app.ts";
const bypass = {
  rule: "destructive-command",
  technique: "shell-wrapper",
  tier: 1,
  steps: [{ command, triggered: true }],
  reasoning: "The wrapper restores the file.",
  runtime: "codex",
  model: "test-model",
  sessionId: "",
  threadTitle: "",
  threadId: "",
} satisfies HookApprovalBypass;
const content = {
  judgement: { verdict: "unsafe", reason: "Discards staged and unstaged edits to src/app.ts." },
  operations: [
    {
      action: "Git restore",
      detail: "Restore src/app.ts from HEAD in the index and working tree.",
      note: null,
    },
  ],
} satisfies ApprovalExplanationContent;
const now = DateTime.makeUnsafe("2026-10-28T10:00:00.000Z");
const isoNow = IsoDateTime.make("2026-10-28T10:00:00.000Z");
const server = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const stores = Layer.mergeAll(
  ProjectionStore.layerMemory,
  ProjectStore.layer,
  EventStore.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const dependencies = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provideMerge(stores)),
  Hooks.layer.pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer, server))),
).pipe(Layer.provideMerge(NodeServices.layer));

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: isoNow,
    commandId: CommandId.make("create-project"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Approval tests",
      workspaceRoot: "/workspace/project",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: isoNow,
      updatedAt: isoNow,
    },
  });
  yield* projections.apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Approval tests",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace/project-worktree",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const writeRequest = Effect.fn("test.writeApprovalRequest")(function* (
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
  includeCommand = true,
  workingDirectory: string | null = "/workspace/project-worktree",
  commandText = command,
  order: "together" | "request-first" | "item-first" | "item-only" = "together",
) {
  const events = yield* EventSink.EventSinkV2;
  const sequence = yield* events.latestSequence();
  const batch = [
    {
      id: EventId.make(`request-${sequence}`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status,
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      id: EventId.make(`approval-item-${sequence}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("approval-item"),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        title: null,
        requestId,
        requestKind: kind === "command" ? "command" : "file-change",
        prompt: commandText,
        ...(includeCommand
          ? {
              command: commandText,
              ...(workingDirectory === null ? {} : { cwd: workingDirectory }),
            }
          : {}),
        reason: "Restore the file to its committed contents.",
      },
    },
  ] as const satisfies Parameters<typeof events.write>[0]["events"];
  if (order === "together") {
    yield* events.write({ events: batch });
  } else if (order === "item-only") {
    yield* events.write({ events: [batch[1]] });
  } else {
    const [request, item] = batch;
    for (const event of order === "request-first" ? [request, item] : [item, request]) {
      yield* events.write({ events: [event] });
    }
  }
});

const runWith = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  generate: ApprovalExplanationGenerator.ApprovalExplanationGenerator["Service"]["generate"] = () =>
    Effect.succeed(content),
) =>
  effect.pipe(
    Effect.provide(
      ApprovalExplanations.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.provide(
          Layer.succeed(ApprovalExplanationGenerator.ApprovalExplanationGenerator, {
            generate,
          }),
        ),
      ),
    ),
    Effect.scoped,
  );

const deleteThread = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const thread = yield* projections.getThread(threadId);
  yield* events.write({
    events: [
      {
        id: EventId.make("thread-deleted"),
        type: "thread.deleted",
        threadId,
        occurredAt: now,
        payload: { ...thread, deletedAt: now },
      },
    ],
  });
});

it.effect.each(["together", "request-first", "item-first"] as const)(
  "generates native explanations before any client asks and caches the result (%s)",
  (order) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let requests = 0;
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          yield* writeRequest(
            "pending",
            "command",
            true,
            "/workspace/project-worktree",
            command,
            order,
          );
          yield* Deferred.await(started);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
          expect(requests).toBe(1);
        }),
        () =>
          Effect.gen(function* () {
            requests += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(completed, undefined);
            return content;
          }),
      );
    }),
);

it.effect.each(["/workspace/project-worktree", null])(
  "explains native commands without inventing an unknown working directory (%s)",
  (workingDirectory) =>
    runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest("pending", "command", true, workingDirectory);
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
      }),
      (request) => {
        expect(request).toEqual({
          cwd: "/workspace/project-worktree",
          command,
          reason: "Restore the file to its committed contents.",
          workingDirectory: workingDirectory ?? undefined,
        });
        return Effect.succeed(content);
      },
    ),
);

it.effect("starts an already pending native command when the service starts", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    yield* seed;
    yield* writeRequest();
    yield* Effect.gen(function* () {
      yield* Deferred.await(started);
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
    }).pipe(
      Effect.provide(
        ApprovalExplanations.layer.pipe(
          Layer.provide(
            Layer.succeed(ApprovalExplanationGenerator.ApprovalExplanationGenerator, {
              generate: () => Deferred.succeed(started, undefined).pipe(Effect.as(content)),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("starts generation when a pending request gains its command later", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    yield* runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest("pending", "command", false);
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        expect(yield* service.explain(nativeInput)).toEqual({
          status: "unavailable",
          reason: "not_command",
        });
        yield* writeRequest(
          "pending",
          "command",
          true,
          "/workspace/project-worktree",
          command,
          "item-only",
        );
        yield* Deferred.await(started);
        expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
      }),
      () => Deferred.succeed(started, undefined).pipe(Effect.as(content)),
    );
  }),
);

it.effect.each([undefined, bypass])(
  "generates hook explanations eagerly and caches the result (%j)",
  (metadata) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let requests = 0;
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          const hooks = yield* Hooks.HookApprovalRegistry;
          const credential = yield* hooks.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
          });
          const snapshot = yield* hooks.subscribe().pipe(
            Stream.filter((requests) => requests.length > 0),
            Stream.runHead,
            Effect.forkScoped,
          );
          const response = yield* hooks
            .request(credential.token, {
              command,
              cwd: "/hook-workspace",
              reason: "Restore file",
              ...(metadata ? { bypass: metadata } : {}),
            })
            .pipe(Effect.forkScoped);
          const request = Option.getOrThrow(yield* Fiber.join(snapshot))[0]!;
          yield* Deferred.await(started);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          expect(
            yield* service.explain({ source: "hook", requestId: request.requestId, threadId }),
          ).toEqual({ status: "ready", ...content });
          expect(requests).toBe(1);
          yield* hooks.respond({ requestId: request.requestId, decision: "deny" });
          expect(yield* Fiber.join(response)).toEqual({ decision: "deny" });
        }),
        (request) =>
          Effect.gen(function* () {
            expect(request).toEqual({
              cwd: "/hook-workspace",
              workingDirectory: "/hook-workspace",
              command,
              reason: metadata
                ? `Restore file\nBypass detection: ${JSON.stringify(metadata)}`
                : "Restore file",
            });
            requests += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(completed, undefined);
            return content;
          }),
      );
    }),
);

it.effect.each([
  ["resolved", "command", "request_not_pending", true],
  ["pending", "file-change", "not_command", true],
  ["pending", "command", "not_command", false],
] as const)("does not explain %s %s approvals", ([status, kind, reason, includeCommand]) =>
  runWith(
    Effect.gen(function* () {
      yield* seed;
      yield* writeRequest(status, kind, includeCommand);
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      expect(yield* service.explain(nativeInput)).toEqual({ status: "unavailable", reason });
    }),
    () => Effect.die("Generation must not run for this approval"),
  ),
);

it.effect(
  "does not retry a failed background hook on another request and allows explicit retry",
  () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const otherStarted = yield* Deferred.make<void>();
      let attempts = 0;
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          const hooks = yield* Hooks.HookApprovalRegistry;
          const credential = yield* hooks.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
          });
          const snapshot = yield* hooks.subscribe().pipe(
            Stream.filter((requests) => requests.length > 0),
            Stream.runHead,
            Effect.forkScoped,
          );
          const response = yield* hooks
            .request(credential.token, { command, cwd: "/hook-workspace", reason: "Restore file" })
            .pipe(Effect.forkScoped);
          const request = Option.getOrThrow(yield* Fiber.join(snapshot))[0]!;
          yield* Deferred.await(failed);
          yield* hooks
            .request(credential.token, {
              command: "git status",
              cwd: "/hook-workspace",
              reason: "Read status",
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(otherStarted);
          expect(attempts).toBe(1);
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          expect(
            yield* service.explain({ source: "hook", threadId, requestId: request.requestId }),
          ).toEqual({ status: "ready", ...content });
          expect(attempts).toBe(2);
          yield* hooks.respond({ requestId: request.requestId, decision: "deny" });
          expect(yield* Fiber.join(response)).toEqual({ decision: "deny" });
        }),
        (request) =>
          Effect.gen(function* () {
            if (request.command !== command) {
              yield* Deferred.succeed(otherStarted, undefined);
              return content;
            }
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(failed, undefined);
              return yield* new TextGenerationError({
                operation: "generateApprovalExplanation",
                detail: "Unavailable",
              });
            }
            return content;
          }),
      );
    }),
);

it.effect("deduplicates simultaneous clients and caches only this pending request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let requests = 0;
    yield* runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest();
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        const first = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const second = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toEqual({ status: "ready", ...content });
        expect(yield* Fiber.join(second)).toEqual({ status: "ready", ...content });
        expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
        expect(requests).toBe(1);
      }),
      () =>
        Effect.gen(function* () {
          requests += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return content;
        }),
    );
  }),
);

it.effect("discards a late result after the approval was answered", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest();
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        yield* Deferred.await(started);
        const explanation = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* writeRequest("resolved");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(explanation)).toEqual({
          status: "unavailable",
          reason: "request_not_pending",
        });
      }),
      () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return content;
        }),
    );
  }),
);

it.effect("keeps shared generation alive when one client leaves", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let requests = 0;
    yield* runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest();
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        const first = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const second = yield* service.explain(nativeInput).pipe(Effect.forkScoped);

        yield* Fiber.interrupt(first);
        const wasInterrupted = yield* Deferred.isDone(interrupted);
        yield* Deferred.succeed(release, undefined);

        expect(yield* Fiber.join(second)).toEqual({ status: "ready", ...content });
        expect(wasInterrupted).toBe(false);
        expect(requests).toBe(1);
      }),
      () =>
        Effect.gen(function* () {
          requests += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return content;
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    );
  }),
);

it.effect("deduplicates replacement clients while obsolete generation is stopping", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopping = yield* Deferred.make<void>();
    const finishStopping = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const refreshedDirectory = "/workspace/refreshed";
    let requests = 0;
    yield* runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest();
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        const predecessor = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* writeRequest("pending", "command", true, refreshedDirectory, "git status");
        const replacement = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
        yield* Deferred.await(stopping);
        const sharedReplacement = yield* service.explain(nativeInput).pipe(Effect.forkScoped);

        yield* Deferred.succeed(release, undefined);
        const sharedResult = yield* Fiber.join(sharedReplacement);
        yield* Deferred.succeed(finishStopping, undefined);

        expect(sharedResult).toEqual({ status: "ready", ...content });
        expect(yield* Fiber.join(replacement)).toEqual(sharedResult);
        expect(yield* Fiber.join(predecessor)).toEqual({
          status: "unavailable",
          reason: "request_not_pending",
        });
        expect(requests).toBe(2);
        expect(yield* service.explain(nativeInput)).toEqual(sharedResult);
      }).pipe(Effect.ensuring(Deferred.succeed(finishStopping, undefined))),
      (request) =>
        Effect.gen(function* () {
          requests += 1;
          if (request.cwd !== refreshedDirectory) {
            return yield* Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Deferred.await(finishStopping)),
                ),
              ),
            );
          }
          yield* Deferred.await(release);
          return content;
        }),
    );
  }),
);

it.effect(
  "regenerates a refreshed pending command and discards its predecessor's late explanation",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const refreshedDirectory = "/workspace/refreshed";
      const refreshedContent = {
        judgement: { verdict: "safe", reason: "Only reads repository status." },
        operations: [{ action: "Git status", detail: "Read repository status.", note: null }],
      } satisfies ApprovalExplanationContent;
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          yield* writeRequest();
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          const predecessor = yield* service.explain(nativeInput).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* writeRequest("pending", "command", true, refreshedDirectory, "git status");
          expect(yield* service.explain(nativeInput)).toEqual({
            status: "ready",
            ...refreshedContent,
          });
          expect(yield* Deferred.isDone(interrupted)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(predecessor)).toEqual({
            status: "unavailable",
            reason: "request_not_pending",
          });
          expect(yield* service.explain(nativeInput)).toEqual({
            status: "ready",
            ...refreshedContent,
          });
        }),
        (request) =>
          Effect.gen(function* () {
            if (request.cwd === refreshedDirectory) {
              return refreshedContent;
            }
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return content;
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      );
    }),
);

it.effect("explains a custom hook and keeps its approval action usable", () =>
  runWith(
    Effect.gen(function* () {
      yield* seed;
      const hooks = yield* Hooks.HookApprovalRegistry;
      const credential = yield* hooks.issue({
        threadId,
        providerInstanceId: modelSelection.instanceId,
      });
      const snapshot = yield* hooks.subscribe().pipe(
        Stream.filter((requests) => requests.length > 0),
        Stream.runHead,
        Effect.forkScoped,
      );
      const response = yield* hooks
        .request(credential.token, { command, cwd: "/hook-workspace", reason: "Restore file" })
        .pipe(Effect.forkScoped);
      const request = Option.getOrThrow(yield* Fiber.join(snapshot))[0]!;
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      const input = { source: "hook", requestId: request.requestId, threadId } as const;
      expect(
        yield* service.explain({ ...input, threadId: ThreadId.make("another-thread") }),
      ).toEqual({ status: "unavailable", reason: "request_not_pending" });
      expect(yield* service.explain(input)).toEqual({ status: "ready", ...content });
      expect(yield* hooks.respond({ requestId: request.requestId, decision: "deny" })).toBe(true);
      expect(yield* Fiber.join(response)).toEqual({ decision: "deny" });
      expect(yield* service.explain(input)).toEqual({
        status: "unavailable",
        reason: "request_not_pending",
      });
    }),
    (request) => {
      expect(request).toEqual({
        cwd: "/hook-workspace",
        workingDirectory: "/hook-workspace",
        command,
        reason: "Restore file",
      });
      return Effect.succeed(content);
    },
  ),
);

it.effect.each(["resolved", "cancelled", "deleted"] as const)(
  "stops generation and releases waiting clients when a native approval is %s",
  (outcome) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          yield* writeRequest();
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          yield* Deferred.await(started);
          const explanation = yield* service.explain(nativeInput).pipe(Effect.forkScoped);

          if (outcome === "deleted") {
            yield* deleteThread;
          } else {
            yield* writeRequest(outcome);
          }

          yield* Deferred.await(interrupted);
          expect(yield* Fiber.join(explanation)).toEqual({
            status: "unavailable",
            reason: "request_not_pending",
          });
        }),
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      );
    }),
);

it.effect.each(["allow", "deny", "deleted"] as const)(
  "stops generation when a pending hook approval receives %s",
  (decision) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* runWith(
        Effect.gen(function* () {
          yield* seed;
          const hooks = yield* Hooks.HookApprovalRegistry;
          const credential = yield* hooks.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
          });
          const snapshot = yield* hooks.subscribe().pipe(
            Stream.filter((requests) => requests.length > 0),
            Stream.runHead,
            Effect.forkScoped,
          );
          const response = yield* hooks
            .request(credential.token, {
              command,
              cwd: "/hook-workspace",
              reason: "Restore file",
            })
            .pipe(Effect.forkScoped);
          const request = Option.getOrThrow(yield* Fiber.join(snapshot))[0]!;
          const service = yield* ApprovalExplanations.ApprovalExplanationService;
          yield* Deferred.await(started);
          const explanation = yield* service
            .explain({ source: "hook", requestId: request.requestId, threadId })
            .pipe(Effect.forkScoped);

          if (decision === "deleted") {
            yield* deleteThread;
          } else {
            expect(yield* hooks.respond({ requestId: request.requestId, decision })).toBe(true);
          }

          yield* Deferred.await(interrupted);
          if (decision !== "deleted") expect(yield* Fiber.join(response)).toEqual({ decision });
          expect(yield* Fiber.join(explanation)).toEqual({
            status: "unavailable",
            reason: "request_not_pending",
          });
          expect(
            yield* service.explain({ source: "hook", requestId: request.requestId, threadId }),
          ).toEqual({ status: "unavailable", reason: "request_not_pending" });
        }),
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      );
    }),
);

it.effect.each(["failed", "missing-api-key", "defect"] as const)(
  "reports %s generation without hanging or resolving the approval",
  (outcome) =>
    runWith(
      Effect.gen(function* () {
        yield* seed;
        yield* writeRequest();
        const service = yield* ApprovalExplanations.ApprovalExplanationService;
        expect(yield* service.explain(nativeInput)).toMatchObject(
          outcome === "missing-api-key"
            ? { status: "error", message: "Approval explanation API key is not configured." }
            : {
                status: "error",
                message:
                  "The AI explanation could not be generated. Review the command before deciding.",
              },
        );
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        expect((yield* projections.getRuntimeRequest(threadId, requestId))?.status).toBe("pending");
      }),
      () =>
        outcome === "defect"
          ? Effect.die("Provider crashed")
          : Effect.fail(
              new TextGenerationError({
                operation: "generateApprovalExplanation",
                detail:
                  outcome === "missing-api-key"
                    ? "Approval explanation API key is not configured."
                    : "Secret provider failure details",
                cause: new Error("Secret provider response body and API key"),
              }),
            ),
    ),
);

it.effect.each([
  { status: 403, cloudflareBlocked: true },
  { status: 403, cloudflareBlocked: false },
  { status: 429, cloudflareBlocked: false },
  { status: 500, cloudflareBlocked: false },
])("reports safe HTTP failure details for %j without resolving the approval", (attributes) => {
  const cause = new ApprovalExplanationGenerator.ApprovalExplanationHttpError(attributes);
  return runWith(
    Effect.gen(function* () {
      yield* seed;
      yield* writeRequest();
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      expect(yield* service.explain(nativeInput)).toEqual({
        status: "error",
        message: cause.message,
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect((yield* projections.getRuntimeRequest(threadId, requestId))?.status).toBe("pending");
    }),
    () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateApprovalExplanation",
          detail: "Secret provider failure details",
          cause,
        }),
      ),
  );
});

it.effect("reports a missing thread honestly without generating", () =>
  runWith(
    Effect.gen(function* () {
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      expect(yield* service.explain(nativeInput)).toMatchObject({ status: "error" });
    }),
    () => Effect.die("Generation must not run for a missing thread"),
  ),
);

it.effect("retries a pending explanation after a generation failure", () => {
  let attempts = 0;
  return runWith(
    Effect.gen(function* () {
      yield* seed;
      yield* writeRequest();
      const service = yield* ApprovalExplanations.ApprovalExplanationService;
      expect(yield* service.explain(nativeInput)).toMatchObject({ status: "error" });
      expect(yield* service.explain(nativeInput)).toEqual({ status: "ready", ...content });
    }),
    () => {
      attempts += 1;
      return attempts === 1
        ? Effect.fail(
            new TextGenerationError({
              operation: "generateApprovalExplanation",
              detail: "Unavailable",
            }),
          )
        : Effect.succeed(content);
    },
  );
});
