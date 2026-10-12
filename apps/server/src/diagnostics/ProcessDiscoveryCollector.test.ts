import { describe, expect, it } from "@effect/vitest";
import {
  GitCommandError,
  ProjectId,
  type ServerProcessDiagnosticsResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import {
  makeProcessDiscoveryCollector,
  makeRegisteredProjectProcessDiscovery,
  mergeProcessDiscoveryRoots,
} from "./ProcessDiscoveryCollector.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  v2Now,
  v2Project,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";

const registeredProjectsLayer = Layer.mergeAll(
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed([
        { ...v2Project, workspaceRoot: "/ordinary-folder" },
        { ...v2Project, id: ProjectId.make("project-git"), workspaceRoot: "/git-repo" },
      ]),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({
    getShellSnapshot: () =>
      Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads: [], archivedThreads: [] }),
  }),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    detect: ({ cwd }) =>
      Effect.gen(function* () {
        if (cwd === "/ordinary-folder") return null;
        const driver = yield* VcsDriver.VcsDriver;
        return {
          kind: "git" as const,
          driver,
          repository: {
            kind: "git" as const,
            rootPath: cwd,
            metadataPath: `${cwd}/.git`,
            freshness: {
              source: "live-local" as const,
              observedAt: v2Now,
              expiresAt: Option.none(),
            },
          },
        };
      }).pipe(
        Effect.provide(
          Layer.mock(VcsDriver.VcsDriver)({
            capabilities: {
              kind: "git",
              supportsWorktrees: true,
              supportsBookmarks: false,
              supportsAtomicSnapshot: false,
              supportsPushDefaultRemote: true,
              ignoreClassifier: "native",
            },
          }),
        ),
      ),
  }),
);

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
  it.effect("keeps non-Git projects scannable without failing Git worktree discovery", () =>
    Effect.gen(function* () {
      const scannedRoots: string[] = [];
      const collector = yield* makeRegisteredProjectProcessDiscovery().pipe(
        Effect.provide(
          Layer.mergeAll(
            registeredProjectsLayer,
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              listWorktreePaths: (cwd) =>
                cwd === "/ordinary-folder"
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "listWorktreePaths",
                        command: "git",
                        cwd,
                        detail: "not a git repository",
                      }),
                    )
                  : Effect.succeed(["/git-repo", "/git-worktree"]),
            }),
            Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
              read: (input) =>
                Effect.sync(() => {
                  scannedRoots.push(...(input.roots ?? []));
                  return diagnosticsSnapshot(4242);
                }),
            }),
          ),
        ),
      );

      const snapshot = yield* collector.read();

      expect(snapshot.error).toEqual(Option.none());
      expect(snapshot.processes[0]?.pid).toBe(4242);
      expect(scannedRoots).toEqual(["/ordinary-folder", "/git-repo", "/git-worktree"]);
      expect(snapshot.registeredProjectWorktrees).toEqual([
        { projectId: ProjectId.make("project-git"), path: "/git-repo" },
        { projectId: ProjectId.make("project-git"), path: "/git-worktree" },
      ]);
    }),
  );

  it.effect("propagates a Git worktree failure instead of reporting incomplete discovery", () =>
    Effect.gen(function* () {
      const error = new GitCommandError({
        operation: "listWorktreePaths",
        command: "git",
        cwd: "/git-repo",
        detail: "worktree discovery failed",
      });
      const collector = yield* makeRegisteredProjectProcessDiscovery().pipe(
        Effect.provide(
          Layer.mergeAll(
            registeredProjectsLayer,
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              listWorktreePaths: () => Effect.fail(error),
            }),
            Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
          ),
        ),
      );

      const result = yield* Effect.result(collector.read());

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe(error);
    }),
  );

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
