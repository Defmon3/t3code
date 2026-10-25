import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import type { IssueLink, PullRequestReaction } from "@t3tools/contracts";

import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import type {
  GitHubPullRequestCore,
  GitHubPullRequestSearchItem,
} from "./gitHubPullRequestJson.ts";
import { gitHubViewerPermissions, loginAvatarUrl, make } from "./GitHubPullRequestProvider.ts";
import type { GitHubReviewThreadComments } from "./gitHubPullRequestJson.ts";

const coreFields = {
  reviewRequestTeams: [],
  checksTruncated: false,
  comparison: { behindBy: 0, viewerCanUpdate: true },
  viewerAccess: {
    canWrite: true,
    canTriage: true,
    canUpdate: true,
    didAuthor: false,
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    autoMergeAllowed: true,
  },
};

it.effect("maps credential verification failures without relabeling operation failures", () =>
  Effect.gen(function* () {
    let verificationFails = true;
    let operations = 0;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          withVerifiedCredential: (_input, use) =>
            verificationFails
              ? Effect.fail(
                  new GitHubPullRequestApi.GitHubViewerLoginUnavailableError({
                    cwd: "/w",
                  }),
                )
              : use({ accountId: "123", viewer: "viewer", credentialFingerprint: "fingerprint" }),
        }),
      ),
    );
    const verify = provider.withVerifiedCredential;
    if (verify === undefined)
      return yield* Effect.die("credential verification was not implemented");
    const input = { cwd: "/w", host: "github.com" };
    const operation = () =>
      Effect.sync(() => {
        operations++;
      }).pipe(Effect.andThen(Effect.fail("operation-failed")));
    expect(yield* verify(input, operation).pipe(Effect.flip)).toMatchObject({
      _tag: "PullRequestProviderError",
      operation: "routeIdentity",
    });
    expect(operations).toBe(0);
    verificationFails = false;
    expect(yield* verify(input, operation).pipe(Effect.flip)).toBe("operation-failed");
    expect(operations).toBe(1);
  }),
);

it.effect("advertises standalone branch deletion for source repository writers", () =>
  Effect.gen(function* () {
    let action: string | undefined;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          runPullRequestAction: (input) =>
            Effect.sync(() => {
              action = input.action;
            }),
        }),
      ),
    );
    expect(provider.capabilities.deleteBranch).toBe(true);
    expect(provider.capabilities.actions).toContain("delete-branch");
    yield* provider.runAction({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
      action: "delete-branch",
    });
    expect(action).toBe("delete-branch");
    const access = {
      canWrite: false,
      canTriage: false,
      canUpdate: false,
      didAuthor: false,
      canDeleteBranch: true,
      autoMergeAllowed: true,
    };
    expect(gitHubViewerPermissions(access).actions).toContain("delete-branch");
    expect(
      gitHubViewerPermissions({
        ...access,
        canWrite: true,
        didAuthor: true,
        canDeleteBranch: false,
      }).actions,
    ).not.toContain("delete-branch");
  }),
);

