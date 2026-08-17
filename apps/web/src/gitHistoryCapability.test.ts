import { describe, expect, it } from "vite-plus/test";

import { hasGitHistoryCapability } from "./gitHistoryCapability";

describe("hasGitHistoryCapability", () => {
  it("requires the explicit gitHistory capability", () => {
    expect(hasGitHistoryCapability(undefined)).toBe(false);
    expect(hasGitHistoryCapability(null)).toBe(false);
    expect(hasGitHistoryCapability({})).toBe(false);
    expect(hasGitHistoryCapability({ gitHistory: false })).toBe(false);
    expect(hasGitHistoryCapability({ gitHistory: true })).toBe(true);
  });
});
