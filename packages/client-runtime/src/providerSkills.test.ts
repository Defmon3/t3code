import { describe, expect, it } from "vite-plus/test";

import {
  dedupeProviderSkillsByName,
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  providerSkillsTargetKey,
  resolveProviderSkillSourceKind,
  selectProviderSkills,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("dedupeProviderSkillsByName", () => {
  it("keeps the first resolved skill and preserves unrelated skill order", () => {
    const firstSkill = {
      name: "branch-audit",
      path: "/Users/matt/.codex/skills/branch-audit/SKILL.md",
      enabled: true,
    };
    const otherSkill = {
      name: "browser",
      path: "/Users/matt/.agents/skills/browser/SKILL.md",
      enabled: true,
    };
    const duplicateSkill = {
      name: "Branch-Audit",
      path: "/Users/matt/.agents/skills/branch-audit/SKILL.md",
      enabled: true,
    };

    expect(dedupeProviderSkillsByName([firstSkill, otherSkill, duplicateSkill])).toEqual([
      firstSkill,
      otherSkill,
    ]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("selectProviderSkills", () => {
  const userSkill = {
    name: "user",
    path: "/users/test/.codex/skills/user/SKILL.md",
    enabled: true,
    scope: "user",
  };
  const projectSkill = {
    name: "project",
    path: "/repo/.agents/skills/project/SKILL.md",
    enabled: true,
    scope: "project",
  };
  const repoSkill = {
    name: "repo",
    path: "/repo/.codex/skills/repo/SKILL.md",
    enabled: true,
    scope: "repo",
  };
  const workspaceSkill = {
    name: "workspace",
    path: "/repo/.claude/skills/workspace/SKILL.md",
    enabled: true,
    scope: "workspace",
  };

  it("uses only a cache entry for its exact environment, provider, project, and thread target", () => {
    const target = providerSkillsTargetKey({
      environmentId: "env-a",
      instanceId: "claude",
      projectId: "project-a",
      threadId: "thread-a",
    });
    const otherTarget = providerSkillsTargetKey({
      environmentId: "env-a",
      instanceId: "claude",
      projectId: "project-b",
      threadId: "thread-a",
    });
    expect(target).not.toBe(otherTarget);
    expect(
      selectProviderSkills({
        scopedSkills: undefined,
        cachedSkills: { targetKey: otherTarget, skills: [projectSkill] },
        targetKey: target,
        snapshotSkills: [userSkill],
      }),
    ).toEqual([userSkill]);
  });

  it("keeps a matching scoped cache while a refresh is pending", () => {
    const targetKey = providerSkillsTargetKey({
      environmentId: "env-a",
      instanceId: "claude",
      projectId: "project-a",
      threadId: undefined,
    });
    expect(
      selectProviderSkills({
        scopedSkills: undefined,
        cachedSkills: { targetKey, skills: [projectSkill] },
        targetKey,
        snapshotSkills: [userSkill],
      }),
    ).toEqual([projectSkill]);
  });

  it("does not leak project-scoped snapshot skills into an unscoped fallback", () => {
    const targetKey = providerSkillsTargetKey({
      environmentId: "env-a",
      instanceId: "codex",
      projectId: "project-a",
      threadId: undefined,
    });
    expect(
      selectProviderSkills({
        scopedSkills: undefined,
        cachedSkills: null,
        targetKey,
        snapshotSkills: [userSkill, projectSkill, repoSkill, workspaceSkill],
      }),
    ).toEqual([userSkill]);
  });
});