describe("gitHubViewerPermissions", () => {
  it("offers everything to a viewer who can write to the repository", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: true,
        canDeleteBranch: true,
        canTriage: true,
        canUpdate: true,
        didAuthor: false,
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: [
        "delete-branch",
        "merge",
        "enable-auto-merge",
        "disable-auto-merge",
        "revert",
        "approve-workflows",
        "ready",
        "draft",
        "close",
        "reopen",
      ],
      comment: true,
      resolve: true,
      stackRebase: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
    });
  });

  it("leaves a passer-by on a repository they can only read nothing but the review", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: false,
        canTriage: false,
        canUpdate: false,
        didAuthor: false,
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: false,
      labels: false,
    });
  });

  it("lets a triager label without letting them merge or ask for a review", () => {
    const permissions = gitHubViewerPermissions({
      canWrite: false,
      canTriage: true,
      canUpdate: false,
      didAuthor: false,
      autoMergeAllowed: true,
    });
    expect(permissions.labels).toBe(true);
    expect(permissions.requestReviewers).toBe(false);
    expect(permissions.actions).toEqual([]);
  });

  it("keeps an author's own pull request theirs to close, with read access and no more", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: false,
        canTriage: false,
        canUpdate: true,
        didAuthor: true,
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment"],
      requestReviewers: false,
      labels: false,
    });
  });

  it.effect("uses the permissions carried by the core read without a second request", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.viewerPermissions).toEqual({
        actions: ["ready", "draft", "close", "reopen"],
        comment: true,
        resolve: false,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: false,
        labels: false,
      });
      expect(detail.workflowApprovalsRequired).toBeUndefined();
      expect(detail.checks).toContainEqual({
        name: "Workflow approval status",
        status: "action-required",
        description: "GitHub could not determine whether workflows are awaiting approval.",
        url: null,
      });
      for (const fingerprint of ["broad", "restricted", "broad"]) {
        const scoped = yield* provider
          .getChangeRequest({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
          })
          .pipe(
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
              host: "github.com",
              token: Redacted.make("credential"),
              credentialFingerprint: fingerprint,
            }),
          );
        expect(scoped.mergeCapabilities.squash).toBe(fingerprint !== "restricted");
      }
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.succeed({
              ...coreFields,
              comparison: null,
              viewerAccess: { ...coreFields.viewerAccess, canWrite: false, canTriage: false },
              authorId: null,
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              isCrossRepository: true,
              headRepositoryOwner: null,
              headBranch: "feat/page",
              baseBranch: "main",
              state: "open" as const,
              isDraft: false,
              mergeability: "mergeable" as const,
              reviewDecision: null,
              additions: 1,
              deletions: 1,
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
              reviewRequestLogins: [],
              hasTeamReviewRequest: false,
              checksState: null,
              labels: [],
              body: "",
              changedFiles: 1,
              mergedAt: null,
              closedAt: null,
              checks: [],
              comments: [],
              commits: [],
            }).pipe(
              Effect.flatMap((detail) =>
                GitHubRequestPolicy.PinnedGitHubCredential.pipe(
                  Effect.map((credential) => ({
                    ...detail,
                    viewerAccess: {
                      ...detail.viewerAccess,
                      mergeCapabilities: {
                        ...detail.viewerAccess.mergeCapabilities,
                        squash: credential?.credentialFingerprint !== "restricted",
                      },
                    },
                  })),
                ),
              ),
            ),
        }),
      ),
    ),
  );

  it.effect("keeps fork workflows awaiting approval out of the passing state", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      const readChecks = provider.getChangeRequestChecks;
      if (readChecks === undefined) return yield* Effect.die("checks read missing");
      expect(
        yield* readChecks({ cwd: "/w", repository: "acme/web", host: "github.com", number: 7 }),
      ).toEqual({ state: detail.state, checks: detail.checks });
      expect(detail.workflowApprovalsRequired).toBe(1);
      expect(detail.checks).toEqual([
        {
          name: "manual gate",
          status: "action-required",
          description: null,
          url: "https://example.com/manual-gate",
        },
        {
          name: "build",
          status: "success",
          description: null,
          url: null,
        },
        {
          name: "contributor tests",
          status: "action-required",
          description: "A maintainer must approve this workflow before it can run.",
          url: "https://github.com/acme/web/actions/runs/123",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.succeed({
              ...coreFields,
              authorId: null,
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              isCrossRepository: true,
              headRepositoryOwner: "octocat",
              headSha: "abc123",
              headBranch: "feat/page",
              baseBranch: "main",
              state: "open",
              isDraft: false,
              mergeability: "mergeable",
              reviewDecision: null,
              additions: 1,
              deletions: 1,
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
              reviewRequestLogins: [],
              hasTeamReviewRequest: false,
              checksState: "passing",
              labels: [],
              body: "",
              changedFiles: 1,
              mergedAt: null,
              closedAt: null,
              checks: [
                {
                  name: "manual gate",
                  status: "action-required",
                  description: null,
                  url: "https://example.com/manual-gate",
                },
                { name: "build", status: "success", description: null, url: null },
              ],
              comments: [],
              commits: [],
            }),
          listWorkflowRunsRequiringApproval: () =>
            Effect.succeed([
              {
                id: 123,
                name: "contributor tests",
                url: "https://github.com/acme/web/actions/runs/123",
              },
            ]),
          getViewerAccess: () =>
            Effect.succeed({
              canWrite: true,
              canTriage: true,
              canUpdate: true,
              didAuthor: false,
              mergeCapabilities: { merge: true, squash: true, rebase: true },
              autoMergeAllowed: true,
            }),
        }),
      ),
    ),
  );
});

