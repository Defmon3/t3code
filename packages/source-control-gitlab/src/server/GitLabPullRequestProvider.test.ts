import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueLink } from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
      updateMethods: ["rebase"],
    });
  });

  it("keeps merge, now and later, from a viewer GitLab says cannot", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
    });
  });
});

describe("getChangeRequest base freshness", () => {
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  const readWith = (divergence: { readonly divergedCommits?: number }) =>
    Effect.gen(function* () {
      const provider = yield* make;
      return yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          getMergeRequestDetail: () => Effect.succeed({ ...detail, ...divergence }),
          getProjectMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: true }),
          listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
        }),
      ),
    );

  it.effect("reads a counted divergence as a branch that has fallen behind", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 3 });

      expect(changeRequest.baseComparison).toBe("behind");
      expect(changeRequest.behindBy).toBe(3);
    }),
  );

  it.effect("says nothing at all where GitLab counted nothing", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({});

      expect(changeRequest.baseComparison).toBe("unknown");
      expect(changeRequest.behindBy).toBeUndefined();
    }),
  );
});

describe("getChangeRequest linked issues", () => {
  const issue = (number: number, closesIssue: boolean): IssueLink => ({
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://gitlab.com/acme/web/-/issues/${number}`,
    state: "open",
    closesIssue,
  });

  const detailWith = (body: string) => ({
    number: 7,
    title: "Open an issue beside a thread",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body,
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  });

  const layerWith = (input: {
    readonly body: string;
    readonly linked: ReadonlyArray<IssueLink>;
    readonly listCitedIssues: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"];
  }) =>
    Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
      getMergeRequestDetail: () => Effect.succeed(detailWith(input.body)),
      getProjectMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: false }),
      listLinkedIssues: () => Effect.succeed({ links: input.linked, truncated: false }),
      listCitedIssues: input.listCitedIssues,
    });

  const read = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "gitlab.com",
      number: 7,
    });
  });

  it.effect("adds an issue the description only cites, from this project alone", () => {
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    return read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues.map((link) => [link.number, link.closesIssue])).toEqual([
          [12, true],
          [34, false],
        ]);
        // GitLab's issues endpoint is per project, and one read is the whole budget here.
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual([34]);
      }),
      Effect.provide(
        layerWith({
          body: "Closes #12. Part of #34 and of acme/tools#9.",
          linked: [issue(12, true)],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("applies the citation cap after removing other projects", () => {
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    const external = Array.from({ length: 10 }, (_, index) => `group/tools#${index + 1}`).join(" ");

    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual([34]);
        expect(detail.linkedIssues.map((link) => link.number)).toEqual([34]);
      }),
      Effect.provide(
        layerWith({
          body: `${external} then #34`,
          linked: [],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect.each([
    { count: 10, linkedCount: 0 },
    { count: 11, linkedCount: 0 },
    { count: 20, linkedCount: 10 },
  ])("caps only unlinked citations and reports overflow (%j)", ({ count, linkedCount }) => {
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const linked = numbers.slice(0, linkedCount).map((number) => issue(number, true));
    const citedNumbers = numbers.slice(linkedCount, linkedCount + 10);
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed(citedNumbers.map((number) => issue(number, false))));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).toHaveBeenCalledTimes(1);
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual(citedNumbers);
        expect(detail.linkedIssues.map((link) => link.number)).toEqual(
          numbers.slice(0, linkedCount + 10),
        );
        expect(detail.linkedIssuesTruncated).toBe(count - linkedCount > 10);
      }),
      Effect.provide(
        layerWith({
          body: numbers.map((number) => "#" + number).join(" "),
          linked,
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("asks nothing when more than ten citations are already host links", () => {
    const linked = Array.from({ length: 11 }, (_, index) => issue(index + 1, true));
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([]));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).not.toHaveBeenCalled();
        expect(detail.linkedIssues).toEqual(linked);
        expect(detail.linkedIssuesTruncated).toBe(false);
      }),
      Effect.provide(
        layerWith({
          body: linked.map((link) => "#" + link.number).join(" "),
          linked,
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("drops a reference GitLab answered nothing for", () =>
    read.pipe(
      Effect.map((detail) => expect(detail.linkedIssues).toEqual([])),
      Effect.provide(
        layerWith({
          body: "Part of #404.",
          linked: [],
          listCitedIssues: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect.each(["listLinkedIssues", "listCitedIssues"] as const)(
    "propagates a rate limit from %s and stops later citation reads",
    (operation) =>
      Effect.gen(function* () {
        const rateLimit = new GitLabCli.GitLabCliRateLimitError({
          operation: "execute",
          command: "glab",
          cwd: "/w",
          cause: new Error("429 Too Many Requests"),
        });
        const listCitedIssues = vi.fn<
          GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
        >(() => Effect.fail(rateLimit));
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              getMergeRequestDetail: () => Effect.succeed(detailWith("Part of #34.")),
              getProjectMergeCapabilities: () =>
                Effect.succeed({ merge: true, squash: true, rebase: false }),
              listLinkedIssues: () =>
                operation === "listLinkedIssues"
                  ? Effect.fail(rateLimit)
                  : Effect.succeed({ links: [], truncated: false }),
              listCitedIssues,
            }),
          ),
        );
        const result = yield* provider
          .getChangeRequest({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 })
          .pipe(Effect.result);

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.reason, "rate-limited");
          assert.strictEqual(result.failure.operation, "getChangeRequest");
          assert.strictEqual(result.failure.cause, rateLimit);
        }
        expect(listCitedIssues).toHaveBeenCalledTimes(operation === "listLinkedIssues" ? 0 : 1);
      }),
  );

  it.effect("keeps the host's own links when the lookup fails", () =>
    read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues).toEqual([issue(12, true)]);
        expect(detail.linkedIssuesTruncated).toBe(true);
      }),
      Effect.provide(
        layerWith({
          body: "Part of #34.",
          linked: [issue(12, true)],
          listCitedIssues: () =>
            Effect.fail(
              new GitLabPullRequestCli.GitLabMergeRequestReadError({
                command: "glab",
                cwd: "/w",
                operation: "listCitedIssues",
                cause: new Error("404 Project Not Found"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("keeps citation links when the host link read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detailWith("Part of #34.")),
            getProjectMergeCapabilities: () =>
              Effect.succeed({ merge: true, squash: true, rebase: false }),
            listLinkedIssues: () =>
              Effect.fail(
                new GitLabCli.GitLabCliCommandError({
                  operation: "execute",
                  command: "glab",
                  cwd: "/w",
                  cause: new Error("404 Project Not Found"),
                }),
              ),
            listCitedIssues: () => Effect.succeed([issue(34, false)]),
          }),
        ),
      );
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });

      expect(detail.linkedIssues).toEqual([issue(34, false)]);
      expect(detail.linkedIssuesTruncated).toBe(true);
    }),
  );
});

describe("getChangeRequestActivity fallback errors", () => {
  it.effect.each(["listNotes", "listCommits", "listDiscussions", "listReactions"] as const)(
    "propagates a rate limit from %s and keeps ordinary failures partial",
    (operation) =>
      Effect.gen(function* () {
        for (const ErrorType of [
          GitLabCli.GitLabCliRateLimitError,
          GitLabCli.GitLabCliCommandError,
        ]) {
          const error = new ErrorType({
            operation: "execute",
            command: "glab",
            cwd: "/w",
            cause: new Error("request failed"),
          });
          const provider = yield* make.pipe(
            Effect.provide(
              Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
                listNotes: () => Effect.succeed({ comments: [], truncated: false }),
                listCommits: () => Effect.succeed([]),
                listDiscussions: () => Effect.succeed({ threads: [], truncated: false }),
                listReactions: () =>
                  Effect.succeed({ reactions: [], reactionsByNoteId: new Map() }),
                [operation]: () => Effect.fail(error),
              }),
            ),
          );
          const result = yield* provider
            .getChangeRequestActivity({
              cwd: "/w",
              repository: "acme/web",
              host: "gitlab.com",
              number: 7,
            })
            .pipe(Effect.result);

          assert.strictEqual(
            result._tag,
            ErrorType === GitLabCli.GitLabCliRateLimitError ? "Failure" : "Success",
          );
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure.reason, "rate-limited");
            assert.strictEqual(result.failure.operation, "getChangeRequestActivity");
            assert.strictEqual(result.failure.cause, error);
          }
        }
      }),
  );
});

