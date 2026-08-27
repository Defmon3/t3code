import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsGetCommitDetailsInput,
  VcsListHistoryRefsInput,
  VcsListRefsInput,
  VcsListRefsResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeListRefsInput = Schema.decodeUnknownSync(VcsListRefsInput);
const decodeListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);
const decodeListHistoryRefsInput = Schema.decodeUnknownSync(VcsListHistoryRefsInput);
const decodeCommitDetailsInput = Schema.decodeUnknownSync(VcsGetCommitDetailsInput);

describe("VCS ref contracts", () => {
  it("uses an opaque cursor and snapshot result shape for vcs.listRefs", () => {
    expect(
      decodeListRefsInput({ cwd: "/repo", cursor: "opaque-cursor", prefix: "release" }),
    ).toEqual({
      cwd: "/repo",
      cursor: "opaque-cursor",
      prefix: "release",
    });
    const result = decodeListRefsResult({
      refs: [
        {
          name: "v1.0.0",
          current: false,
          isDefault: false,
          isTag: true,
          worktreePath: null,
          aheadCount: 2,
          behindCount: 3,
        },
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: "next-cursor",
      currentRef: null,
      isComplete: true,
    });
    expect(result.nextCursor).toBe("next-cursor");
    expect(result.refs[0]).toMatchObject({ isTag: true, aheadCount: 2, behindCount: 3 });
    expect(result.refs[1]?.isTag).toBeUndefined();
    expect(result.refs[1]?.aheadCount).toBeUndefined();
    expect(result.refs[1]?.behindCount).toBeUndefined();
    expect(() => decodeListRefsInput({ cwd: "/repo", cursor: 20 })).toThrow();
    expect(() =>
      decodeListRefsResult({
        refs: [
          {
            name: "main",
            current: true,
            isDefault: true,
            worktreePath: null,
            aheadCount: -1,
          },
        ],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        currentRef: null,
        isComplete: true,
      }),
    ).toThrow();
  });
});

describe("VCS history ref contracts", () => {
  it("accepts the opaque cursor and text query used by Git History", () => {
    expect(
      decodeListHistoryRefsInput({
        cwd: "/repo",
        cursor: "opaque-cursor",
        query: "Release",
        namespace: "tag",
      }),
    ).toEqual({
      cwd: "/repo",
      cursor: "opaque-cursor",
      query: "Release",
      namespace: "tag",
    });
  });
});

describe("Git commit hashes", () => {
  it("accepts SHA-1 and SHA-256 object hashes", () => {
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "a".repeat(40) }).hash).toHaveLength(40);
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "b".repeat(64) }).hash).toHaveLength(64);
  });
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