const openDetail = {
  ...coreFields,
  authorId: null,
  number: 7,
  title: "Pull request 7",
  url: "https://github.com/acme/web/pull/7",
  author: null,
  isCrossRepository: true,
  headRepositoryOwner: "acme",
  headSha: "abc123",
  headBranch: "feat/page",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  reviewDecision: null,
  additions: 1,
  deletions: 1,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  reviewRequestLogins: [],
  hasTeamReviewRequest: false,
  checksState: null,
  labels: [],
  body: "",
  changedFiles: 1,
  mergedAt: null,
  closedAt: null,
  checks: [],
  comments: [],
  commits: [],
};

it.effect.each([
  {
    operation: "listCitedIssues",
    read: "getChangeRequest",
    partial: { linkedIssuesTruncated: true },
  },
  {
    operation: "listLinkedIssues",
    read: "getChangeRequest",
    partial: { linkedIssuesTruncated: true },
  },
  {
    operation: "listActorAvatars",
    read: "listChangeRequests",
    partial: {
      items: [{ number: 7, author: { avatarUrl: "https://github.com/octocat.png?size=80" } }],
    },
  },
  {
    operation: "listReviewThreadComments",
    read: "getChangeRequestActivity",
    partial: { commentsTruncated: true, reviewThreadsTruncated: true },
  },
] as const)("preserves quota errors from $operation and keeps ordinary fallback", (test) =>
  Effect.gen(function* () {
    for (const error of [
      new GitHubRequestPolicy.GitHubApiRateLimitError({
        host: "github.com",
        operation: test.operation,
        retryAt: 123_000,
      }),
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: "github",
        host: "github.com",
        retryAt: 123_000,
      }),
      new GitHubPullRequestApi.GitHubPullRequestReadError({
        cwd: "/w",
        operation: test.operation,
        cause: "unavailable",
      }),
    ]) {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
            getPullRequestDetail: () =>
              Effect.succeed({ ...openDetail, isCrossRepository: false, body: "Part of #34." }),
            getPullRequestActivity: () => Effect.succeed(openDetail),
            listPullRequests: () =>
              Effect.succeed({
                items: [
                  {
                    ...openDetail,
                    authorId: "actor-id",
                    author: { login: "octocat", name: null, avatarUrl: null },
                  },
                ],
                truncated: false,
                continues: true,
              }),
            listCitedIssues: () =>
              test.operation === "listCitedIssues" ? Effect.fail(error) : Effect.succeed([]),
            listLinkedIssues: () =>
              test.operation === "listLinkedIssues"
                ? Effect.fail(error)
                : Effect.succeed({ links: [], truncated: false }),
            listActorAvatars: () => Effect.fail(error),
            listReviewThreadComments: () => Effect.fail(error),
          }),
        ),
      );
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        state: "open",
        involvement: "all",
        viewer: "viewer",
        limit: 20,
      } as const;
      const result =
        test.read === "listChangeRequests"
          ? yield* provider.listChangeRequests(input).pipe(Effect.result)
          : test.read === "getChangeRequestActivity"
            ? yield* provider.getChangeRequestActivity(input).pipe(Effect.result)
            : yield* provider.getChangeRequest(input).pipe(Effect.result);
      if (error._tag === "GitHubPullRequestReadError") {
        expect(result).toMatchObject({ _tag: "Success", success: test.partial });
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PullRequestProviderError",
            operation: test.read,
            reason: "rate-limited",
            retryAt: 123_000,
            cause: error,
          },
        });
      }
    }
  }),
);

