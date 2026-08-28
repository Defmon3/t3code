import type { OrchestrationShellSnapshot, ProjectId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

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
  E,
  R,
>(input: {
  readonly loadTopology: () => Effect.Effect<ProcessDiscoveryTopology, E, R>;
  readonly loadWorktrees: () => Effect.Effect<ProcessDiscoveryWorktreeTopology, E, R>;
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

export function processDiscoveryRoots(
  snapshot: OrchestrationShellSnapshot,
  worktrees: ReadonlyArray<ProcessDiscoveryWorktree>,
  maxRoots: number,
): ReadonlyArray<string> {
  return mergeProcessDiscoveryRoots(
    [
      ...snapshot.projects.map((project) => project.workspaceRoot),
      ...snapshot.threads.flatMap((thread) =>
        thread.worktreePath === null ? [] : [thread.worktreePath],
      ),
    ],
    worktrees,
    maxRoots,
  );
}

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
