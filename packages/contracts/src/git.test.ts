import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitCommitDetails,
  GitHistoryCommit,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsCreateWorktreeInput,
  VcsGetCommitDetailsInput,
  VcsGetHistoryInput,
  VcsHistoryRef,
  VcsHistorySyncInput,
  VcsHistorySyncResult,
  VcsListHistoryRefsInput,
  VcsListHistoryRefsResult,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRef,
} from "./git.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";
import { WorktreeMcpHandoffInput } from "./worktreeMcp.ts";

const encodeVcsRef = Schema.encodeUnknownSync(VcsRef);
const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const encodeCreateWorktreeInput = Schema.encodeUnknownSync(VcsCreateWorktreeInput);
const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodeWorktreeHandoffInput = Schema.decodeUnknownSync(WorktreeMcpHandoffInput);
const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const encodeRunStackedActionInput = Schema.encodeUnknownSync(GitRunStackedActionInput);
const decodeReviewDiffFileContentsInput = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);
const encodeReviewDiffFileContentsInput = Schema.encodeUnknownSync(ReviewDiffFileContentsInput);
const decodePullRequestDiffFileContentsInput = Schema.decodeUnknownSync(
  PullRequestDiffFileContentsInput,
);
const encodePullRequestDiffFileContentsInput = Schema.encodeUnknownSync(
  PullRequestDiffFileContentsInput,
);
const encodeVcsHistoryRef = Schema.encodeSync(VcsHistoryRef);
const decodeVcsHistoryRef = Schema.decodeUnknownSync(VcsHistoryRef);
const decodeVcsHistorySyncInput = Schema.decodeUnknownSync(VcsHistorySyncInput);
const decodeVcsHistorySyncResult = Schema.decodeUnknownSync(VcsHistorySyncResult);
const decodeVcsGetHistoryInput = Schema.decodeUnknownSync(VcsGetHistoryInput);
const decodeGitHistoryCommit = Schema.decodeUnknownSync(GitHistoryCommit);
const decodeGitCommitDetails = Schema.decodeUnknownSync(GitCommitDetails);

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

describe("Git file paths", () => {
  it.each([
    {
      operation: "commit",
      decode: decodeRunStackedActionInput,
      encode: encodeRunStackedActionInput,
      input: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [" leading.txt", "trailing.txt "],
      },
    },
    {
      operation: "local diff expansion",
      decode: decodeReviewDiffFileContentsInput,
      encode: encodeReviewDiffFileContentsInput,
      input: {
        cwd: "/repo",
        sourceKind: "working-tree",
        changeType: "rename-changed",
        baseRef: "HEAD",
        headRef: null,
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
    {
      operation: "pull request diff expansion",
      decode: decodePullRequestDiffFileContentsInput,
      encode: encodePullRequestDiffFileContentsInput,
      input: {
        projectId: "project-1",
        repository: "owner/repo",
        number: 1,
        changeType: "rename-changed",
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
  ])("preserves leading and trailing whitespace for $operation", ({ decode, encode, input }) => {
    expect(decode(input)).toEqual(input);
    expect(encode(input)).toEqual(input);
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

describe("Git ref names", () => {
  const namesWithUnicodeWhitespace = ["origin/release/v2\u3000", "\u00a0release", "\u3000"];

  it.each(namesWithUnicodeWhitespace)(
    "keeps Unicode whitespace at the edges of %j across the wire",
    (name) => {
      const ref = { name, upstreamRef: `refs/remotes/${name}`, current: false, isDefault: false };
      const wireRef = encodeVcsRef({ ...ref, worktreePath: null });
      expect(decodeVcsRef(wireRef)).toMatchObject(ref);

      const input = { cwd: "/repo", refName: name, newRefName: name, baseRefName: name };
      const wireInput = encodeCreateWorktreeInput({ ...input, path: null });
      expect(decodeCreateWorktreeInput(wireInput)).toMatchObject(input);

      const handoff = { branch: name, baseRef: name, startFromOrigin: true };
      expect(decodeWorktreeHandoffInput(handoff)).toEqual(handoff);
    },
  );

  it.each(namesWithUnicodeWhitespace)(
    "preserves %j in history queries, refs, and commit labels",
    (name) => {
      const historyRef = {
        name,
        remoteName: name,
        upstreamName: `origin/${name}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      };
      const sync = { action: "fetch", refName: name };
      const query = { cwd: "/repo", revision: `refs/heads/${name}` };
      const commit = {
        hash: "a".repeat(40),
        parentHashes: [],
        subject: "Initial commit",
        authorName: "Author",
        authorEmail: "author@example.com",
        authoredAt: "2026-04-20T00:00:00.000Z",
        refs: [`HEAD -> ${name}`, name],
      };

      expect(decodeVcsHistoryRef(encodeVcsHistoryRef(historyRef))).toEqual(historyRef);
      expect(decodeVcsHistorySyncInput({ ...sync, cwd: "/repo", namespace: "local" }).refName).toBe(
        name,
      );
      expect(decodeVcsHistorySyncResult(sync)).toEqual(sync);
      expect(decodeVcsGetHistoryInput(query)).toEqual(query);
      expect(decodeGitHistoryCommit(commit).refs).toEqual(commit.refs);
      expect(decodeGitCommitDetails({ ...commit, body: "" }).refs).toEqual(commit.refs);
    },
  );

  it("still trims ASCII whitespace and rejects a blank name", () => {
    expect(
      decodeCreateWorktreeInput({ cwd: "/repo", refName: " \tmain\n", path: null }).refName,
    ).toBe("main");
    expect(() => decodeCreateWorktreeInput({ cwd: "/repo", refName: " \t", path: null })).toThrow();
  });
});
