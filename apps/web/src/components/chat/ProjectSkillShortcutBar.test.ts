import { describe, expect, it } from "vite-plus/test";

import {
  addProjectSkillShortcut,
  normalizeProjectSkillShortcut,
  projectSkillShortcutBarClassName,
  removeProjectSkillShortcut,
  reorderProjectSkillShortcuts,
  resolveProjectSkillShortcutText,
} from "./ProjectSkillShortcutBar";

describe("project skill shortcuts", () => {
  it("defines the shortcut bar's horizontal-only, scrollbar-hidden layout contract", () => {
    expect(projectSkillShortcutBarClassName).toContain("overflow-x-auto");
    expect(projectSkillShortcutBarClassName).toContain("overflow-y-hidden");
    expect(projectSkillShortcutBarClassName).toContain("py-0.5");
    expect(projectSkillShortcutBarClassName).toContain("[-ms-overflow-style:none]");
    expect(projectSkillShortcutBarClassName).toContain("[scrollbar-width:none]");
    expect(projectSkillShortcutBarClassName).toContain("[&::-webkit-scrollbar]:hidden");
  });

  it("preserves quick-slot text and rejects empty or duplicate additions", () => {
    expect(normalizeProjectSkillShortcut("  $review  ")).toBe("$review");
    expect(normalizeProjectSkillShortcut(" /deploy")).toBe("/deploy");
    expect(normalizeProjectSkillShortcut(" plain text ")).toBe("plain text");
    expect(normalizeProjectSkillShortcut("  ")).toBeNull();
    expect(addProjectSkillShortcut(["$review"], " $review ")).toEqual(["$review"]);
    expect(addProjectSkillShortcut(["$review"], " plain text ")).toEqual(["$review", "plain text"]);
  });

  it("sends plain text as-is and normalizes marked commands for the provider", () => {
    expect(resolveProjectSkillShortcutText("review this", "codex")).toBe("review this");
    expect(resolveProjectSkillShortcutText("/review", "codex")).toBe("$review");
    expect(resolveProjectSkillShortcutText("$review", "claudeAgent")).toBe("/review");
    expect(resolveProjectSkillShortcutText("/review", "claudeAgent")).toBe("/review");
    expect(resolveProjectSkillShortcutText("$review", "codex")).toBe("$review");
    expect(resolveProjectSkillShortcutText("/review", "cursor")).toBe("/review");
    expect(resolveProjectSkillShortcutText("/", "codex")).toBe("/");
    expect(resolveProjectSkillShortcutText("$", "claudeAgent")).toBe("$");
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