it.effect("does not classify same-repository gates as fork workflow approvals", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const detail = yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });

    expect(detail.workflowApprovalsRequired).toBe(0);
    expect(detail.checks).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
        listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
        revalidateChecks: (_input, read) => read,
        getPullRequestDetail: () => Effect.succeed({ ...openDetail, isCrossRepository: false }),
        listWorkflowRunsRequiringApproval: () =>
          Effect.die("same-repository pull requests must not probe fork workflow approvals"),
        getViewerAccess: () =>
          Effect.succeed({
            canWrite: true,
            canTriage: true,
            canUpdate: true,
            didAuthor: false,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            autoMergeAllowed: true,
          }),
      }),
    ),
  ),
);

it.effect("keeps an unsafe workflow approval scope visible as unknown", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const detail = yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });

    expect(detail.workflowApprovalsRequired).toBeUndefined();
    expect(detail.checks).toEqual([
      {
        name: "Workflow approval status",
        status: "action-required",
        description: "GitHub could not determine whether workflows are awaiting approval.",
        url: null,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
        listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
        revalidateChecks: (_input, read) => read,
        getPullRequestDetail: () => Effect.succeed(openDetail),
        listWorkflowRunsRequiringApproval: () =>
          Effect.fail(
            new GitHubPullRequestApi.GitHubWorkflowApprovalRefusedError({
              cwd: "/w",
              number: 7,
              reason: "head-not-unique",
              observedCount: 2,
              limit: 1_000,
            }),
          ),
        getViewerAccess: () =>
          Effect.succeed({
            canWrite: true,
            canTriage: true,
            canUpdate: true,
            didAuthor: false,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            autoMergeAllowed: true,
          }),
      }),
    ),
  ),
);

describe("getViewerPermissions", () => {
  const access = {
    canWrite: true,
    canTriage: true,
    canUpdate: true,
    didAuthor: false,
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    autoMergeAllowed: true,
  };

  const layerWithDetail = (
    detail: Effect.Effect<GitHubPullRequestCore, GitHubPullRequestApi.GitHubPullRequestApiError>,
    onDetail: (allowReserve: boolean) => void = () => {},
  ) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
      revalidateChecks: (_input, read) => read,
      getPullRequestDetail: () =>
        SourceControlRateLimit.Interactive.pipe(
          Effect.tap((allowReserve) => Effect.sync(() => onDetail(allowReserve))),
          Effect.flatMap(() => detail),
        ),
      getViewerAccess: () => Effect.die("Unexpected access read"),
    });

  it.effect("answers access and update-branch from the one detail read", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(permissions.actions).toContain("merge");
      expect(permissions.actions).toContain("update-branch");
      expect(permissions.updateMethods).toEqual(["merge", "rebase"]);
    }).pipe(
      Effect.provide(
        layerWithDetail(
          Effect.succeed({ ...openDetail, comparison: { behindBy: 3, viewerCanUpdate: true } }),
        ),
      ),
    ),
  );

  it.effect("still answers from the light access read when the detail read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(permissions.actions).toContain("merge");
      expect(permissions.actions).not.toContain("update-branch");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.fail(
              new GitHubPullRequestApi.GitHubPullRequestReadError({
                cwd: "/w",
                operation: "getPullRequestDetail",
                cause: new Error("head changed"),
              }),
            ),
          getViewerAccess: () => Effect.succeed(access),
        }),
      ),
    ),
  );

  it.effect("withholds update-branch where GitHub could not compare the branch", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(permissions.actions).not.toContain("update-branch");
      expect(permissions.updateMethods).toBeUndefined();
      expect(permissions.actions).toContain("merge");
    }).pipe(Effect.provide(layerWithDetail(Effect.succeed({ ...openDetail, comparison: null })))),
  );
});

