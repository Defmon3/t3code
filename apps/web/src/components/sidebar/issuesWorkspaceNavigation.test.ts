import { describe, expect, it } from "vite-plus/test";

import { issuesWorkspaceNavigation } from "./issuesWorkspaceNavigation";

describe("issuesWorkspaceNavigation", () => {
  it("opens the Issues workspace with its defaults", () => {
    expect(issuesWorkspaceNavigation()).toEqual({
      to: "/issues",
      search: { involvement: "all", state: "open" },
    });
  });
});
