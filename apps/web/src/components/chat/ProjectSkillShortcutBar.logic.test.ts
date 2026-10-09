import { describe, expect, it } from "vite-plus/test";

import {
  addProjectSkillShortcut,
  normalizeProjectSkillShortcut,
  removeProjectSkillShortcut,
  reorderProjectSkillShortcuts,
  resolveProjectSkillShortcutActivation,
  resolveProjectSkillShortcutText,
  setProjectSkillShortcutColor,
  applyProjectSkillShortcutLocalChange,
  createProjectSkillShortcutSyncState,
  reconcileProjectSkillShortcutProjection,
  rejectProjectSkillShortcutLocalChange,
} from "./ProjectSkillShortcutBar.logic";

describe("project skill shortcut projection sync", () => {
  it("accepts readonly projections", () => {
    const shortcuts = ["$review"] as const;
    const state = createProjectSkillShortcutSyncState({ shortcuts, colors: {} });

    expect(state.current.shortcuts).toEqual(["$review"]);
  });

  it("keeps consecutive local replacements while stale acknowledgements arrive", () => {
    const labels = [
      "house-rules",
      "/work",
      "plan",
      "fix lint",
      "ship build",
      "work",
      "$work",
      "run tests",
      "long label",
    ];
    let state = createProjectSkillShortcutSyncState({ shortcuts: ["$review"], colors: {} });
    const localSnapshots = labels.map((label) => {
      const next = { shortcuts: [...state.current.shortcuts, label], colors: {} };
      state = applyProjectSkillShortcutLocalChange(state, next);
      return next;
    });

    state = reconcileProjectSkillShortcutProjection(state, { shortcuts: ["$review"], colors: {} });
    for (const projection of localSnapshots) {
      state = reconcileProjectSkillShortcutProjection(state, projection);
      expect(state.current.shortcuts).toEqual(["$review", ...labels]);
    }
    expect(state.pending).toEqual([]);
  });

  it("adopts an external projection once local replacements are acknowledged", () => {
    let state = createProjectSkillShortcutSyncState({ shortcuts: ["$review"], colors: {} });
    const local = { shortcuts: ["$review", "plan"], colors: {} };
    state = applyProjectSkillShortcutLocalChange(state, local);
    state = reconcileProjectSkillShortcutProjection(state, local);
    state = reconcileProjectSkillShortcutProjection(state, { shortcuts: ["external"], colors: {} });

    expect(state.current.shortcuts).toEqual(["external"]);
    expect(state.pending).toEqual([]);
  });
});

describe("quick slot actions", () => {
  it("adds trimmed text without empty or duplicate entries", () => {
    expect(normalizeProjectSkillShortcut("   ")).toBeNull();
    expect(addProjectSkillShortcut(["$review"], " $review ")).toEqual(["$review"]);
    expect(addProjectSkillShortcut(["$review"], " /deploy ")).toEqual(["$review", "/deploy"]);
    const longest = "x".repeat(255);
    expect(addProjectSkillShortcut([], longest)).toEqual([longest]);
  });

  it.each([
    ["/review", "codex", "$review"],
    ["$review", "claudeAgent", "/review"],
    ["/review", "cursor", "/review"],
    ["review this", "codex", "review this"],
    ["/", "codex", "/"],
    ["$", "claudeAgent", "$"],
  ])("resolves %s for %s", (shortcut, provider, expected) => {
    expect(resolveProjectSkillShortcutText(shortcut, provider)).toBe(expected);
  });

  it("inserts on Alt-click and sends on ordinary activation", () => {
    expect(resolveProjectSkillShortcutActivation(true)).toBe("insert");
    expect(resolveProjectSkillShortcutActivation(false)).toBe("send");
  });

  it("reorders and removes entries without changing its input", () => {
    const shortcuts = ["review", "deploy", "test"];
    expect(reorderProjectSkillShortcuts(shortcuts, "test", "review")).toEqual([
      "test",
      "review",
      "deploy",
    ]);
    expect(reorderProjectSkillShortcuts(shortcuts, "missing", "review")).toEqual(shortcuts);
    expect(removeProjectSkillShortcut(shortcuts, "deploy")).toEqual(["review", "test"]);
    expect(shortcuts).toEqual(["review", "deploy", "test"]);
  });

  it("changes and clears one shortcut color", () => {
    const colors = { review: "violet" } as const;
    expect(setProjectSkillShortcutColor(colors, "deploy", "green")).toEqual({
      review: "violet",
      deploy: "green",
    });
    expect(setProjectSkillShortcutColor(colors, "review", null)).toEqual({});
    expect(colors).toEqual({ review: "violet" });
  });
});
describe("failed quick slot saves", () => {
  it("restores the latest projection after a failed save", () => {
    const initial = { shortcuts: ["review"], colors: {} };
    const failed = { shortcuts: ["review", "deploy"], colors: {} };
    const state = applyProjectSkillShortcutLocalChange(
      createProjectSkillShortcutSyncState(initial),
      failed,
    );
    expect(rejectProjectSkillShortcutLocalChange(state, failed, initial)).toEqual({
      current: initial,
      pending: [],
    });
  });

  it("keeps later local changes when an earlier save fails", () => {
    const initial = { shortcuts: ["review"], colors: {} };
    const failed = { shortcuts: ["review", "deploy"], colors: {} };
    const later = { shortcuts: ["review", "deploy", "test"], colors: {} };
    let state = applyProjectSkillShortcutLocalChange(
      createProjectSkillShortcutSyncState(initial),
      failed,
    );
    state = applyProjectSkillShortcutLocalChange(state, later);
    expect(rejectProjectSkillShortcutLocalChange(state, failed, initial)).toEqual({
      current: later,
      pending: [later],
    });
  });
});
