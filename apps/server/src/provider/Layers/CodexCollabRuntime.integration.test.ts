/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type ProviderApprovalDecision, type ProviderEvent, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  CodexSessionRuntimeChildInterruptError,
  makeCodexSessionRuntime,
} from "./CodexSessionRuntime.ts";

const isCodexSessionRuntimeChildInterruptError = Schema.is(CodexSessionRuntimeChildInterruptError);

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const decodeMcpElicitationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
    }),
  ),
);
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

function capturedStartedActivity(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => {
    const item = (entry.params as { item?: { type?: string; kind?: string } }).item;
    return item?.type === "subAgentActivity" && item.kind === "started";
  });
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      item: {
        ...captured.params.item,
        agentThreadId: childId,
        agentPath: "/root/model-check",
      },
    },
  };
}

function capturedSpawnedThread(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started");
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: childId,
        sessionId: childId,
        parentThreadId: ROOT,
        agentNickname: "model-check",
        agentRole: "verifier",
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "model-check",
              agent_path: "/root/model-check",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: ROOT,
            },
          },
        },
      },
    },
  };
}

function childSettings(threadId: string, model: string, effort: string) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default", settings: { model } },
        cwd: "/workspace/repo",
        effort,
        model,
        modelProvider: "openai",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  };
}

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

interface MockCollabNotification {
  readonly method: string;
  readonly params: unknown;
}

function mockChildActivity(
  childThreadId: string,
  itemId: string,
  kind: "started" | "interacted" | "interrupted" = "started",
) {
  return {
    method: "item/completed",
    params: {
      threadId: ROOT,
      turnId: "00000000-0000-4000-8000-000000000100",
      completedAtMs: 1_700_000_000_000,
      item: {
        type: "subAgentActivity",
        id: itemId,
        kind,
        agentThreadId: childThreadId,
        agentPath: "/root/mock_worker",
      },
    },
  };
}

function mockChildCompletion(childThreadId: string, turnId: string) {
  return {
    method: "turn/completed",
    params: {
      threadId: childThreadId,
      turn: { id: turnId, status: "completed", items: [] },
    },
  };
}

function eventsForChild(events: ReadonlyArray<ProviderEvent>, childThreadId: string) {
  return events.filter(
    (event) =>
      (event.payload as { agentThreadId?: string } | undefined)?.agentThreadId === childThreadId,
  );
}

const runMockCollabScript = Effect.fn("CodexCollabRuntimeTest.runMockCollabScript")(function* (
  runtimeThreadId: string,
  input: string,
  notifications: ReadonlyArray<MockCollabNotification>,
) {
  const script = { rootThreadId: ROOT, notifications };
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
  yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })));

  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make(runtimeThreadId),
    binaryPath: peerPath,
    cwd: "/tmp",
    runtimeMode: "full-access",
    environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
  });
  const eventsFiber = yield* runtime.events.pipe(
    Stream.takeUntil((event) => event.method === "turn/completed"),
    Stream.runCollect,
    Effect.forkScoped,
  );

  yield* runtime.start();
  yield* runtime.sendTurn({ input });
  const events = Array.from(yield* Fiber.join(eventsFiber));
  yield* runtime.close;
  return events;
});

