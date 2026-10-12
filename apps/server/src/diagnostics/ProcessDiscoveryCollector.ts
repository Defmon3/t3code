import { RESOURCE_MONITOR_DISCOVERY_MAX_ROOTS, type ProjectId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const TOPOLOGY_CACHE_TTL = Duration.seconds(30);
const PROCESS_COLLECTION_CACHE_TTL = Duration.seconds(2);

export interface ProcessDiscoveryWorktree {
  readonly projectId: ProjectId;
  readonly path: string;
}

export interface ProcessDiscoveryTopology {
  readonly knownRoots: ReadonlyArray<string>;
}

export interface ProcessDiscoveryWorktreeTopology {
  readonly worktrees: ReadonlyArray<ProcessDiscoveryWorktree>;
}

export const makeProcessDiscoveryCollector = Effect.fn("makeProcessDiscoveryCollector")(function* <
  TopologyError,
  TopologyServices,
  WorktreeError,
  WorktreeServices,
>(input: {
  readonly loadTopology: () => Effect.Effect<
    ProcessDiscoveryTopology,
    TopologyError,
    TopologyServices
  >;
  readonly loadWorktrees: () => Effect.Effect<
    ProcessDiscoveryWorktreeTopology,
    WorktreeError,
    WorktreeServices
  >;
  readonly maxRoots: number;
  readonly processDiagnostics: Pick<ProcessDiagnostics.ProcessDiagnostics["Service"], "read">;
}) {
  const readWorktrees = yield* Effect.cachedWithTTL(input.loadWorktrees(), TOPOLOGY_CACHE_TTL);
  const readSnapshot = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const topology = yield* input.loadTopology();
      const worktreeTopology = yield* readWorktrees;
      const roots = mergeProcessDiscoveryRoots(
        topology.knownRoots,
        worktreeTopology.worktrees,
        input.maxRoots,
      );
      const diagnostics = yield* input.processDiagnostics.read(roots.length === 0 ? {} : { roots });
      return { ...diagnostics, registeredProjectWorktrees: worktreeTopology.worktrees };
    }),
    PROCESS_COLLECTION_CACHE_TTL,
  );
  return {
    read: () => readSnapshot,
  };
});

export const makeRegisteredProjectProcessDiscovery = Effect.fn(
  "makeRegisteredProjectProcessDiscovery",
)(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
  return yield* makeProcessDiscoveryCollector({
    loadTopology: () =>
      Effect.gen(function* () {
        const projectShells = yield* projects.listShells();
        const snapshot = yield* orchestrator.getShellSnapshot();
        return {
          knownRoots: [
            ...projectShells.map((project) => project.workspaceRoot),
            ...snapshot.threads.flatMap((thread) =>
              thread.worktreePath === null ? [] : [thread.worktreePath],
            ),
          ],
        };
      }),
    loadWorktrees: () =>
      Effect.gen(function* () {
        const projectShells = yield* projects.listShells();
        const worktrees = yield* Effect.forEach(
          projectShells,
          (project) =>
            Effect.gen(function* () {
              const repository = yield* vcsRegistry.detect({
                cwd: project.workspaceRoot,
                requestedKind: "git",
              });
              if (repository === null) return [];
              const paths = yield* git.listWorktreePaths(project.workspaceRoot);
              return paths.map((path) => ({ projectId: project.id, path }));
            }),
          { concurrency: 4 },
        );
        return { worktrees: worktrees.flat() };
      }),
    maxRoots: RESOURCE_MONITOR_DISCOVERY_MAX_ROOTS,
    processDiagnostics,
  });
});

export function mergeProcessDiscoveryRoots(
  knownRoots: ReadonlyArray<string>,
  worktrees: ReadonlyArray<ProcessDiscoveryWorktree>,
  maxRoots: number,
): ReadonlyArray<string> {
  return [...new Set([...knownRoots, ...worktrees.map((worktree) => worktree.path)])].slice(
    0,
    maxRoots,
  );
}
