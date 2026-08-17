import { describe, expect, it } from "vite-plus/test";

import CustomGitHistoryPanel, { githubIssuesAvailability } from "./CustomGitHistoryPanel";

describe("CustomGitHistoryPanel", () => {
  it("is a separate custom tracker surface", () => {
    expect(CustomGitHistoryPanel.name).toBe("CustomGitHistoryPanel");
  });

  it("distinguishes checking, unavailable, and available tracker states", () => {
    expect(githubIssuesAvailability(false, false)).toBe("checking");
    expect(githubIssuesAvailability(false, true)).toBe("checking");
    expect(githubIssuesAvailability(true, false)).toBe("unavailable");
    expect(githubIssuesAvailability(true, true)).toBe("available");
  });
});
