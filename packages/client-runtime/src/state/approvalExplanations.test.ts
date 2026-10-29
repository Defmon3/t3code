import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  RuntimeRequestId,
  WS_METHODS,
  type ApprovalExplanationInput,
  type ApprovalExplanationResult,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import {
  approvalExplanationTarget,
  approvalExplanationView,
  createApprovalExplanationAtoms,
} from "./approvalExplanations.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import type { ThreadPendingApproval } from "./threadRequests.ts";

const approval: ThreadPendingApproval = {
  requestId: RuntimeRequestId.make("approval-command"),
  requestKind: "command",
  createdAt: "2026-06-20T00:00:00.000Z",
  responseCapability: "live",
};

const environmentId = EnvironmentId.make("approval-environment");
const threadRef = { environmentId, threadId: v2ThreadId };
const ready: ApprovalExplanationResult = {
  status: "ready",
  judgement: { verdict: "safe", reason: "Only reads repository status." },
  operations: [{ action: "Inspect", detail: "Changed repository files", note: null }],
};
const unsafeReady: ApprovalExplanationResult = {
  status: "ready",
  judgement: { verdict: "unsafe", reason: "Uncommitted changes will be lost." },
  operations: [{ action: "Restore", detail: "Tracked repository files", note: null }],
};
const uncertainReady: ApprovalExplanationResult = {
  status: "ready",
  judgement: { verdict: "uncertain", reason: "Claude's instructions are not shown." },
  operations: [
    {
      action: "SCP copy",
      detail: "audit-brief_0123456789abcdef0123456789abcdef01234567.txt → build-host",
      note: "overwrite",
    },
    { action: "Read", detail: "audit-brief.txt on build-host", note: null },
    { action: "SSH run", detail: "Claude on build-host", note: "permission checks bypassed" },
    { action: "Write log", detail: "audit-result.log", note: "overwrite" },
  ],
};

const makeHarness = Effect.fn("TestApprovalExplanations.makeHarness")(function* (
  allowed: boolean,
  generate: (input: ApprovalExplanationInput) => Effect.Effect<ApprovalExplanationResult>,
) {
  const requests = yield* Queue.unbounded<ApprovalExplanationInput>();
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Approval environment",
      httpBaseUrl: "https://query.example.test",
      wsBaseUrl: "wss://query.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.approvalsExplain]: (input: ApprovalExplanationInput) =>
            Queue.offer(requests, input).pipe(Effect.andThen(generate(input))),
        },
      } as unknown as RpcSession),
    ),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry["Service"]),
  );
  const session: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: allowed ? [AuthOrchestrationOperateScope] : [],
    permissions: allowed ? [AuthOrchestrationOperateScope] : [],
  };
  const registry = AtomRegistry.make({
    initialValues: [
      [
        createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId),
        AsyncResult.success(session),
      ],
    ],
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const explanations = createApprovalExplanationAtoms(runtime);
  const atom = (requestId = approval.requestId) =>
    explanations(approvalExplanationTarget(threadRef, { ...approval, requestId }));
  const forApproval = (pending: ThreadPendingApproval) =>
    explanations(approvalExplanationTarget(threadRef, pending));
  return { registry, requests, atom, forApproval };
});

