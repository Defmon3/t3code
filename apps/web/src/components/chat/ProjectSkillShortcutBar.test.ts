// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  addProjectSkillShortcut,
  normalizeProjectSkillShortcut,
  ProjectSkillShortcutBar,
  projectSkillShortcutBarClassName,
  projectSkillShortcutButtonClassName,
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

  it("bounds labels and keeps the empty state on the full-width bar geometry", () => {
    expect(projectSkillShortcutButtonClassName).toContain("max-w-[min(100%,20rem)]");
    expect(projectSkillShortcutButtonClassName).toContain("truncate");
    expect(projectSkillShortcutBarClassName).toContain("w-full");
    expect(projectSkillShortcutBarClassName).toContain("rounded-t-[19px]");
  });

  it("renders an icon-only accessible add control on the full-width empty bar", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectSkillShortcutBar, {
        shortcuts: [],
        colors: {},
        onChange: () => {},
        onInvoke: () => {},
        onInsert: () => {},
      }),
    );

    expect(markup).toContain(projectSkillShortcutBarClassName);
    expect(markup).toContain('class="flex size-7 shrink-0');
    expect(markup).toContain('aria-label="Add quick slot"');
    expect(markup).not.toContain(">Add quick slot<");
  });

  it("renders inside the composer surface so attached widgets remain above it", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectSkillShortcutBar, {
        shortcuts: [],
        colors: {},
        onChange: () => {},
        onInvoke: () => {},
        onInsert: () => {},
      }),
    );
    const composerSource = NodeFS.readFileSync(
      new URL("./ChatComposer.tsx", import.meta.url),
      "utf8",
    );
    const indexCssSource = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    const renderStart = composerSource.lastIndexOf("// Render");
    const formStart = composerSource.indexOf('data-chat-composer-form="true"', renderStart);
    const topDrawerStart = composerSource.indexOf(
      'data-chat-composer-top-drawer="true"',
      formStart,
    );
    const tasksDrawerStart = composerSource.indexOf("<ComposerTasksDrawer", formStart);
    const mainSurfaceStart = composerSource.indexOf(
      'data-chat-composer-main-surface="true"',
      formStart,
    );
    const surfaceStart = composerSource.indexOf(
      'data-chat-composer-surface="true"',
      mainSurfaceStart,
    );
    const slotStart = composerSource.indexOf(
      'data-chat-composer-surface-top-slot="true"',
      surfaceStart,
    );
    const promptRowStart = composerSource.indexOf("{showCollapsedMobilePromptRow ?", surfaceStart);

    expect(markup).toContain('data-project-skill-shortcut-bar="true"');
    expect(renderStart).toBeGreaterThan(-1);
    expect(topDrawerStart).toBeGreaterThan(formStart);
    expect(tasksDrawerStart).toBeGreaterThan(topDrawerStart);
    expect(mainSurfaceStart).toBeGreaterThan(tasksDrawerStart);
    expect(surfaceStart).toBeGreaterThan(mainSurfaceStart);
    expect(slotStart).toBeGreaterThan(surfaceStart);
    expect(promptRowStart).toBeGreaterThan(slotStart);
    expect(indexCssSource).toContain(
      '[data-chat-composer-form="true"]:has(.chat-composer-top-drawer)',
    );
    expect(indexCssSource).toContain('[data-chat-composer-surface-top-slot="true"]');
    expect(indexCssSource).toContain("padding-top: var(--chat-composer-attachment-overlap)");
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
