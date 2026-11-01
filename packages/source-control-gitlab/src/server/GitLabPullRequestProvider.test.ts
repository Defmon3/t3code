import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueLink } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

it.effect.each(["merge", "disable-auto-merge"] as const)(
  "keeps reads and %s on the selected host when glab prefers another remote",
  (action) =>
    Effect.gen(function* () {
      const selectedHost = "gitlab.example.test:8443";
      const otherHost = "other.gitlab.example.test";
      const readHosts: string[] = [];
      const mergedHosts: string[] = [];
      const native = yield* GitLabCli.make.pipe(
        Effect.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) => {
                // glab prefers a remote named `gitlab` to `origin`. The checkout's
                // selected repository must still own every request and mutation.
                const host = input.env?.GITLAB_HOST ?? otherHost;
                const path = input.args[1];
                const mutation =
                  input.args[0] === "mr" || (input.args.includes("POST") && path !== "graphql");
                if (mutation) mergedHosts.push(host);
                else readHosts.push(host);
                const response = mutation
                  ? {}
                  : path === "graphql"
                    ? {
                        data: {
                          project: {
                            mergeRequests: {
                              nodes: [
                                { iid: "7", diffStatsSummary: { additions: 2, deletions: 1 } },
                              ],
                            },
                            mergeRequest: {
                              diffStatsSummary: { fileCount: 1 },
                              diffStats: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
                            },
                          },
                        },
                      }
                    : path?.includes("merge_requests/")
                      ? {
                          iid: 7,
                          title: "Merge request 7",
                          web_url: `https://${host}/acme/web/-/merge_requests/7`,
                          source_branch: "feature",
                          target_branch: "main",
                          created_at: "2026-07-01T00:00:00Z",
                          updated_at: "2026-07-02T00:00:00Z",
                          user: { can_merge: true },
                          diff_refs: {
                            head_sha: "a".repeat(40),
                            base_sha: "b".repeat(40),
                            start_sha: "b".repeat(40),
                          },
                        }
                      : path === "user"
                        ? { username: "reviewer" }
                        : path?.includes("/labels?") || path?.includes("/users?")
                          ? []
                          : { merge_method: "merge", squash_option: "default_off" };
                return Effect.succeed(
                  TestSourceControlHost.processOutput(JSON.stringify(response)),
                );
              },
            },
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.make.pipe(
        Effect.provideService(GitLabCli.GitLabCli, native),
      );
      const provider = yield* make.pipe(
        Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
      );
      const reference = {
        cwd: "/repo",
        repository: "acme/web",
        host: selectedHost,
        number: 7,
      };
      const detail = yield* provider.getChangeRequest(reference);
      expect({ additions: detail.additions, deletions: detail.deletions }).toEqual({
        additions: 2,
        deletions: 1,
      });
      assert.isDefined(provider.getChangeRequestSummary);
      expect((yield* provider.getChangeRequestSummary(reference)).additions).toBe(2);
      assert.isDefined(provider.listChangeRequestStats);
      expect(
        yield* provider.listChangeRequestStats({ ...reference, changeRequests: [reference] }),
      ).toEqual([{ repository: reference.repository, number: 7, additions: 2, deletions: 1 }]);
      assert.isDefined(provider.getFileStats);
      expect(yield* provider.getFileStats(reference)).toEqual({
        files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
        truncated: false,
      });
      expect(yield* provider.getViewer(reference)).toBe("reviewer");
      assert.isDefined(provider.listRepositoryLabels);
      yield* provider.listRepositoryLabels(reference);
      assert.isDefined(provider.searchRepositoryAuthors);
      yield* provider.searchRepositoryAuthors(reference);
      yield* provider.runAction({ ...reference, action });

      expect(readHosts).toEqual(Array(action === "merge" ? 12 : 11).fill(selectedHost));
      expect({ url: detail.url, mutatedHosts: mergedHosts }).toEqual({
        url: `https://${selectedHost}/acme/web/-/merge_requests/7`,
        mutatedHosts: [selectedHost],
      });
    }),
);

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

  it.effect.each(["getChangeRequestPreview", "getChangeRequestSummary"] as const)(
    "%s preserves merge request fields without fetching project settings",
    (operation) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              getMergeRequestDetail: () => Effect.succeed(detail),
              listMergeRequestStats: () => Effect.succeed([]),
            }),
          ),
        );
        const read = provider[operation];
        assert.isDefined(read);
        expect(
          yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 }),
        ).toEqual(detail);
      }),
  );

  const readWith = (
    divergence: { readonly divergedCommits?: number },
    stats: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listMergeRequestStats"] = () =>
      Effect.succeed([]),
  ) =>
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
          listMergeRequestStats: stats,
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

  it.effect("fills in the line counts the REST detail leaves out", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({}, () =>
        Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
      );

      expect(changeRequest.additions).toBe(40);
      expect(changeRequest.deletions).toBe(2);
    }),
  );

  it.effect("reports an unauthenticated line count read instead of a detail without counts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readWith({}, () =>
          Effect.fail(
            new GitLabCli.GitLabCliAuthenticationError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: null,
            }),
          ),
        ),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PullRequestProviderError", reason: "unauthenticated" },
      });
    }),
  );

  it.effect("gives linked threads line counts without reading the merge settings", () =>
    Effect.gen(function* () {
      const summary = yield* Effect.gen(function* () {
        const provider = yield* make;
        const read = provider.getChangeRequestSummary;
        if (read === undefined) return yield* Effect.die("summary read missing");
        return yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 });
      }).pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
            getProjectMergeCapabilities: () => Effect.die("linked threads skip merge settings"),
            listMergeRequestStats: () =>
              Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
          }),
        ),
      );

      expect(summary.additions).toBe(40);
      expect(summary.deletions).toBe(2);
    }),
  );
});

