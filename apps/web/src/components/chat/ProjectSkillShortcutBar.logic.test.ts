import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectSkillShortcutLocalChange,
  createProjectSkillShortcutSyncState,
  reconcileProjectSkillShortcutProjection,
} from "./ProjectSkillShortcutBar.logic";

describe("project skill shortcut projection sync", () => {
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
