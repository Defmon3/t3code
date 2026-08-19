import { CommandId, type ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

export const WorkspaceAdoptionFailureReason = Schema.Literals([
  "capability_unavailable",
  "thread_not_found",
  "project_not_found",
  "path_invalid",
  "not_git_worktree",
  "different_repository",
  "project_root",
  "detached_head",
  "worktree_in_use",
  "update_failed",
]);
export type WorkspaceAdoptionFailureReason = typeof WorkspaceAdoptionFailureReason.Type;

export class WorkspaceAdoptionError extends Schema.TaggedErrorClass<WorkspaceAdoptionError>()(
  "WorkspaceAdoptionError",
  {
    reason: WorkspaceAdoptionFailureReason,
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface WorkspaceAdoptionResult {
  readonly worktreePath: string;
  readonly branch: string;
  readonly previousWorktreePath: string | null;
  readonly providerRebind: "next-turn";
}

export class WorkspaceAdoption extends Context.Service<
  WorkspaceAdoption,
  {
    readonly adopt: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
    }) => Effect.Effect<WorkspaceAdoptionResult, WorkspaceAdoptionError>;
  }
>()("t3/mcp/WorkspaceAdoption") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const workspaceEntries = yield* WorkspaceEntries;
  const workspacePaths = yield* WorkspacePaths;

  const fail = (
    reason: WorkspaceAdoptionFailureReason,
    inputPath: string,
    detail: string,
  ): Effect.Effect<never, WorkspaceAdoptionError> =>
    Effect.fail(new WorkspaceAdoptionError({ reason, path: inputPath, detail }));

  const canonicalize = Effect.fn("WorkspaceAdoption.canonicalize")(function* (
    inputPath: string,
    requestedPath: string,
  ) {
    return yield* fileSystem.realPath(inputPath).pipe(
      Effect.map(path.normalize),
      Effect.mapError(
        () =>
          new WorkspaceAdoptionError({
            reason: "path_invalid",
            path: requestedPath,
            detail: `Could not resolve workspace path '${inputPath}'.`,
          }),
      ),
    );
  });

  const comparablePath = (value: string): string =>
    platform === "win32" ? value.toLowerCase() : value;

  const adopt: WorkspaceAdoption["Service"]["adopt"] = Effect.fn("WorkspaceAdoption.adopt")(
    function* (input) {
      const requestedPath = input.path.trim();
      if (requestedPath.length === 0) {
        return yield* fail("path_invalid", requestedPath, "Workspace path must not be empty.");
      }
      const thread = yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          () =>
            new WorkspaceAdoptionError({
              reason: "update_failed",
              path: requestedPath,
              detail: "T3 could not read the calling thread.",
            }),
        ),
      );
      if (!thread) {
        return yield* fail(
          "thread_not_found",
          requestedPath,
          "The MCP credential's thread no longer exists.",
        );
      }

      const project = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          () =>
            new WorkspaceAdoptionError({
              reason: "update_failed",
              path: requestedPath,
              detail: "T3 could not read the calling thread's project.",
            }),
        ),
      );
      if (!project) {
        return yield* fail(
          "project_not_found",
          requestedPath,
          "The calling thread's project no longer exists.",
        );
      }

      const normalizedInput = yield* workspacePaths.normalizeWorkspaceRoot(requestedPath).pipe(
        Effect.mapError(
          () =>
            new WorkspaceAdoptionError({
              reason: "path_invalid",
              path: requestedPath,
              detail: `Workspace path '${requestedPath}' is not an existing directory.`,
            }),
        ),
      );
      const [projectRepository, targetRepository] = yield* Effect.all(
        [
          registry.detect({ cwd: project.workspaceRoot, requestedKind: "git" }),
          registry.detect({ cwd: normalizedInput, requestedKind: "git" }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(
          () =>
            new WorkspaceAdoptionError({
              reason: "not_git_worktree",
              path: requestedPath,
              detail: `Could not inspect '${requestedPath}' as a Git worktree.`,
            }),
        ),
      );
      if (!projectRepository || projectRepository.kind !== "git") {
        return yield* fail(
          "not_git_worktree",
          requestedPath,
          "The calling thread's project is not a Git repository.",
        );
      }
      if (!targetRepository || targetRepository.kind !== "git") {
        return yield* fail(
          "not_git_worktree",
          requestedPath,
          `Workspace path '${requestedPath}' is not inside a Git worktree.`,
        );
      }

      const targetRoot = yield* canonicalize(targetRepository.repository.rootPath, requestedPath);
      const projectRoot = yield* canonicalize(projectRepository.repository.rootPath, requestedPath);
      const projectMetadataPath = projectRepository.repository.metadataPath;
      const targetMetadataPath = targetRepository.repository.metadataPath;
      if (!projectMetadataPath || !targetMetadataPath) {
        return yield* fail(
          "not_git_worktree",
          requestedPath,
          "T3 could not resolve Git worktree metadata for the requested path.",
        );
      }
      const [projectMetadata, targetMetadata] = yield* Effect.all(
        [
          canonicalize(
            path.isAbsolute(projectMetadataPath)
              ? projectMetadataPath
              : path.resolve(projectRoot, projectMetadataPath),
            requestedPath,
          ),
          canonicalize(
            path.isAbsolute(targetMetadataPath)
              ? targetMetadataPath
              : path.resolve(targetRoot, targetMetadataPath),
            requestedPath,
          ),
        ],
        { concurrency: 2 },
      );
      if (comparablePath(projectMetadata) !== comparablePath(targetMetadata)) {
        return yield* fail(
          "different_repository",
          requestedPath,
          `Workspace path '${targetRoot}' belongs to a different Git repository.`,
        );
      }
      if (comparablePath(projectRoot) === comparablePath(targetRoot)) {
        return yield* fail(
          "project_root",
          requestedPath,
          "The requested path is the project's primary working tree, not a linked worktree.",
        );
      }

      const branchResult = yield* targetRepository.driver
        .execute({
          operation: "WorkspaceAdoption.resolveBranch",
          cwd: targetRoot,
          args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.mapError(
            () =>
              new WorkspaceAdoptionError({
                reason: "not_git_worktree",
                path: requestedPath,
                detail: `Could not read the checked-out branch in '${targetRoot}'.`,
              }),
          ),
        );
      const branch = branchResult.stdout.trim();
      if (branchResult.exitCode !== 0 || branch.length === 0) {
        return yield* fail(
          "detached_head",
          requestedPath,
          "The requested worktree has a detached HEAD. Check out a branch before adopting it.",
        );
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new WorkspaceAdoptionError({
              reason: "update_failed",
              path: requestedPath,
              detail: "T3 could not check whether another thread owns this worktree.",
            }),
        ),
      );
      const targetComparison = comparablePath(targetRoot);
      const owningThread = shell.threads.find(
        (candidate) =>
          candidate.id !== thread.id &&
          candidate.worktreePath !== null &&
          comparablePath(path.normalize(candidate.worktreePath)) === targetComparison,
      );
      if (owningThread) {
        return yield* fail(
          "worktree_in_use",
          requestedPath,
          `Worktree '${targetRoot}' is already attached to thread '${owningThread.id}'.`,
        );
      }

      const previousWorktreePath = thread.worktreePath;
      if (
        previousWorktreePath !== null &&
        comparablePath(path.normalize(previousWorktreePath)) === targetComparison &&
        thread.branch === branch
      ) {
        return {
          worktreePath: targetRoot,
          branch,
          previousWorktreePath,
          providerRebind: "next-turn",
        };
      }

      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`mcp:workspace-adopt:${input.threadId}:${commandUuid}`),
          threadId: input.threadId,
          branch,
          worktreePath: targetRoot,
        })
        .pipe(
          Effect.mapError(
            () =>
              new WorkspaceAdoptionError({
                reason: "update_failed",
                path: requestedPath,
                detail: "T3 could not attach the calling thread to the requested worktree.",
              }),
          ),
        );

      yield* Effect.all(
        [workspaceEntries.refresh(targetRoot), vcsStatusBroadcaster.refreshStatus(targetRoot)],
        { concurrency: 2, discard: true },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace adoption refresh failed", {
            threadId: input.threadId,
            worktreePath: targetRoot,
            cause: Cause.pretty(cause),
          }),
        ),
      );

      return {
        worktreePath: targetRoot,
        branch,
        previousWorktreePath,
        providerRebind: "next-turn",
      };
    },
  );

  return WorkspaceAdoption.of({ adopt });
});

export const layer = Layer.effect(WorkspaceAdoption, make);