describe("merge request reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
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

  const countingProvider = Effect.gen(function* () {
    const calls = { detail: 0, mergeCapabilities: 0 };
    const host = { viewerCanMerge: true };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          listMergeRequestStats: () => Effect.succeed([]),
          getMergeRequestDetail: (input) =>
            Effect.sync(() => {
              calls.detail += 1;
              return { ...detail, number: input.number, viewerCanMerge: host.viewerCanMerge };
            }),
          getProjectMergeCapabilities: () =>
            Effect.sync(() => {
              calls.mergeCapabilities += 1;
              return { merge: true, squash: true, rebase: true };
            }),
          runMergeRequestAction: () => Effect.void,
        }),
      ),
    );
    const checks = provider.getChangeRequestChecks;
    const forget = provider.forgetChangeRequestReads;
    if (checks === undefined || forget === undefined) {
      return yield* Effect.die("GitLab answers checks and forgets its reads");
    }
    return { provider, checks, forget, calls, host };
  });

  it.effect("asks for a project's merge methods once across its merge requests", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest({ ...reference, number: 8 });

      expect(calls.mergeCapabilities).toBe(1);
    }),
  );

  it.effect("answers checks from the merge request the detail just read", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* checks(reference);

      expect(calls.detail).toBe(1);

      const summary = provider.getChangeRequestSummary;
      assert.isDefined(summary);
      yield* summary(reference);
      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("reads a merge request again after a write to it", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.runAction({ ...reference, action: "ready" });
      yield* checks(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect.each([{ cwd: "/other" }, { host: "other.gitlab.test" }])(
    "does not share reads with %j",
    (other) =>
      Effect.gen(function* () {
        const { provider, calls } = yield* countingProvider;

        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });
        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });

        expect(calls).toEqual({ detail: 2, mergeCapabilities: 2 });
      }),
  );

  it.effect("reads a merge request again once a minute has passed", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* TestClock.adjust("61 seconds");
      yield* provider.getChangeRequest(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("answers viewer permissions from the host, not the page's read", () =>
    Effect.gen(function* () {
      const { provider, host } = yield* countingProvider;

      host.viewerCanMerge = false;
      yield* provider.getChangeRequest(reference);
      host.viewerCanMerge = true;
      const granted = yield* provider.getViewerPermissions(reference);
      host.viewerCanMerge = false;
      const revoked = yield* provider.getViewerPermissions(reference);

      expect(granted.actions).toContain("merge");
      expect(revoked.actions).not.toContain("merge");
    }),
  );

  it.effect("reads a merge request again once its reads are forgotten", () =>
    Effect.gen(function* () {
      const { provider, checks, forget, calls } = yield* countingProvider;
      const other = { ...reference, repository: "acme/api" };

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(other);
      yield* forget({ repository: "ACME/web", number: 7 });
      yield* checks(reference);
      yield* checks(other);
      expect(calls.detail).toBe(3);

      yield* forget({ repository: "acme/web" });
      yield* checks(reference);
      yield* forget();
      yield* checks(other);
      expect(calls.detail).toBe(5);
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
