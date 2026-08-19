import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { WorkspaceToolkit } from "./tools.ts";

it("exports the workspace adoption tool as a provider-compatible object schema", () => {
  const tool = WorkspaceToolkit.tools.workspace_adopt;
  const schema = Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(tool.description?.length ?? 0).toBeGreaterThan(80);
  expect(schema.type).toBe("object");
  expect(schema.properties?.path).toBeDefined();
  expect(schema.required).toContain("path");
});
