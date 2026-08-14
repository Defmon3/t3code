import { WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createGitHubIssuesEnvironmentAtoms } from "./githubIssues.ts";

describe("GitHub issues environment atoms", () => {
  it("uses the dedicated list and invalidate RPC methods", () => {
    expect(WS_METHODS.githubIssuesList).toBe("githubIssues.list");
    expect(WS_METHODS.githubIssuesInvalidate).toBe("githubIssues.invalidate");
    expect(createGitHubIssuesEnvironmentAtoms).toBeTypeOf("function");
  });
});
