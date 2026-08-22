import { describe, expect, it } from "vite-plus/test";

import {
  addProjectSkillShortcut,
  normalizeProjectSkillShortcut,
  projectSkillShortcutBarClassName,
  projectSkillShortcutButtonClassName,
  projectSkillShortcutEmptyBarClassName,
  removeProjectSkillShortcut,
  reorderProjectSkillShortcuts,
  resolveProjectSkillShortcutActivation,
  resolveProjectSkillShortcutText,
  setProjectSkillShortcutColor,
} from "./ProjectSkillShortcutBar";

describe("project skill shortcuts", () => {
  it("defines a wrapping shortcut layout without scrollbars", () => {
    expect(projectSkillShortcutBarClassName).toContain("flex-wrap");
    expect(projectSkillShortcutBarClassName).toContain("h-auto");
    expect(projectSkillShortcutBarClassName).toContain("min-h-9");
    expect(projectSkillShortcutBarClassName).toContain("overflow-visible");
    expect(projectSkillShortcutBarClassName).not.toContain("overflow-x-auto");
    expect(projectSkillShortcutBarClassName).not.toContain("overflow-hidden");
    expect(projectSkillShortcutBarClassName).not.toContain("scrollbar");
  });

  it("bounds labels and renders an intentional compact empty state", () => {
    expect(projectSkillShortcutButtonClassName).toContain("max-w-[min(100%,20rem)]");
    expect(projectSkillShortcutButtonClassName).toContain("truncate");
    expect(projectSkillShortcutEmptyBarClassName).toContain("inline-flex");
    expect(projectSkillShortcutEmptyBarClassName).not.toContain("w-full");
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

  it("inserts Alt-clicked shortcuts and sends ordinary clicks", () => {
    expect(resolveProjectSkillShortcutActivation(true)).toBe("insert");
    expect(resolveProjectSkillShortcutActivation(false)).toBe("send");
  });

  it("sets and clears preset colors without changing other buttons", () => {
    const colored = setProjectSkillShortcutColor({ review: "violet" }, "deploy", "green");
    expect(colored).toEqual({ review: "violet", deploy: "green" });
    expect(setProjectSkillShortcutColor(colored, "review", null)).toEqual({ deploy: "green" });
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
