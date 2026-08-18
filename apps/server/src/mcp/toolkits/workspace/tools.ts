import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";

export const WorkspaceSetWorktreeInput = Schema.Struct({
  path: Schema.NullOr(
    TrimmedNonEmptyString.annotate({
      description:
        "Absolute path to an existing linked Git worktree, or null to return the thread to its project checkout.",
    }),
  ),
});
export type WorkspaceSetWorktreeInput = typeof WorkspaceSetWorktreeInput.Type;

export const WorkspaceSetWorktreeResult = Schema.Struct({
  effectiveWorkspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  providerWorkspaceApplies: Schema.Literal("next-turn"),
  changed: Schema.Boolean,
});
export type WorkspaceSetWorktreeResult = typeof WorkspaceSetWorktreeResult.Type;

export class WorkspaceSetWorktreeFailure extends Schema.TaggedErrorClass<WorkspaceSetWorktreeFailure>()(
  "WorkspaceSetWorktreeFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "invalid_path",
      "not_a_worktree_root",
      "different_repository",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  VcsDriverRegistry.VcsDriverRegistry,
  Crypto.Crypto,
  FileSystem.FileSystem,
  Path.Path,
];

export const WorkspaceSetWorktreeTool = Tool.make("workspace_set_worktree", {
  description:
    "Point this T3 thread at an existing linked Git worktree. The path must be an absolute worktree root in the same Git repository as the thread's project. Pass null to return to the project checkout. This changes T3's persisted workspace and UX/file-link roots without creating, renaming, switching, or deleting Git branches or worktrees. The provider starts in the selected workspace on the next turn; the current turn keeps its original working directory.",
  parameters: WorkspaceSetWorktreeInput,
  success: WorkspaceSetWorktreeResult,
  failure: WorkspaceSetWorktreeFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Set thread worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorkspaceToolkit = Toolkit.make(WorkspaceSetWorktreeTool);
