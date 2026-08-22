import type { ProjectSkillShortcutColors } from "@t3tools/contracts";

export type ProjectSkillShortcutSnapshot = {
  shortcuts: string[];
  colors: ProjectSkillShortcutColors;
};

export type ProjectSkillShortcutSyncState = {
  current: ProjectSkillShortcutSnapshot;
  pending: ProjectSkillShortcutSnapshot[];
};

function snapshotsEqual(
  left: ProjectSkillShortcutSnapshot,
  right: ProjectSkillShortcutSnapshot,
): boolean {
  const leftColors = Object.entries(left.colors);
  return (
    left.shortcuts.length === right.shortcuts.length &&
    left.shortcuts.every((shortcut, index) => shortcut === right.shortcuts[index]) &&
    leftColors.length === Object.keys(right.colors).length &&
    leftColors.every(([shortcut, color]) => right.colors[shortcut] === color)
  );
}

function snapshot(input: ProjectSkillShortcutSnapshot): ProjectSkillShortcutSnapshot {
  return { shortcuts: [...input.shortcuts], colors: { ...input.colors } };
}

export function createProjectSkillShortcutSyncState(
  projection: ProjectSkillShortcutSnapshot,
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
  projection: ProjectSkillShortcutSnapshot,
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