describe("CodexSessionRuntime collab integration", () => {
  it.effect("keeps full-access provider approvals disabled with configured hooks", () =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(
        scriptPath,
        JSON.stringify({ rootThreadId: ROOT, recordThreadStart: true, notifications: [] }),
        "utf8",
      );
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-hooks-full-access"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        hookPlan: {
          configPath: "hooks.json",
          hasPreToolUseHooks: true,
          hasPreToolUseHooksNow: Effect.succeed(true),
          evaluatePreToolUse: () => Effect.succeed({ decision: "allow" as const }),
          evaluateStop: () => Effect.succeed({ decision: "allow" as const }),
        },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Check policies" });
      const requests = readRecordedRequests();
      const start = requests.find((request) => request.method === "thread/start");
      const turn = requests.find((request) => request.method === "turn/start");
      assert.equal(start?.params.approvalPolicy, "never");
      assert.equal(turn?.params.approvalPolicy, "never");
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const notification of [
    {
      method: "item/started",
      params: {
        threadId: ROOT,
        turnId: "turn-file-change",
        startedAtMs: 0,
        item: {
          type: "fileChange",
          id: "file-change-1",
          status: "inProgress",
          changes: [{ path: "src/a.ts", diff: "@@ -1 +1 @@", kind: { type: "update" } }],
        },
      },
    },
    {
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: ROOT,
        turnId: "turn-file-change",
        itemId: "file-change-1",
        changes: [{ path: "src/a.ts", diff: "@@ -1 +1 @@", kind: { type: "update" } }],
      },
    },
  ] as const) {
    it.effect(`sends changed files to hooks after ${notification.method}`, () =>
      Effect.gen(function* () {
        const hookInputs: Array<unknown> = [];
        NodeFS.writeFileSync(
          scriptPath,
          JSON.stringify({
            rootThreadId: ROOT,
            holdTurnOpen: true,
            completeTurnOnServerResponse: true,
            notifications:
              notification.method === "item/fileChange/patchUpdated"
                ? [
                    {
                      method: "item/started",
                      params: {
                        ...notification.params,
                        item: {
                          type: "fileChange",
                          id: "file-change-1",
                          status: "inProgress",
                          changes: [],
                        },
                      },
                    },
                    notification,
                  ]
                : [notification],
            serverRequests: [
              {
                id: 91,
                method: "item/fileChange/requestApproval",
                params: {
                  threadId: ROOT,
                  turnId: "turn-file-change",
                  itemId: "file-change-1",
                  startedAtMs: 0,
                },
              },
            ],
          }),
          "utf8",
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-file-hooks"),
          binaryPath: peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "auto-accept-edits",
          hookPlan: {
            configPath: "hooks.json",
            hasPreToolUseHooks: true,
            hasPreToolUseHooksNow: Effect.succeed(true),
            evaluatePreToolUse: (input) => {
              hookInputs.push(input.toolInput);
              return Effect.succeed({ decision: "ask" as const, reason: "Review edits." });
            },
            evaluateStop: () => Effect.succeed({ decision: "allow" as const }),
          },
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approval = yield* Deferred.make<ProviderEvent>();
        yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "item/fileChange/requestApproval"),
          Stream.runForEach((event) => Deferred.succeed(approval, event).pipe(Effect.asVoid)),
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Edit src/a.ts" });
        const request = yield* Deferred.await(approval);
        assert.equal((request.payload as { approvalSource?: string }).approvalSource, "hook");
        assert.equal(
          (request.payload as { approvalReason?: string }).approvalReason,
          "Review edits.",
        );
        assert.isDefined(request.requestId);
        if (request.requestId !== undefined)
          yield* runtime.respondToRequest(request.requestId, "accept");
        assert.deepEqual(hookInputs, [
          {
            threadId: ROOT,
            turnId: "turn-file-change",
            itemId: "file-change-1",
            startedAtMs: 0,
            changes: [{ path: "src/a.ts", kind: { type: "update" } }],
          },
        ]);
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("asks when Codex omits changed files", () =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(
        scriptPath,
        JSON.stringify({
          rootThreadId: ROOT,
          holdTurnOpen: true,
          notifications: [
            {
              method: "item/started",
              params: {
                threadId: ROOT,
                turnId: "turn-unknown",
                startedAtMs: 0,
                item: {
                  type: "fileChange",
                  id: "file-change-empty",
                  status: "inProgress",
                  changes: [],
                },
              },
            },
          ],
          serverRequests: [
            {
              id: 92,
              method: "item/fileChange/requestApproval",
              params: {
                threadId: ROOT,
                turnId: "turn-unknown",
                itemId: "file-change-empty",
                startedAtMs: 0,
              },
            },
            {
              id: 93,
              method: "item/fileChange/requestApproval",
              params: {
                threadId: ROOT,
                turnId: "turn-unknown",
                itemId: "file-change-missing",
                startedAtMs: 0,
              },
            },
          ],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-unknown-file-hooks"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto-accept-edits",
        hookPlan: {
          configPath: "hooks.json",
          hasPreToolUseHooks: true,
          hasPreToolUseHooksNow: Effect.succeed(true),
          evaluatePreToolUse: () => Effect.die("Hook must not run."),
          evaluateStop: () => Effect.succeed({ decision: "allow" as const }),
        },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const approval = yield* Deferred.make<ProviderEvent>();
      const missingApproval = yield* Deferred.make<ProviderEvent>();
      let approvalCount = 0;
      yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "item/fileChange/requestApproval"),
        Stream.runForEach((event) => {
          approvalCount += 1;
          return Deferred.succeed(
            approvalCount === 1 ? approval : missingApproval,
            event,
          ).pipe(Effect.asVoid);
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Edit unknown file" });
      const request = yield* Deferred.await(approval);
      assert.equal(
        (request.payload as { approvalReason?: string }).approvalReason,
        "Changed files unknown.",
      );
      if (request.requestId !== undefined) {
        yield* runtime.respondToRequest(request.requestId, "decline");
      }
      const missingRequest = yield* Deferred.await(missingApproval);
      assert.equal(
        (missingRequest.payload as { approvalReason?: string }).approvalReason,
        "Changed files unknown.",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("looks up child model metadata once after activity registration", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          capturedStartedActivity(),
          capturedStartedActivity(),
          {
            ...capturedStartedActivity(CHILD_B),
            params: {
              ...capturedStartedActivity(CHILD_B).params,
              item: { ...capturedStartedActivity(CHILD_B).params.item, kind: "interacted" },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_B } },
          capturedSpawnedThread(ROOT),
        ],
        childResumeSnapshots: {
          [CHILD_A]: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-activity"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const metadataFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/metadataUpdated" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const session = yield* runtime.start();
      assert.equal(session.model, "gpt-5.6-sol");
      yield* runtime.sendTurn({ input: "start one child" });
      const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
      assert.deepInclude(metadataEvents[0]?.payload, {
        agentThreadId: CHILD_A,
        model: "gpt-5.6-luna",
        effort: "low",
      });
      assert.deepEqual(readRecordedRequests(), [
        {
          method: "thread/resume",
          params: { threadId: CHILD_A, excludeTurns: true },
        },
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps child settings and reroutes newer than the resume snapshot", () =>
    Effect.gen(function* () {
      const statusChanged = wireFixture.notifications.find(
        (entry) =>
          entry.method === "thread/status/changed" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(statusChanged);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          childSettings(CHILD_A, "child-before", "medium"),
          capturedSpawnedThread(),
          childSettings(CHILD_A, "child-after", "high"),
          {
            method: "model/rerouted",
            params: {
              threadId: CHILD_A,
              turnId: `${CHILD_A}-turn`,
              fromModel: "child-after",
              toModel: "child-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: ROOT,
              turnId: `${ROOT}-turn`,
              fromModel: "gpt-5.6-sol",
              toModel: "root-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            model: "stale-snapshot",
            reasoningEffort: "low",
            notifications: [statusChanged],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-spawn"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.method === "collabAgent/statusChanged" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one spawned child" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.deepInclude(started?.payload, {
        agentThreadId: CHILD_A,
        model: "child-before",
        effort: "medium",
      });
      const childStatus = events.find((event) => event.method === "collabAgent/statusChanged");
      assert.deepInclude(childStatus?.payload, {
        agentThreadId: CHILD_A,
        model: "child-rerouted",
        effort: "high",
      });
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "model/rerouted" &&
            (event.payload as { threadId?: string }).threadId === ROOT,
        ),
        "the root reroute must stay on the parent path",
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === "thread/settings/updated" || event.method === "model/rerouted") &&
            (event.payload as { threadId?: string }).threadId === CHILD_A,
        ),
        "child metadata notifications must not leak to the parent path",
      );
      assert.equal(readRecordedRequests().length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not delay the parent turn when the child lookup fails", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      for (const [name, childSnapshot] of [
        ["hang", { hang: true }],
        ["error", { error: "child unavailable" }],
      ] as const) {
        yield* Effect.gen(function* () {
          const marker = `lookup-${name}`;
          const script = {
            rootThreadId: ROOT,
            recordRequests: true,
            resumeRequestMarker: marker,
            notifications: [capturedStartedActivity()],
            childResumeSnapshots: { [CHILD_A]: childSnapshot },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-collab-model-${name}`),
            binaryPath: peerPath,
            cwd: NodeOS.tmpdir(),
            runtimeMode: "full-access",
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const eventsFiber = yield* runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.method === "serverRequest/resolved" &&
                (event.payload as { requestId?: string }).requestId === marker,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "finish without child metadata" });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.isTrue(events.some((event) => event.method === "turn/completed"));
          assert.equal(readRecordedRequests().length, 1);

          yield* runtime.close;
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays child completion received before registration", () =>
    Effect.gen(function* () {
      const childThreadId = "00000000-0000-4000-8000-000000000101";
      const events = yield* runMockCollabScript(
        "thread-collab-preregistration-completion",
        "finish before registration",
        [
          mockChildCompletion(childThreadId, "00000000-0000-4000-8000-000000000102"),
          mockChildActivity(childThreadId, "call_fixture_preregistration_completion"),
        ],
      );

      assert.deepEqual(
        eventsForChild(events, childThreadId).map((event) => event.method),
        ["collabAgent/activity", "collabAgent/turnCompleted"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays a terminal child error received before registration", () =>
    Effect.gen(function* () {
      const childThreadId = "00000000-0000-4000-8000-000000000201";
      const childTurnId = "00000000-0000-4000-8000-000000000202";
      const events = yield* runMockCollabScript(
        "thread-collab-preregistration-error",
        "fail before registration",
        [
          {
            method: "turn/started",
            params: {
              threadId: childThreadId,
              turn: { id: childTurnId, status: "inProgress", items: [] },
            },
          },
          {
            method: "error",
            params: {
              threadId: childThreadId,
              turnId: childTurnId,
              error: { message: "Synthetic terminal child error" },
              willRetry: false,
            },
          },
          mockChildActivity(childThreadId, "call_fixture_preregistration_error"),
        ],
      );
      const childEvents = eventsForChild(events, childThreadId);

      assert.deepEqual(
        childEvents.map((event) => event.method),
        ["collabAgent/activity", "collabAgent/statusChanged"],
      );
      assert.equal(
        (childEvents.at(-1)?.payload as { status?: { type?: string } } | undefined)?.status?.type,
        "systemError",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays a genuine child turn that started before interaction registration", () =>
    Effect.gen(function* () {
      const childThreadId = "00000000-0000-4000-8000-000000000301";
      const events = yield* runMockCollabScript(
        "thread-collab-preregistration-active",
        "start before registration",
        [
          {
            method: "turn/started",
            params: {
              threadId: childThreadId,
              turn: {
                id: "00000000-0000-4000-8000-000000000302",
                status: "inProgress",
                items: [],
              },
            },
          },
          mockChildActivity(childThreadId, "call_fixture_preregistration_active", "interacted"),
        ],
      );

      assert.deepEqual(
        eventsForChild(events, childThreadId).map((event) => event.method),
        ["collabAgent/activity", "collabAgent/turnStarted"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reconciles a quiet active child to idle from thread/read", () =>
    Effect.gen(function* () {
      const childThreadId = "00000000-0000-4000-8000-000000000401";
      NodeFS.writeFileSync(
        scriptPath,
        encodeFixtureJson({
          rootThreadId: ROOT,
          holdTurnOpen: true,
          childThreadReads: { [childThreadId]: { status: { type: "idle" }, turns: [] } },
          notifications: [
            {
              method: "turn/started",
              params: {
                threadId: childThreadId,
                turn: {
                  id: "00000000-0000-4000-8000-000000000402",
                  status: "inProgress",
                  items: [],
                },
              },
            },
            mockChildActivity(childThreadId, "call_fixture_quiet_child", "interacted"),
          ],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-quiet-reconcile"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const active = yield* Deferred.make<void>();
      const idle = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          const payload = event.payload as
            | { agentThreadId?: string; status?: { type?: string } }
            | undefined;
          if (payload?.agentThreadId !== childThreadId) return Effect.void;
          if (event.method === "collabAgent/turnStarted")
            return Deferred.succeed(active, undefined).pipe(Effect.asVoid);
          return event.method === "collabAgent/statusChanged" && payload.status?.type === "idle"
            ? Deferred.succeed(idle, undefined).pipe(Effect.asVoid)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "quiet child" });
      yield* Deferred.await(active);
      yield* TestClock.adjust("31 seconds");
      yield* Deferred.await(idle);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const childATurnId = (turnStartedA.params as { turn: { id: string } }).turn.id;
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        childThreadReads: {
          [CHILD_A]: {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: childATurnId, status: "inProgress", items: [] }],
          },
          [CHILD_B]: {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "refreshed-child-b-turn", status: "inProgress", items: [] }],
          },
          [MEMORY]: {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "memory-consolidation-turn", status: "inProgress", items: [] }],
          },
        },
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire, report the failed child, and still reach the
      // parent interrupt.
      const interruptError = yield* runtime.interruptTurn().pipe(Effect.flip);
      assert.isTrue(isCodexSessionRuntimeChildInterruptError(interruptError));

      const parseInterruptLine = (line: string) =>
        JSON.parse(line) as { threadId?: string; turnId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(
        interrupted.some(
          (entry) => entry.threadId === CHILD_B && entry.turnId === "refreshed-child-b-turn",
        ),
        "Stop must replace a stale child turn id with thread/read's active turn",
      );
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const elicitationCases = [
    {
      decision: "accept",
      response: { action: "accept", content: { approval: "once" } },
    },
    {
      decision: "acceptForSession",
      response: {
        action: "accept",
        _meta: { persist: "session" },
        content: { approval: "session" },
      },
    },
    {
      decision: "acceptAlways",
      response: {
        action: "accept",
        _meta: { persist: "always" },
        content: { approval: "always" },
      },
    },
    { decision: "decline", response: { action: "decline" } },
    { decision: "cancel", response: { action: "cancel" } },
  ] satisfies ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly response: Record<string, unknown>;
  }>;

  for (const { decision, response } of elicitationCases) {
    it.live(`returns the MCP elicitation ${decision} response to Codex`, () =>
      Effect.gen(function* () {
        const scriptedRequest = {
          id: 7001,
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            serverName: "computer-use",
            threadId: ROOT,
            turnId: wireFixture.responses.turnStart.turn.id,
            _meta: { app_name: "Safari", persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "session", "always"],
                },
              },
              required: ["approval"],
            },
          },
        };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          notifications: [],
          serverRequests: [scriptedRequest],
        };
        const responsesPath = `${scriptPath}.responses`;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(responsesPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(responsesPath, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-mcp-elicitation"),
          binaryPath: peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "auto",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approvalRequested = yield* Deferred.make<ProviderEvent>();
        const turnCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.method === "mcpServer/elicitation/request"
              ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Open Safari" });
        const approval = yield* Deferred.await(approvalRequested);
        assert.equal(approval.requestKind, "mcp-elicitation");
        assert.isDefined(approval.requestId);
        if (approval.requestId === undefined) return;

        yield* runtime.respondToRequest(approval.requestId, decision);
        yield* Deferred.await(turnCompleted);

        const recordedResponse = yield* decodeMcpElicitationResponse(
          NodeFS.readFileSync(responsesPath, "utf8"),
        );
        assert.equal(recordedResponse.id, scriptedRequest.id);
        assert.deepEqual(recordedResponse.result, response);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("auto-resolves MCP elicitations without a provider card in full-access", () =>
    Effect.gen(function* () {
      const scriptedRequest = {
        id: 7002,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          message: "Allow ChatGPT to use Safari?",
          serverName: "computer-use",
          threadId: ROOT,
          turnId: wireFixture.responses.turnStart.turn.id,
          requestedSchema: {
            type: "object",
            properties: {
              approval: {
                type: "string",
                enum: ["once", "session", "always"],
              },
            },
            required: ["approval"],
          },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        notifications: [],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-mcp-full-access"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Open Safari" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.isFalse(events.some((event) => event.method === "mcpServer/elicitation/request"));

      const recordedResponse = yield* decodeMcpElicitationResponse(
        NodeFS.readFileSync(responsesPath, "utf8"),
      );
      assert.equal(recordedResponse.id, scriptedRequest.id);
      assert.deepEqual(recordedResponse.result, { action: "accept", content: { approval: "once" } });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
