import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkspaceAdoption from "../../WorkspaceAdoption.ts";
import { WorkspaceToolkit } from "./tools.ts";

const handlers = {
  workspace_adopt: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (!invocation.capabilities.has("workspace")) {
        return yield* new WorkspaceAdoption.WorkspaceAdoptionError({
          reason: "capability_unavailable",
          path: input.path,
          detail: "MCP credential does not grant the workspace capability.",
        });
      }
      const adoption = yield* WorkspaceAdoption.WorkspaceAdoption;
      return yield* adoption.adopt({ threadId: invocation.threadId, path: input.path });
    }),
} satisfies Parameters<typeof WorkspaceToolkit.toLayer>[0];

export const WorkspaceToolkitHandlersLive = WorkspaceToolkit.toLayer(handlers);