describe("optional activity reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const comment = {
    id: "42",
    kind: "issue-comment" as const,
    author: null,
    body: "Keep this comment",
    createdAt: "2026-07-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const commit = {
    oid: "abc",
    messageHeadline: "Keep this commit",
    committedDate: "2026-07-01T00:00:00Z",
  };
  const reads = {
    listNotes: () => Effect.succeed({ comments: [comment], truncated: false }),
    listCommits: () => Effect.succeed([commit]),
    listDiscussions: () => Effect.succeed({ threads: [], truncated: false }),
    listReactions: () => Effect.succeed({ reactions: [], reactionsByNoteId: new Map() }),
  };
  const context = {
    operation: "execute" as const,
    command: "glab" as const,
    cwd: "/w",
    cause: null,
  };

  it.effect.each([
    {
      operation: "listNotes",
      error: new GitLabCli.GitLabCliAuthenticationError(context),
      reason: "unauthenticated",
    },
    {
      operation: "listCommits",
      error: new GitLabCli.GitLabCliUnavailableError(context),
      reason: "missing-tool",
    },
  ] as const)(
    "reports $reason instead of successful partial activity",
    ({ operation, error, reason }) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              ...reads,
              [operation]: () => Effect.fail(error),
            }),
          ),
        );

        expect(yield* Effect.result(provider.getChangeRequestActivity(reference))).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PullRequestProviderError",
            provider: "gitlab",
            operation: "getChangeRequestActivity",
            reason,
            detail: error.detail,
            cause: error,
          },
        });
      }),
  );

  it.effect("keeps comments and commits when optional discussions and reactions fail", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: "/w",
                  operation: "listDiscussions",
                  cause: null,
                }),
              ),
            listReactions: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
          }),
        ),
      );

      expect(yield* provider.getChangeRequestActivity(reference)).toEqual({
        comments: [{ ...comment, reactions: [] }],
        commentCount: 1,
        commentsTruncated: true,
        reviewThreads: [],
        reactions: [],
        commits: [commit],
      });
    }),
  );
});
