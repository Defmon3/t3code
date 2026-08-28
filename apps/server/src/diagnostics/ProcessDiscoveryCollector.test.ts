import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ServerProcessDiagnosticsResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  makeProcessDiscoveryCollector,
  mergeProcessDiscoveryRoots,
} from "./ProcessDiscoveryCollector.ts";

function diagnosticsSnapshot(pid: number): ServerProcessDiagnosticsResult {
  return {
    serverPid: process.pid,
    readAt: DateTime.makeUnsafe("2026-08-28T12:00:00.000Z"),
    processCount: 1,
    totalRssBytes: 1_024,
    totalCpuPercent: 1,
    hostCpuPercent: 1,
    hostMemoryUsedBytes: 1_024,
    hostMemoryTotalBytes: 2_048,
    processes: [
      {
        pid,
        startTimeMs: 1,
        ppid: 0,
        pgid: Option.none(),
        status: "Running",
        cpuPercent: 1,
        cpuTimeMs: 1,
        rssBytes: 1_024,
        elapsed: "0:01",
        command: "vitest run",
        depth: 0,
        childPids: [],
      },
    ],
    error: Option.none(),
  };
}

describe("ProcessDiscoveryCollector", () => {
  it("deduplicates and bounds known plus Git-discovered roots", () => {
    expect(
      mergeProcessDiscoveryRoots(
        ["/workspace", "/workspace/thread"],
        [
          { projectId: ProjectId.make("project-a"), path: "/workspace/thread" },
          { projectId: ProjectId.make("project-a"), path: "/workspace/worktree" },
        ],
        2,
      ),
    ).toEqual(["/workspace", "/workspace/thread"]);
  });

  it.effect("shares one underlying collector across concurrent environment requests", () =>
    Effect.gen(function* () {
      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let scans = 0;
      const collector = yield* makeProcessDiscoveryCollector({
        loadTopology: () =>
          Effect.succeed({
            knownRoots: ["/workspace"],
          }),
        loadWorktrees: () =>
          Effect.succeed({
            worktrees: [{ projectId: ProjectId.make("project-a"), path: "/workspace" }],
          }),
        maxRoots: 512,
        processDiagnostics: {
          read: () =>
            Effect.gen(function* () {
              scans += 1;
              yield* Deferred.succeed(scanStarted, undefined);
              yield* Deferred.await(releaseScan);
              return diagnosticsSnapshot(4242);
            }),
        },
      });

      const first = yield* Effect.forkChild(collector.read());
      yield* Deferred.await(scanStarted);
      const second = yield* Effect.forkChild(collector.read());
      yield* Effect.yieldNow;

      expect(scans).toBe(1);
      yield* Deferred.succeed(releaseScan, undefined);
      expect((yield* Fiber.join(first)).processes[0]?.pid).toBe(4242);
      expect((yield* Fiber.join(second)).processes[0]?.pid).toBe(4242);
    }),
  );

  it.effect("keeps Git topology out of steady-state process scans", () =>
    Effect.gen(function* () {
      let knownTopologyLoads = 0;
      let gitWorktreeLoads = 0;
      let scans = 0;
      const scannedRootSets: ReadonlyArray<string>[] = [];
      const collector = yield* makeProcessDiscoveryCollector({
        loadTopology: () =>
          Effect.sync(() => {
            knownTopologyLoads += 1;
            return {
              knownRoots:
                knownTopologyLoads === 1 ? ["/workspace"] : ["/workspace", "/workspace/thread"],
            };
          }),
        loadWorktrees: () =>
          Effect.sync(() => {
            gitWorktreeLoads += 1;
            return {
              worktrees: [{ projectId: ProjectId.make("project-a"), path: "/workspace" }],
            };
          }),
        maxRoots: 512,
        processDiagnostics: {
          read: (input) =>
            Effect.sync(() => {
              scans += 1;
              scannedRootSets.push([...(input.roots ?? [])]);
              return diagnosticsSnapshot(scans);
            }),
        },
      });

      yield* collector.read();
      yield* TestClock.adjust("2100 millis");
      yield* collector.read();

      expect(scans).toBe(2);
      expect(knownTopologyLoads).toBe(2);
      expect(gitWorktreeLoads).toBe(1);
      expect(scannedRootSets).toEqual([["/workspace"], ["/workspace", "/workspace/thread"]]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retains the warm environment snapshot across a thread handoff", () =>
    Effect.gen(function* () {
      let scans = 0;
      const collector = yield* makeProcessDiscoveryCollector({
        loadTopology: () =>
          Effect.succeed({
            knownRoots: ["/workspace"],
          }),
        loadWorktrees: () =>
          Effect.succeed({
            worktrees: [{ projectId: ProjectId.make("project-a"), path: "/workspace" }],
          }),
        maxRoots: 512,
        processDiagnostics: {
          read: () =>
            Effect.sync(() => {
              scans += 1;
              return diagnosticsSnapshot(4242);
            }),
        },
      });

      const firstThreadSnapshot = yield* collector.read();
      const secondThreadSnapshot = yield* collector.read();

      expect(scans).toBe(1);
      expect(secondThreadSnapshot).toBe(firstThreadSnapshot);
      expect(secondThreadSnapshot.registeredProjectWorktrees).toEqual([
        { projectId: ProjectId.make("project-a"), path: "/workspace" },
      ]);
    }),
  );
});