describe("getChangeRequest commits", () => {
  const baseDetail = {
    authorId: null,
    number: 7,
    title: "Pull request 7",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 1,
    deletions: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    checksState: null,
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    checks: [],
    comments: [],
  };

  const baseThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map<string, string>(),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewThreadsTruncated: false,
    reactions: [],
    reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
    editedAtById: new Map<string, string>(),
    reviewers: [],
    avatarsByLogin: new Map<string, string>(),
    botLogins: new Set<string>(),
    commitStats: new Map<string, { readonly additions: number; readonly deletions: number }>(),
    viewer: { canUpdate: true, didAuthor: false },
  };

  const layerWith = (commits: GitHubReviewThreadComments["commits"]) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestActivity: () =>
        Effect.succeed({
          author: baseDetail.author,
          comments: baseDetail.comments,
          commits: [
            {
              oid: "view-oldest",
              messageHeadline: "gh pr view's oldest commit",
              committedDate: "2026-01-01T00:00:00Z",
              authors: [],
            },
          ],
        }),
      listReviewThreadComments: () => Effect.succeed({ ...baseThreadComments, commits }),
    });

  it.effect("prefers the GraphQL commits, which are the newest, over the gh view list", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest"]);
    }).pipe(
      Effect.provide(
        layerWith([
          {
            oid: "graphql-newest",
            messageHeadline: "the newest commit gh pr view drops",
            committedDate: "2026-07-06T00:00:00Z",
            authors: [],
          },
        ]),
      ),
    ),
  );

  it.effect("falls back to the gh view list when the GraphQL read has no commits", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["view-oldest"]);
    }).pipe(Effect.provide(layerWith([]))),
  );
});

describe("getChangeRequestActivity dismissed reviews", () => {
  const dismissedReview = (body: string) => ({
    id: "PRR_1",
    kind: "review" as const,
    author: { login: "macroscopeapp", name: null, avatarUrl: null },
    body,
    createdAt: "2026-07-03T00:00:00Z",
    url: null,
    path: null,
    reviewState: "DISMISSED",
  });
  const threadComments: GitHubReviewThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map([["PRR_1", "Dismissing prior approval to re-evaluate 9b66581"]]),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewThreadsTruncated: false,
    reactions: [],
    reactionsById: new Map(),
    editedAtById: new Map([["PRR_1", "2026-07-04T00:00:00Z"]]),
    reviewers: [],
    avatarsByLogin: new Map(),
    botLogins: new Set(["macroscopeapp"]),
    commitStats: new Map(),
    commits: [],
    viewer: { canUpdate: true, didAuthor: false },
  };
  const layerFor = (body: string) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestActivity: () =>
        Effect.succeed({ author: null, comments: [dismissedReview(body)], commits: [] }),
      listReviewThreadComments: () => Effect.succeed(threadComments),
    });
  const readActivity = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });
  });

  it.effect("fills a marker-only dismissed review with the timeline's reason", () =>
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("Dismissing prior approval to re-evaluate 9b66581");
        expect(activity.comments[0]?.author?.isBot).toBe(true);
        expect(activity.comments[0]?.editedAt).toBe("2026-07-04T00:00:00Z");
      }),
      Effect.provide(layerFor("<!-- Macroscope (Approvability) review body marker -->")),
    ),
  );
});

describe("loginAvatarUrl", () => {
  it("refuses anything that is not a login, rather than building a URL out of it", () => {
    for (const login of ["../../etc", "a b", "-leading", "x".repeat(40), ""]) {
      expect(loginAvatarUrl(login, "github.com")).toBeNull();
    }
  });
});

