import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  VcsGetCommitDetailsInput,
  VcsListHistoryRefsInput,
  VcsListHistoryRefsResult,
  VcsListRefsInput,
  VcsListRefsResult,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});

const decodeListRefsInput = Schema.decodeUnknownSync(VcsListRefsInput);

const decodeListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);

const decodeListHistoryRefsInput = Schema.decodeUnknownSync(VcsListHistoryRefsInput);
const decodeListHistoryRefsResult = Schema.decodeUnknownSync(VcsListHistoryRefsResult);

const decodeCommitDetailsInput = Schema.decodeUnknownSync(VcsGetCommitDetailsInput);

describe("VCS ref contracts", () => {
  it.each(["/repo/.git", null])("preserves the repository identity %s", (repositoryKey) => {
    const result = {
      refs: [],
      currentRef: null,
      isRepo: repositoryKey !== null,
      repositoryKey,
      hasPrimaryRemote: false,
      nextCursor: null,
      isComplete: true,
    };

    expect(decodeListHistoryRefsResult(result)).toEqual(result);
  });

  it("decodes History responses from older servers without a repository identity", () => {
    const result = {
      refs: [],
      currentRef: null,
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: null,
      isComplete: true,
    };

    expect(decodeListHistoryRefsResult(result)).toEqual({ ...result, repositoryKey: null });
  });

  it.each(["", "   ", 42])("rejects invalid repository identity %s", (repositoryKey) => {
    const result = {
      refs: [],
      currentRef: null,
      isRepo: true,
      repositoryKey,
      hasPrimaryRemote: false,
      nextCursor: null,
      isComplete: true,
    };

    expect(() => decodeListHistoryRefsResult(result)).toThrow();
  });

  it("preserves the numeric cursor and result shape of vcs.listRefs", () => {
    expect(decodeListRefsInput({ cwd: "/repo", cursor: 20, query: "release" })).toEqual({
      cwd: "/repo",
      cursor: 20,
      query: "release",
    });
    expect(
      decodeListRefsResult({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: 20,
        totalCount: 25,
      }).totalCount,
    ).toBe(25);
  });

  it("uses an opaque cursor only for vcs.listHistoryRefs", () => {
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
    expect(() => decodeListRefsInput({ cwd: "/repo", cursor: "opaque-cursor" })).toThrow();
  });
});

describe("Git commit hashes", () => {
  it("accepts SHA-1 and SHA-256 object hashes", () => {
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "a".repeat(40) }).hash).toHaveLength(40);
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "b".repeat(64) }).hash).toHaveLength(64);
  });
});
