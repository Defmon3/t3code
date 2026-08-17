import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkspaceAdoption from "../../WorkspaceAdoption.ts";

export const WorkspaceAdoptInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to an existing linked Git worktree for this thread's project.",
  }),
});

export const WorkspaceAdoptResult = Schema.Struct({
  worktreePath: Schema.String,
  branch: Schema.String,
  previousWorktreePath: Schema.NullOr(Schema.String),
  providerRebind: Schema.Literal("next-turn"),
});

export const WorkspaceAdoptTool = Tool.make("workspace_adopt", {
  description:
    "Attach the current T3 thread to an existing linked Git worktree created by the agent. Call this immediately after creating the worktree and before editing files there. T3 validates that it belongs to the same repository and updates the thread workspace used by file links, file browsing, and Git requests. The provider starts its next turn in that worktree. After success, use worktreePath as the working directory for every remaining command in the current turn.",
  parameters: WorkspaceAdoptInput,
  success: WorkspaceAdoptResult,
  failure: WorkspaceAdoption.WorkspaceAdoptionError,
  dependencies: [McpInvocationContext.McpInvocationContext, WorkspaceAdoption.WorkspaceAdoption],
})
  .annotate(Tool.Title, "Adopt Git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorkspaceToolkit = Toolkit.make(WorkspaceAdoptTool);