describe("getChangeRequest linked issues", () => {
  const issue = (number: number, closesIssue: boolean): IssueLink => ({
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    state: "open",
    closesIssue,
  });

  const detailWith = (body: string) => ({
    ...coreFields,
    authorId: null,
    number: 7,
    title: "Open an issue beside a thread",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headRepositoryOwner: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    reviewDecision: null,
    additions: 1,
    deletions: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    checksState: null,
    labels: [],
    body,
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    checks: [],
    comments: [],
    commits: [],
  });

  const layerWith = (input: {
    readonly body: string;
    readonly linked: ReadonlyArray<IssueLink>;
    readonly listCitedIssues: GitHubPullRequestApi.GitHubPullRequestApi["Service"]["listCitedIssues"];
  }) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      getPullRequestDetail: () => Effect.succeed(detailWith(input.body)),
      listLinkedIssues: () => Effect.succeed({ links: input.linked, truncated: false }),
      listCitedIssues: input.listCitedIssues,
    });

  const read = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });
  });

  it.effect("adds an issue the body only cites, once GitHub confirms it is one", () => {
    const listCitedIssues = vi.fn<
      GitHubPullRequestApi.GitHubPullRequestApi["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    return read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues.map((link) => [link.number, link.closesIssue])).toEqual([
          [12, true],
          [34, false],
        ]);
        expect(detail.linkedIssuesTruncated).toBe(false);
        // The one GitHub already reported is not asked about again.
        expect(listCitedIssues.mock.calls[0]?.[0].references).toEqual([
          { repository: "acme/web", number: 34 },
        ]);
      }),
      Effect.provide(
        layerWith({
          body: "Closes #12. Part of #34.",
          linked: [issue(12, true)],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("fills the detail author's avatar while retaining linked issues", () =>
    read.pipe(
      Effect.map((detail) => {
        expect(detail.author?.avatarUrl).toBe("https://github.com/octocat.png?size=80");
        expect(detail.linkedIssues).toEqual([issue(12, true)]);
      }),
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          getPullRequestDetail: () =>
            Effect.succeed({
              ...detailWith(""),
              author: { login: "octocat", name: null, avatarUrl: null },
            }),
          listLinkedIssues: () => Effect.succeed({ links: [issue(12, true)], truncated: false }),
        }),
      ),
    ),
  );

  it.effect.each([
    { count: 10, linkedCount: 0 },
    { count: 11, linkedCount: 0 },
    { count: 20, linkedCount: 10 },
  ])("caps only unlinked citations and reports overflow (%j)", ({ count, linkedCount }) => {
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const linked = numbers.slice(0, linkedCount).map((number) => issue(number, true));
    const citedNumbers = numbers.slice(linkedCount, linkedCount + 10);
    const listCitedIssues = vi.fn<
      GitHubPullRequestApi.GitHubPullRequestApi["Service"]["listCitedIssues"]
    >(() => Effect.succeed(citedNumbers.map((number) => issue(number, false))));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).toHaveBeenCalledTimes(1);
        expect(listCitedIssues.mock.calls[0]?.[0].references).toEqual(
          citedNumbers.map((number) => ({ repository: "acme/web", number })),
        );
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
      GitHubPullRequestApi.GitHubPullRequestApi["Service"]["listCitedIssues"]
    >(() => Effect.succeed([]));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).not.toHaveBeenCalled();
        expect(detail.linkedIssuesTruncated).toBe(false);
        // The host's own claim survives: only it can say what merging closes.
        expect(detail.linkedIssues).toEqual(linked);
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

  it.effect("drops a reference GitHub answered nothing for", () =>
    read.pipe(
      // `#404` is a number in a body and no more than that: a dead row here is worse than
      // an absent one.
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

  it.effect("reports host links as incomplete when their read fails", () =>
    read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues).toEqual([]);
        expect(detail.linkedIssuesTruncated).toBe(true);
      }),
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          getPullRequestDetail: () => Effect.succeed(detailWith("")),
          listLinkedIssues: () =>
            Effect.fail(
              new GitHubPullRequestApi.GitHubPullRequestReadError({
                cwd: "/w",
                operation: "listLinkedIssues",
                cause: "unavailable",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect.each([[], [issue(12, true)]])(
    "keeps host links and reports failed cited lookups as incomplete (%j)",
    (linked) =>
      read.pipe(
        Effect.map((detail) => {
          expect(detail.linkedIssues).toEqual(linked);
          expect(detail.linkedIssuesTruncated).toBe(true);
        }),
        Effect.provide(
          layerWith({
            body: "Part of #34.",
            linked,
            listCitedIssues: () =>
              Effect.fail(
                new GitHubPullRequestApi.GitHubPullRequestReadError({
                  cwd: "/w",
                  operation: "listCitedIssues",
                  cause: new Error("GraphQL: Could not resolve to an issue"),
                }),
              ),
          }),
        ),
      ),
  );
});

describe("listChangeRequestsAcross", () => {
  const searched = (repository: string): GitHubPullRequestSearchItem => ({
    repository,
    number: 1,
    title: "Change",
    url: `https://github.com/${repository}/pull/1`,
    author: null,
    authorId: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    labels: [],
    reviewDecision: null,
    checksState: null,
  });
  const across = {
    cwd: "/w",
    host: "github.com",
    repositories: ["acme/web", "acme/docs"],
    state: "open" as const,
    involvement: "all" as const,
    viewer: "viewer",
    limit: 50,
  };
  type Search = Parameters<
    GitHubPullRequestApi.GitHubPullRequestApi["Service"]["searchPullRequests"]
  >[0];
  // Pages answer in turn; a one-repository check for any pull request answers from `covered`.
  const providerAnswering = (input: {
    readonly pages: Array<GitHubPullRequestApi.GitHubPullRequestSearchBatch>;
    readonly covered?: (repository: string) => boolean;
    readonly checks?: Array<string>;
  }) =>
    make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          searchPullRequests: (search: Search) => {
            if (search.state !== "all") return Effect.succeed(input.pages.shift()!);
            const repository = search.repositories[0]!;
            input.checks?.push(repository);
            return input.covered === undefined
              ? Effect.fail(
                  new GitHubPullRequestApi.GitHubViewerLoginUnavailableError({ cwd: search.cwd }),
                )
              : Effect.succeed({
                  items: input.covered(repository) ? [searched(repository)] : [],
                  truncated: false,
                });
          },
        }),
      ),
      Effect.map((provider) => provider.listChangeRequestsAcross!),
    );

  it.effect("believes silence about a repository search covers, and checks it once", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      expect((yield* read(across)).unresolved).toEqual([]);
      expect((yield* read(across)).unresolved).toEqual([]);
      expect(checks).toEqual(["acme/docs"]);
    }),
  );

  it.effect("leaves a repository search does not cover to be read on its own", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [{ items: [searched("acme/web")], truncated: false }],
        covered: (repository) => repository !== "acme/docs",
      });
      expect((yield* read(across)).unresolved).toEqual(["acme/docs"]);
    }),
  );

  it.effect("does not check a repository a page had rows for", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web"), searched("acme/docs")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      yield* read(across);
      expect((yield* read(across)).unresolved).toEqual([]);
      expect(checks).toEqual([]);
    }),
  );

  it.effect("vouches for no silent repository in a truncated first slice", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [{ items: [searched("acme/web")], truncated: true }],
        covered: () => true,
      });
      expect((yield* read(across)).unresolved).toEqual(["acme/docs"]);
    }),
  );

  it.effect("past the first slice, believes a covered repository and not an uncovered one", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: true },
          { items: [searched("acme/web")], truncated: true },
        ],
        covered: (repository) => repository !== "acme/renamed",
      });
      const later = { ...across, cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 1 } };
      expect((yield* read(later)).unresolved).toEqual([]);
      expect(
        (yield* read({ ...later, repositories: ["acme/web", "acme/renamed"] })).unresolved,
      ).toEqual(["acme/renamed"]);
    }),
  );

  it.effect("asks again after a failed check, and after coverage has had time to change", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const failing = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        checks,
      });
      expect((yield* failing(across)).unresolved).toEqual(["acme/docs"]);
      expect((yield* failing(across)).unresolved).toEqual(["acme/docs"]);
      expect(checks).toEqual(["acme/docs", "acme/docs"]);

      checks.length = 0;
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      yield* read(across);
      yield* TestClock.adjust("61 minutes");
      yield* read(across);
      expect(checks).toEqual(["acme/docs", "acme/docs"]);
    }),
  );
});