describe("approval explanations", () => {
  it.effect("generates automatically when the approval atom is mounted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(true, () => Effect.succeed(ready));
        const atom = h.atom();
        yield* AtomRegistry.mount(h.registry, atom);

        expect(yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true })).toEqual(
          ready,
        );
        expect(yield* Queue.take(h.requests)).toEqual(
          approvalExplanationTarget(threadRef, approval).input,
        );
        expect(yield* Queue.size(h.requests)).toBe(0);
      }),
    ),
  );

  it.effect("does not send a generation request without permission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(false, () => Effect.succeed(ready));
        const atom = h.atom();
        yield* AtomRegistry.mount(h.registry, atom);

        expect(yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true })).toEqual(
          {
            status: "error",
            message:
              "This connection cannot request AI explanations. You can still review the command.",
          },
        );
        expect(yield* Queue.size(h.requests)).toBe(0);
      }),
    ),
  );

  it.effect("keeps a late predecessor result separate from its successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const predecessor = yield* Deferred.make<ApprovalExplanationResult>();
        const successor = yield* Deferred.make<ApprovalExplanationResult>();
        const h = yield* makeHarness(true, (input) =>
          Deferred.await(input.requestId === approval.requestId ? predecessor : successor),
        );
        const previous = h.atom();
        yield* AtomRegistry.mount(h.registry, previous);
        expect((yield* Queue.take(h.requests)).requestId).toBe(approval.requestId);
        const nextId = RuntimeRequestId.make("successor-approval");
        const next = h.atom(nextId);
        yield* AtomRegistry.mount(h.registry, next);
        expect((yield* Queue.take(h.requests)).requestId).toBe(nextId);
        expect(approvalExplanationView(h.registry.get(next)).status).toBe("loading");

        yield* Deferred.succeed(successor, ready);
        expect(yield* AtomRegistry.getResult(h.registry, next, { suspendOnWaiting: true })).toEqual(
          ready,
        );
        const previousResult = unsafeReady;
        yield* Deferred.succeed(predecessor, previousResult);
        expect(
          yield* AtomRegistry.getResult(h.registry, previous, { suspendOnWaiting: true }),
        ).toEqual(previousResult);
        expect(approvalExplanationView(h.registry.get(next))).toEqual(ready);
      }),
    ),
  );

  it.effect.each(["cached", "late"] as const)(
    "refreshes changed command content under the same request id with a %s predecessor",
    (predecessorState) =>
      Effect.scoped(
        Effect.gen(function* () {
          const predecessor = yield* Deferred.make<ApprovalExplanationResult>();
          const successor = yield* Deferred.make<ApprovalExplanationResult>();
          const replies = yield* Queue.unbounded<Deferred.Deferred<ApprovalExplanationResult>>();
          yield* Queue.offer(replies, predecessor);
          yield* Queue.offer(replies, successor);
          const h = yield* makeHarness(true, () =>
            Queue.take(replies).pipe(Effect.flatMap(Deferred.await)),
          );
          const original = {
            ...approval,
            command: "git status --short",
            cwd: "C:/original",
            reason: "Inspect repository",
          };
          const refreshed = {
            ...approval,
            command: "git restore --worktree .",
            cwd: "C:/updated",
            reason: "Restore repository",
          };
          const previous = h.forApproval(original);
          yield* AtomRegistry.mount(h.registry, previous);
          const originalInput = yield* Queue.take(h.requests);
          if (predecessorState === "cached") {
            yield* Deferred.succeed(predecessor, ready);
            expect(
              yield* AtomRegistry.getResult(h.registry, previous, { suspendOnWaiting: true }),
            ).toEqual(ready);
          }

          const next = h.forApproval(refreshed);
          yield* AtomRegistry.mount(h.registry, next);
          expect(yield* Queue.take(h.requests)).toEqual(originalInput);
          expect(approvalExplanationView(h.registry.get(next)).status).toBe("loading");
          const restored = unsafeReady;
          yield* Deferred.succeed(successor, restored);
          expect(
            yield* AtomRegistry.getResult(h.registry, next, { suspendOnWaiting: true }),
          ).toEqual(restored);

          if (predecessorState === "late") {
            yield* Deferred.succeed(predecessor, ready);
            expect(
              yield* AtomRegistry.getResult(h.registry, previous, { suspendOnWaiting: true }),
            ).toEqual(ready);
          }
          expect(approvalExplanationView(h.registry.get(next))).toEqual(restored);
        }),
      ),
  );

  it.each([
    { approval, source: "native", requestId: approval.requestId },
    {
      approval: { ...approval, hookRequestId: "hook-command" },
      source: "hook",
      requestId: "hook-command",
    },
  ])(
    "routes $source requests using the authoritative request id",
    ({ approval: pending, source, requestId }) => {
      expect(approvalExplanationTarget(threadRef, pending).input).toEqual({
        threadId: v2ThreadId,
        source,
        requestId,
      });
    },
  );

  it("shows pending generation without inventing an explanation", () => {
    expect(approvalExplanationView(AsyncResult.initial())).toMatchObject({ status: "loading" });
  });

  it.each([ready, unsafeReady, uncertainReady])(
    "preserves the $judgement.verdict judgement and every operation, filename and neutral note",
    (result) => {
      expect(approvalExplanationView(AsyncResult.success(result))).toEqual(result);
    },
  );

  it.each(["request_not_pending", "not_command", "project_unavailable"] as const)(
    "shows unavailable for %s",
    (reason) => {
      expect(
        approvalExplanationView(AsyncResult.success({ status: "unavailable", reason })),
      ).toMatchObject({ status: "unavailable" });
    },
  );

  it("shows generation failures as errors", () => {
    expect(
      approvalExplanationView(
        AsyncResult.success({ status: "error", message: "Provider is unavailable." }),
      ),
    ).toEqual({ status: "error", message: "Provider is unavailable." });
  });

  it("explains how to resolve an unsupported model", () => {
    expect(
      approvalExplanationView(
        AsyncResult.success({ status: "unavailable", reason: "provider_unsupported" }),
      ),
    ).toEqual({
      status: "unavailable",
      message:
        "This model cannot explain commands without tools. Choose another text-generation model in Settings.",
    });
  });

  it("does not expose transport error details", () => {
    const result = approvalExplanationView(
      AsyncResult.failure(Cause.fail(new Error("private endpoint"))),
    );
    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("private endpoint");
  });
});
