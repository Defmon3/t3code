import { CommandId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  WorkspaceSetWorktreeFailure,
  type WorkspaceSetWorktreeInput,
  WorkspaceToolkit,
} from "./tools.ts";

const failure = (
  code: WorkspaceSetWorktreeFailure["code"],
  message: string,
): WorkspaceSetWorktreeFailure => new WorkspaceSetWorktreeFailure({ code, message });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const operationFailed = (operation: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${operation}: ${errorMessage(error)}`),
  );

const normalizedPathEquals = (left: string, right: string): boolean =>
  normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);

export const setCallingThreadWorktree = Effect.fn("WorkspaceToolkit.setCallingThreadWorktree")(
  function* (input: WorkspaceSetWorktreeInput) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("workspace")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant workspace capabilities.",
      );
    }

    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const thread = yield* snapshotQuery.getThreadShellById(scope.threadId).pipe(
      operationFailed("Unable to read the calling thread"),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("thread_not_found", `Thread '${scope.threadId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (thread.archivedAt !== null) {
      return yield* failure(
        "thread_not_found",
        `Thread '${scope.threadId}' is archived and cannot change workspaces.`,
      );
    }

    const project = yield* snapshotQuery.getProjectShellById(thread.projectId).pipe(
      operationFailed("Unable to read the calling thread's project"),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${thread.projectId}' was not found for thread '${scope.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const canonicalProjectRoot = yield* fileSystem
      .realPath(project.workspaceRoot)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "operation_failed",
            `Unable to resolve project workspace '${project.workspaceRoot}': ${errorMessage(error)}`,
          ),
        ),
      );
    const projectRepository = yield* vcsRegistry
      .resolve({ cwd: canonicalProjectRoot, requestedKind: "git" })
      .pipe(operationFailed("Unable to resolve the project Git repository"));

    const resolveCommonDirectory = Effect.fn("WorkspaceToolkit.resolveCommonDirectory")(function* (
      repository: typeof projectRepository.repository,
    ) {
      if (repository.metadataPath === null) {
        return yield* failure(
          "operation_failed",
          `Git repository '${repository.rootPath}' did not report a common metadata directory.`,
        );
      }
      return yield* fileSystem
        .realPath(path.resolve(repository.rootPath, repository.metadataPath))
        .pipe(operationFailed("Unable to resolve the Git common directory"));
    });
    const projectCommonDirectory = yield* resolveCommonDirectory(projectRepository.repository);

    let targetRoot = canonicalProjectRoot;
    let worktreePath: string | null = null;
    let targetRepository = projectRepository;
    if (input.path !== null) {
      if (!path.isAbsolute(input.path)) {
        return yield* failure(
          "invalid_path",
          `Worktree path must be absolute, got '${input.path}'.`,
        );
      }
      targetRoot = yield* fileSystem
        .realPath(input.path)
        .pipe(
          Effect.mapError((error) =>
            failure(
              "invalid_path",
              `Worktree path '${input.path}' does not resolve to an existing directory: ${errorMessage(error)}`,
            ),
          ),
        );
      targetRepository = yield* vcsRegistry
        .resolve({ cwd: targetRoot, requestedKind: "git" })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "invalid_path",
              `Worktree path '${input.path}' is not a Git worktree: ${errorMessage(error)}`,
            ),
          ),
        );
      const canonicalDetectedRoot = yield* fileSystem
        .realPath(targetRepository.repository.rootPath)
        .pipe(operationFailed("Unable to resolve the detected worktree root"));
      if (!normalizedPathEquals(targetRoot, canonicalDetectedRoot)) {
        return yield* failure(
          "not_a_worktree_root",
          `Path '${input.path}' is inside worktree '${canonicalDetectedRoot}', but is not its root.`,
        );
      }
      if (normalizedPathEquals(targetRoot, canonicalProjectRoot)) {
        return yield* failure(
          "invalid_path",
          "Pass null to return the thread to its project checkout.",
        );
      }
      const targetCommonDirectory = yield* resolveCommonDirectory(targetRepository.repository);
      if (!normalizedPathEquals(projectCommonDirectory, targetCommonDirectory)) {
        return yield* failure(
          "different_repository",
          `Worktree '${targetRoot}' does not belong to the thread project's Git repository.`,
        );
      }
      worktreePath = targetRoot;
    }

    const symbolicRef = yield* targetRepository.driver
      .execute({
        operation: "WorkspaceToolkit.readBranch",
        cwd: targetRoot,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      })
      .pipe(operationFailed("Unable to read the selected workspace branch"));
    const branch = symbolicRef.exitCode === 0 ? symbolicRef.stdout.trim() || null : null;
    const currentWorktreeMatches =
      thread.worktreePath === null
        ? worktreePath === null
        : worktreePath !== null && normalizedPathEquals(thread.worktreePath, worktreePath);
    const changed = !currentWorktreeMatches || thread.branch !== branch;

    if (changed) {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `mcp:workspace-set-worktree:${encodeURIComponent(scope.providerSessionId)}:${uuid}`,
          ),
          threadId: scope.threadId,
          expectedBranch: thread.branch,
          branch,
          worktreePath,
        })
        .pipe(operationFailed("Unable to update the thread workspace"));
    }

    return {
      effectiveWorkspaceRoot: targetRoot,
      worktreePath,
      branch,
      providerWorkspaceApplies: "next-turn" as const,
      changed,
    };
  },
);

const handlers = {
  workspace_set_worktree: setCallingThreadWorktree,
} satisfies Parameters<typeof WorkspaceToolkit.toLayer>[0];

export const WorkspaceToolkitHandlersLive = WorkspaceToolkit.toLayer(handlers);
