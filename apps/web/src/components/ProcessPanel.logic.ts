import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { formatTestCommand, isTestCommand } from "@t3tools/shared/testCommand";

export { formatTestCommand, isTestCommand };
export type { TestCommandDisplay } from "@t3tools/shared/testCommand";

export interface ProcessPanelEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly childPids: readonly number[];
  readonly command: string;
  readonly argv?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly cpuPercent: number;
  readonly cpuTimeMs: number;
  readonly rssBytes: number;
  readonly elapsed: string;
}

export interface ProcessPanelProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly faviconPath?: string | null | undefined;
}

export interface ProcessPanelThread {
  readonly projectId: string;
  readonly worktreePath: string | null;
}

export interface ProcessPanelWorktree {
  readonly projectId: string;
  readonly path: string;
}

export interface ProcessPanelGroup {
  readonly project: ProcessPanelProject;
  readonly cwd: string;
  readonly worktreeLabel: string;
  readonly cpuPercent: number;
  readonly cpuTimeMs: number;
  readonly processes: readonly ProcessPanelEntry[];
}

interface Attribution {
  readonly project: ProcessPanelProject;
  readonly cwd: string;
  readonly worktreeLabel: string;
}

interface AttributionCandidate extends Attribution {
  readonly normalizedCwd: string;
}

export function processPanelStatus(input: {
  readonly environmentConnectionPhase: EnvironmentConnectionPhase;
  readonly hasData: boolean;
  readonly hasQueryError: boolean;
  readonly hasDataError: boolean;
}): {
  readonly label: "Live" | "Connecting" | "Unavailable";
  readonly tone: "live" | "muted" | "error";
} {
  if (
    input.environmentConnectionPhase === "available" ||
    input.environmentConnectionPhase === "offline" ||
    input.environmentConnectionPhase === "error"
  ) {
    return { label: "Unavailable", tone: "error" };
  }
  if (
    input.environmentConnectionPhase === "connecting" ||
    input.environmentConnectionPhase === "reconnecting"
  ) {
    return { label: "Connecting", tone: "muted" };
  }
  if (input.hasQueryError || input.hasDataError) return { label: "Unavailable", tone: "error" };
  if (!input.hasData) return { label: "Connecting", tone: "muted" };
  return { label: "Live", tone: "live" };
}

function isWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return isWindowsPath(path) ? normalized.toLowerCase() : normalized;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function attributionCandidates(
  projects: readonly ProcessPanelProject[],
  threads: readonly ProcessPanelThread[],
  worktrees: readonly ProcessPanelWorktree[],
): readonly AttributionCandidate[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const candidates: AttributionCandidate[] = projects.map((project) => ({
    project,
    cwd: project.workspaceRoot,
    worktreeLabel: basename(project.workspaceRoot),
    normalizedCwd: normalizePath(project.workspaceRoot),
  }));
  for (const thread of threads) {
    const project = projectById.get(thread.projectId);
    if (!project || !thread.worktreePath) continue;
    candidates.push({
      project,
      cwd: thread.worktreePath,
      worktreeLabel: basename(thread.worktreePath),
      normalizedCwd: normalizePath(thread.worktreePath),
    });
  }
  for (const worktree of worktrees) {
    const project = projectById.get(worktree.projectId);
    if (!project) continue;
    candidates.push({
      project,
      cwd: worktree.path,
      worktreeLabel: basename(worktree.path),
      normalizedCwd: normalizePath(worktree.path),
    });
  }
  return candidates.sort(
    (left, right) =>
      right.normalizedCwd.length - left.normalizedCwd.length ||
      left.normalizedCwd.localeCompare(right.normalizedCwd),
  );
}

function attributeProcess(
  cwd: string | undefined,
  candidates: readonly AttributionCandidate[],
): Attribution | null {
  if (!cwd) return null;
  const normalizedCwd = normalizePath(cwd);
  const match = candidates.find(
    (candidate) =>
      normalizedCwd === candidate.normalizedCwd ||
      normalizedCwd.startsWith(`${candidate.normalizedCwd}/`),
  );
  return match
    ? { project: match.project, cwd: match.cwd, worktreeLabel: match.worktreeLabel }
    : null;
}

function attributionKey(attribution: Attribution): string {
  return `${attribution.project.id}:${normalizePath(attribution.cwd)}`;
}

function hasAttributedAncestor(
  candidate: { readonly entry: ProcessPanelEntry; readonly attribution: Attribution },
  candidatesByPid: ReadonlyMap<
    number,
    { readonly entry: ProcessPanelEntry; readonly attribution: Attribution }
  >,
  processesByPid: ReadonlyMap<number, ProcessPanelEntry>,
): boolean {
  const visited = new Set<number>();
  let parentPid = candidate.entry.ppid;
  while (parentPid > 0 && !visited.has(parentPid)) {
    visited.add(parentPid);
    const parent = processesByPid.get(parentPid);
    if (!parent) return false;
    const parentCandidate = candidatesByPid.get(parentPid);
    if (
      parentCandidate &&
      attributionKey(parentCandidate.attribution) === attributionKey(candidate.attribution)
    ) {
      return true;
    }
    parentPid = parent.ppid;
  }
  return false;
}

export function deriveProcessPanelGroups(input: {
  readonly processes: readonly ProcessPanelEntry[];
  readonly projects: readonly ProcessPanelProject[];
  readonly threads: readonly ProcessPanelThread[];
  readonly worktrees?: readonly ProcessPanelWorktree[];
}): readonly ProcessPanelGroup[] {
  const processesByPid = new Map(input.processes.map((process) => [process.pid, process]));
  const candidatesByPath = attributionCandidates(
    input.projects,
    input.threads,
    input.worktrees ?? [],
  );
  const candidates = input.processes.flatMap((entry) => {
    if (!isTestCommand(entry.command, entry.argv)) return [];
    const attribution = attributeProcess(entry.cwd, candidatesByPath);
    return attribution ? [{ entry, attribution }] : [];
  });
  const candidatesByPid = new Map(candidates.map((candidate) => [candidate.entry.pid, candidate]));
  const groups = new Map<string, ProcessPanelGroup>();
  for (const candidate of candidates) {
    if (hasAttributedAncestor(candidate, candidatesByPid, processesByPid)) continue;
    const { entry: process, attribution } = candidate;
    const key = attributionKey(attribution);
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, {
        ...existing,
        cpuPercent: Math.min(100, existing.cpuPercent + process.cpuPercent),
        cpuTimeMs: existing.cpuTimeMs + process.cpuTimeMs,
        processes: [...existing.processes, process],
      });
    } else {
      groups.set(key, {
        ...attribution,
        cpuPercent: process.cpuPercent,
        cpuTimeMs: process.cpuTimeMs,
        processes: [process],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      processes: [...group.processes].sort(
        (left, right) => left.command.localeCompare(right.command) || left.pid - right.pid,
      ),
    }))
    .sort(
      (left, right) =>
        left.project.title.localeCompare(right.project.title) ||
        left.worktreeLabel.localeCompare(right.worktreeLabel) ||
        left.cwd.localeCompare(right.cwd),
    );
}
