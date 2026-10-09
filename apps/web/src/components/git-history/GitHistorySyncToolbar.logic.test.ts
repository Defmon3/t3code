import { describe, expect, it } from "vite-plus/test";

import {
  gitHistorySolvePrompt,
  isGitHistorySolveOffer,
  resolveGitHistorySyncActions,
  selectedHistoryRef,
} from "./GitHistorySyncToolbar.logic";

describe("resolveGitHistorySyncActions", () => {
  it("enables safe operations for the selected local branch", () => {
    expect(
      resolveGitHistorySyncActions({
        name: "feature",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/feature",
        aheadCount: 2,
        behindCount: 1,
      }),
    ).toMatchObject([
      { action: "fetch", disabled: false },
      { action: "pull", disabled: false, count: 1 },
      { action: "push", disabled: false, count: 2 },
    ]);
  });

  it("keeps pull and push disabled for tags and remote refs", () => {
    expect(
      resolveGitHistorySyncActions({
        name: "v1",
        current: false,
        isDefault: false,
        worktreePath: null,
        isTag: true,
      }),
    ).toMatchObject([
      { action: "fetch", disabled: true },
      { action: "pull", disabled: true },
      { action: "push", disabled: true },
    ]);
  });
});

describe("Git History solve handoff", () => {
  it("offers Solve only for divergence-style failures and builds a sanitized prompt", () => {
    expect(isGitHistorySolveOffer("Cannot fast-forward feature; it has diverged.")).toBe(true);
    expect(isGitHistorySolveOffer("Authentication failed")).toBe(false);
    expect(isGitHistorySolveOffer("Permission denied by remote")).toBe(false);
    expect(isGitHistorySolveOffer("Network is unreachable")).toBe(false);
    expect(
      gitHistorySolvePrompt({
        cwd: "C:/repo",
        action: "pull",
        refName: "feature",
        upstreamName: "origin/feature",
        error: "failed\nwith details",
      }),
    ).toContain("error: failed with details");
  });
});

describe("selectedHistoryRef", () => {
  it("resolves the selected ref from its full revision", () => {
    const ref = { name: "feature", current: false, isDefault: false, worktreePath: null };
    expect(selectedHistoryRef({ revision: "refs/heads/feature" }, [ref])).toBe(ref);
  });
});
