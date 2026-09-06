import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const sourceFiles = [
  "../../routes/_chat.pull-requests.tsx",
  "../ChatView.tsx",
  "PullRequestDetailPanel.tsx",
  "PullRequestListEmptyState.tsx",
];

describe("pull request loading states", () => {
  it("uses shared modules after pull-request-local modules are removed", async () => {
    const sources = await Promise.all(
      sourceFiles.map((sourceFile) =>
        readFile(fileURLToPath(new URL(sourceFile, import.meta.url)), "utf8"),
      ),
    );

    for (const source of sources) {
      expect(source).not.toContain("PullRequestGhosts");
      expect(source).not.toContain("PullRequestActivityUnavailableState");
    }

    expect(sources.join("\n")).toContain("sourceControl/ListGhosts");
    expect(sources.join("\n")).toContain("sourceControl/ActivityUnavailableState");
  });
});
