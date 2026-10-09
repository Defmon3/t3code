import type { ProjectSkillShortcutColors, ProjectSkillShortcutColor } from "@t3tools/contracts";

export type ProjectSkillShortcutSnapshot = {
  shortcuts: string[];
  colors: ProjectSkillShortcutColors;
};

type ProjectSkillShortcutProjection = {
  readonly shortcuts: readonly string[];
  readonly colors: ProjectSkillShortcutColors;
};

export type ProjectSkillShortcutSyncState = {
  current: ProjectSkillShortcutSnapshot;
  pending: ProjectSkillShortcutSnapshot[];
};

function snapshotsEqual(
  left: ProjectSkillShortcutProjection,
  right: ProjectSkillShortcutProjection,
): boolean {
  const leftColors = Object.entries(left.colors);
  return (
    left.shortcuts.length === right.shortcuts.length &&
    left.shortcuts.every((shortcut, index) => shortcut === right.shortcuts[index]) &&
    leftColors.length === Object.keys(right.colors).length &&
    leftColors.every(([shortcut, color]) => right.colors[shortcut] === color)
  );
}

function snapshot(input: ProjectSkillShortcutProjection): ProjectSkillShortcutSnapshot {
  return { shortcuts: [...input.shortcuts], colors: { ...input.colors } };
}

export function createProjectSkillShortcutSyncState(
  projection: ProjectSkillShortcutProjection,
): ProjectSkillShortcutSyncState {
  return { current: snapshot(projection), pending: [] };
}

export function applyProjectSkillShortcutLocalChange(
  state: ProjectSkillShortcutSyncState,
  next: ProjectSkillShortcutSnapshot,
): ProjectSkillShortcutSyncState {
  const current = snapshot(next);
  return { current, pending: [...state.pending, current] };
}

export function reconcileProjectSkillShortcutProjection(
  state: ProjectSkillShortcutSyncState,
  projection: ProjectSkillShortcutProjection,
): ProjectSkillShortcutSyncState {
  const acknowledgedIndex = state.pending.findIndex((pending) =>
    snapshotsEqual(pending, projection),
  );
  if (acknowledgedIndex >= 0) {
    const pending = state.pending.slice(acknowledgedIndex + 1);
    return { current: pending.at(-1) ?? snapshot(projection), pending };
  }
  if (state.pending.length > 0) return state;

  const current = snapshot(projection);
  return snapshotsEqual(state.current, current) ? state : { current, pending: [] };
}

export function rejectProjectSkillShortcutLocalChange(
  state: ProjectSkillShortcutSyncState,
  failed: ProjectSkillShortcutSnapshot,
  projection: ProjectSkillShortcutProjection,
): ProjectSkillShortcutSyncState {
  const pending = state.pending.filter((entry) => !snapshotsEqual(entry, failed));
  return { current: pending.at(-1) ?? snapshot(projection), pending };
}

export function normalizeProjectSkillShortcut(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveProjectSkillShortcutText(shortcut: string, provider: string): string {
  const marker = shortcut[0];
  if ((marker !== "/" && marker !== "$") || shortcut.length === 1) return shortcut;
  if (provider === "claudeAgent") return `/${shortcut.slice(1)}`;
  if (provider === "codex") return `$${shortcut.slice(1)}`;
  return shortcut;
}

export function resolveProjectSkillShortcutActivation(altKey: boolean): "insert" | "send" {
  return altKey ? "insert" : "send";
}

export function addProjectSkillShortcut(shortcuts: readonly string[], value: string): string[] {
  const shortcut = normalizeProjectSkillShortcut(value);
  if (!shortcut || shortcuts.includes(shortcut)) return [...shortcuts];
  return [...shortcuts, shortcut];
}

export function removeProjectSkillShortcut(
  shortcuts: readonly string[],
  shortcut: string,
): string[] {
  return shortcuts.filter((entry) => entry !== shortcut);
}

export function setProjectSkillShortcutColor(
  colors: ProjectSkillShortcutColors,
  shortcut: string,
  color: ProjectSkillShortcutColor | null,
): ProjectSkillShortcutColors {
  const next = { ...colors };
  if (color === null) {
    delete next[shortcut];
  } else {
    next[shortcut] = color;
  }
  return next;
}

export function reorderProjectSkillShortcuts(
  shortcuts: readonly string[],
  active: string,
  over: string,
): string[] {
  const from = shortcuts.indexOf(active);
  const to = shortcuts.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...shortcuts];
  const next = [...shortcuts];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}
