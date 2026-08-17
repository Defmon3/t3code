import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorkspaceAdoption from "./WorkspaceAdoption.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-08-17T00:00:00.000Z";
const observedAt = DateTime.makeUnsafe(now);

const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeRepository = (rootPath: string, metadataPath: string): VcsRepositoryIdentity => ({
  kind: "git",
  rootPath,
  metadataPath,
  freshness: {
    source: "live-local",
    observedAt,
    expiresAt: Option.none(),
  },
});

const makeDriver = (branch: string): VcsDriver.VcsDriver["Service"] => ({
  capabilities: {
    kind: "git",
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native",
  },
  execute: vi.fn(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: `${branch}\n`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  ),
  detectRepository: () => Effect.die("unused"),
  isInsideWorkTree: () => Effect.die("unused"),
  listWorkspaceFiles: () => Effect.die("unused"),
  listRemotes: () => Effect.die("unused"),
  filterIgnoredPaths: () => Effect.die("unused"),
  initRepository: () => Effect.die("unused"),
});

const emptyAdoptionLayer = WorkspaceAdoption.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
      Layer.mock(OrchestrationEngineService)({}),
      Layer.mock(WorkspaceEntries)({}),
      Layer.mock(VcsStatusBroadcaster)({}),
      NodeServices.layer,
    ),
  ),
);

it.effect("adopts a same-repository linked worktree for the calling thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-adopt-" });
      const projectRoot = path.join(root, "project");
      const targetRoot = path.join(root, "worktree");
      const metadataRoot = path.join(root, "git-common");
      yield* fileSystem.makeDirectory(projectRoot);
      yield* fileSystem.makeDirectory(targetRoot);
      yield* fileSystem.makeDirectory(metadataRoot);

      const project = makeProject(projectRoot);
      const thread = makeThread();
      const driver = makeDriver("feat/named-worktree");
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
      const refreshEntries = vi.fn(() => Effect.void);
      const refreshStatus = vi.fn(() => Effect.die("refresh failure must not undo adoption"));

      const dependencies = Layer.mergeAll(
        WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.some(thread)),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [project],
              threads: [thread],
              updatedAt: now,
            }),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: ({ cwd }) =>
            Effect.succeed({
              kind: "git",
              repository: makeRepository(
                cwd === projectRoot ? projectRoot : targetRoot,
                metadataRoot,
              ),
              driver,
            }),
        }),
        Layer.mock(OrchestrationEngineService)({ dispatch }),
        Layer.mock(WorkspaceEntries)({ refresh: refreshEntries }),
        Layer.mock(VcsStatusBroadcaster)({ refreshStatus }),
        NodeServices.layer,
      );
      const adoptionLayer = WorkspaceAdoption.layer.pipe(Layer.provide(dependencies));
      const result = yield* Effect.gen(function* () {
        const adoption = yield* WorkspaceAdoption.WorkspaceAdoption;
        return yield* adoption.adopt({ threadId, path: `  ${targetRoot}  ` });
      }).pipe(Effect.provide(adoptionLayer));

      expect(result).toEqual({
        worktreePath: yield* fileSystem.realPath(targetRoot),
        branch: "feat/named-worktree",
        previousWorktreePath: null,
        providerRebind: "next-turn",
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId,
          branch: "feat/named-worktree",
          worktreePath: yield* fileSystem.realPath(targetRoot),
        }),
      );
      expect(refreshEntries).toHaveBeenCalledWith(yield* fileSystem.realPath(targetRoot));
      expect(refreshStatus).toHaveBeenCalledWith(yield* fileSystem.realPath(targetRoot));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("rejects a worktree from a different repository", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-reject-" });
      const projectRoot = path.join(root, "project");
      const targetRoot = path.join(root, "foreign-worktree");
      const projectMetadataRoot = path.join(root, "project-git");
      const targetMetadataRoot = path.join(root, "foreign-git");
      yield* fileSystem.makeDirectory(projectRoot);
      yield* fileSystem.makeDirectory(targetRoot);
      yield* fileSystem.makeDirectory(projectMetadataRoot);
      yield* fileSystem.makeDirectory(targetMetadataRoot);

      const project = makeProject(projectRoot);
      const thread = makeThread();
      const driver = makeDriver("feat/foreign");
      const dependencies = Layer.mergeAll(
        WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.some(thread)),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: ({ cwd }) =>
            Effect.succeed({
              kind: "git",
              repository: makeRepository(
                cwd === projectRoot ? projectRoot : targetRoot,
                cwd === projectRoot ? projectMetadataRoot : targetMetadataRoot,
              ),
              driver,
            }),
        }),
        Layer.mock(OrchestrationEngineService)({}),
        Layer.mock(WorkspaceEntries)({}),
        Layer.mock(VcsStatusBroadcaster)({}),
        NodeServices.layer,
      );
      const adoptionLayer = WorkspaceAdoption.layer.pipe(Layer.provide(dependencies));
      const error = yield* Effect.gen(function* () {
        const adoption = yield* WorkspaceAdoption.WorkspaceAdoption;
        return yield* adoption.adopt({ threadId, path: targetRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(adoptionLayer));

      expect(error.reason).toBe("different_repository");
      expect(driver.execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("rejects an empty workspace path before reading thread state", () =>
  Effect.gen(function* () {
    const adoption = yield* WorkspaceAdoption.WorkspaceAdoption;
    const error = yield* adoption.adopt({ threadId, path: "   " }).pipe(Effect.flip);
    expect(error.reason).toBe("path_invalid");
    expect(error.message).toBe("Workspace path must not be empty.");
  }).pipe(Effect.provide(emptyAdoptionLayer)),
);
