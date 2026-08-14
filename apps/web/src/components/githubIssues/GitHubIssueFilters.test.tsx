import { describe, expect, it } from "vite-plus/test";

import { GitHubIssueFilters } from "./GitHubIssueFilters";

describe("GitHubIssueFilters", () => {
  it("provides the dedicated filter control component", () => {
    expect(GitHubIssueFilters).toBeTypeOf("function");
  });
});
