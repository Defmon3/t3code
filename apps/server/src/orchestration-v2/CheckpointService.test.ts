import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect.each(["baseline", "capture", "materialize"] as const)(
  "bounds %s work and lock waits without releasing a workspace before cleanup",
  (operation) =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:deadline"),
        threadId: ThreadId.make("thread:deadline"),
        runId: RunId.make("run:deadline"),
        nodeId: NodeId.make("node:deadline"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:deadline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/deadline",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const started = yield* Deferred.make<void>();
      const releaseWork = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const holderDone = yield* Deferred.make<void>();
      const queuedDone = yield* Deferred.make<void>();
      const laterStarted = yield* Deferred.make<void>();
      let attempts = 0;
      let latePublication = false;
      const checkpointWork = Effect.gen(function* () {
        attempts += 1;
        if (attempts === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(releaseWork).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                latePublication = true;
              }),
            ),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
            ),
          );
        } else {
          yield* Deferred.succeed(laterStarted, undefined);
        }
      });
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: () =>
                operation === "materialize"
                  ? checkpointWork.pipe(Effect.as(false))
                  : Effect.succeed(false),
              captureCheckpoint: () => checkpointWork,
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const capture = () =>
          operation === "baseline"
            ? checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 })
            : operation === "materialize"
              ? checkpoints.materializeBaselineCheckpoint({
                  scope,
                  ordinalWithinScope: 0,
                  nodeId: scope.nodeId,
                  capturedAt: scope.createdAt,
                })
              : checkpoints.capture({
                  scope,
                  runId: scope.runId,
                  nodeId: NodeId.make("node:deadline"),
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  capturedAt: scope.createdAt,
                });
        const holder = yield* capture().pipe(
          Effect.result,
          Effect.tap(() => Deferred.succeed(holderDone, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        const queued = yield* capture().pipe(
          Effect.result,
          Effect.tap(() => Deferred.succeed(queuedDone, undefined)),
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 minutes");
        assert.isTrue(yield* Deferred.isDone(queuedDone));
        assert.isTrue(yield* Deferred.isDone(cleanupStarted));
        assert.isFalse(yield* Deferred.isDone(holderDone));
        const later = yield* capture().pipe(Effect.forkChild);
        yield* TestClock.adjust("0 millis");
        assert.isFalse(yield* Deferred.isDone(laterStarted));
        yield* Deferred.succeed(releaseCleanup, undefined);
        const timedOut = [yield* Fiber.join(holder), yield* Fiber.join(queued)];
        for (const result of timedOut) {
          if (operation === "baseline") {
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.strictEqual(result.failure._tag, "CheckpointBaselineCaptureError");
              assert.propertyVal(result.failure.cause, "_tag", "TimeoutError");
            }
          } else {
            assert.strictEqual(result._tag, "Success");
            if (result._tag === "Success") {
              assert.propertyVal(
                result.success,
                "status",
                operation === "capture" ? "error" : "missing",
              );
            }
          }
        }
        yield* Fiber.join(later);
        yield* Deferred.succeed(releaseWork, undefined);
        assert.strictEqual(attempts, 2);
        assert.isFalse(latePublication);
      }).pipe(
        Effect.provide(layerTest),
        Effect.ensuring(
          Deferred.succeed(releaseCleanup, undefined).pipe(
            Effect.andThen(Deferred.succeed(releaseWork, undefined)),
          ),
        ),
        Effect.scoped,
      );
    }),
);

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const nodeId = NodeId.make("node:capture-failure:materializing-run");
            const capturedAt = DateTime.add(scope.createdAt, { hours: 1 });
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId,
              capturedAt,
            });
            assert.strictEqual(materialized.status, "missing");
            assert.strictEqual(materialized.nodeId, nodeId);
            assert.deepEqual(materialized.capturedAt, capturedAt);
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect("preserves a slow baseline and waits for an in-flight capture of the same ref", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
      threadId: ThreadId.make("thread:slow-baseline"),
      runId: RunId.make("run:slow-baseline:1"),
      nodeId: NodeId.make("node:slow-baseline:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/slow",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
    const snapshots = yield* Ref.make(0);
    const firstSnapshotStarted = yield* Deferred.make<void>();
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: ({ checkpointRef }) =>
              Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
            captureCheckpoint: ({ checkpointRef }) =>
              Effect.gen(function* () {
                yield* Ref.update(snapshots, (count) => count + 1);
                yield* Deferred.succeed(firstSnapshotStarted, undefined);
                yield* Effect.sleep("10 seconds");
                yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
      const postTurn = yield* checkpoints
        .capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSnapshotStarted);
      const waitingBaseline = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 1 })
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
      assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

      const slowBaseline = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 2 })
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(slowBaseline))._tag, "Success");
      assert.strictEqual(yield* Ref.get(snapshots), 2);
      assert.strictEqual((yield* Ref.get(refs)).size, 2);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);
