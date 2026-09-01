import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

export interface ProviderSkillsTarget {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly projectId: string | null;
  readonly threadId: string | undefined;
}

export interface CachedProviderSkills {
  readonly targetKey: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export function providerSkillsTargetKey(target: ProviderSkillsTarget): string {
  return `${target.environmentId}\u0000${target.instanceId}\u0000${target.projectId ?? ""}\u0000${target.threadId ?? ""}`;
}

export function selectProviderSkills(input: {
  readonly scopedSkills: ReadonlyArray<ServerProviderSkill> | undefined;
  readonly cachedSkills: CachedProviderSkills | null;
  readonly targetKey: string;
  readonly snapshotSkills: ReadonlyArray<ServerProviderSkill>;
}): ReadonlyArray<ServerProviderSkill> {
  if (input.scopedSkills !== undefined) {
    return input.scopedSkills;
  }
  if (input.cachedSkills?.targetKey === input.targetKey) {
    return input.cachedSkills.skills;
  }
  return input.snapshotSkills.filter((skill) => {
    const source = resolveProviderSkillSourceKind(skill);
    return source !== "project" && source !== "repo";
  });
}

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter((skill) => skill.enabled))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
