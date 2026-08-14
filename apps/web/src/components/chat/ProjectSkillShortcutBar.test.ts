import { describe, expect, it } from "vite-plus/test";

import {
  addProjectSkillShortcut,
  normalizeProjectSkillShortcut,
  removeProjectSkillShortcut,
  reorderProjectSkillShortcuts,
} from "./ProjectSkillShortcutBar";

describe("project skill shortcuts", () => {
  it("normalizes leading invocation prefixes and rejects empty or duplicate additions", () => {
    expect(normalizeProjectSkillShortcut("  $review  ")).toBe("review");
    expect(normalizeProjectSkillShortcut(" /deploy")).toBe("deploy");
    expect(normalizeProjectSkillShortcut(" $/review")).toBe("review");
    expect(normalizeProjectSkillShortcut("  ")).toBeNull();
    expect(addProjectSkillShortcut(["review"], " $review ")).toEqual(["review"]);
    expect(addProjectSkillShortcut(["review"], " /deploy ")).toEqual(["review", "deploy"]);
  });

  it("removes and reorders shortcuts as full ordered replacements", () => {
    expect(removeProjectSkillShortcut(["review", "deploy", "test"], "deploy")).toEqual([
      "review",
      "test",
    ]);
    expect(reorderProjectSkillShortcuts(["review", "deploy", "test"], "test", "review")).toEqual([
      "test",
      "review",
      "deploy",
    ]);
  });

  it("keeps consecutive local changes in order before a project projection arrives", () => {
    const afterAdd = addProjectSkillShortcut(["review"], "deploy");
    const afterRemove = removeProjectSkillShortcut(afterAdd, "review");
    expect(reorderProjectSkillShortcuts([...afterRemove, "test"], "test", "deploy")).toEqual([
      "test",
      "deploy",
    ]);
  });
});
