import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type {
  IssueLink,
  PullRequestCapabilities,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  CITED_ISSUE_REFERENCES_MAX,
  mergeIssueLinks,
  parseIssueReferences,
  unlinkedIssueReferences,
} from "@t3tools/source-control-core/server/issueReferences";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  // GitLab has no merge-target-into-source operation.
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  // GitLab's viewed marks live in browser-local storage.
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // GitLab has no requested-changes verdict.
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
  unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
};

/**
 * The actions `user.can_merge` answers for. Rebasing writes to the source branch rather than to
 * the target, so it is not literally the same permission — but GitLab reports nothing narrower,
 * and someone it will not let land this change has no business rewriting its branch either.
 */
const MERGE_ACTIONS: ReadonlySet<string> = new Set([
  "merge",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
]);

/** Authors may close/reopen/change draft state regardless of role; REST omits authorship. */
export function gitLabViewerPermissions(input: {
  readonly viewerCanMerge: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter(
      (action) => !MERGE_ACTIONS.has(action) || input.viewerCanMerge,
    ),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
    ...(input.viewerCanMerge ? { updateMethods: CAPABILITIES.updateMethods } : {}),
  };
}

function gitLabProviderFailure(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitLabCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitLabCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitLabCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "GitLabMergeRequestNotFoundError") return { reason: "not-found" };
  return { reason: "failed" };
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitlab"),
      operation,
      ...gitLabProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  // Optional endpoints may lose part of the activity, but an unusable CLI or account must
  // reach the caller so it can report authentication failures and pause a throttled host.
  const recoverRead = <A>(
    read: Effect.Effect<A, GitLabPullRequestCli.GitLabPullRequestCliError>,
    fallback: A,
  ) =>
    read.pipe(
      Effect.catch((error) => {
        const { reason } = gitLabProviderFailure(error);
        return reason === "rate-limited" ||
          reason === "unauthenticated" ||
          reason === "missing-tool"
          ? Effect.fail(error)
          : Effect.succeed(fallback);
      }),
    );

  const citedIssues = (
    input: { readonly cwd: string; readonly repository: string; readonly host: string },
    mergeRequest: { readonly title: string; readonly body: string },
    hostLinks: ReadonlyArray<IssueLink>,
  ): Effect.Effect<
    { readonly links: ReadonlyArray<IssueLink>; readonly truncated: boolean },
    GitLabPullRequestCli.GitLabPullRequestCliError
  > => {
    const project = input.repository.trim().toLowerCase();
    const numbers = unlinkedIssueReferences(
      parseIssueReferences(
        {
          kind: "gitlab",
          host: input.host,
          repository: input.repository,
          title: mergeRequest.title,
          body: mergeRequest.body,
        },
        (reference) => reference.repository.trim().toLowerCase() === project,
      ),
      hostLinks,
    ).map((reference) => reference.number);
    return numbers.length === 0
      ? Effect.succeed({ links: [], truncated: false })
      : recoverRead(
          cli
            .listCitedIssues({
              cwd: input.cwd,
              repository: input.repository,
              numbers: numbers.slice(0, CITED_ISSUE_REFERENCES_MAX),
            })
            .pipe(
              Effect.map((links) => ({
                links,
                truncated: numbers.length > CITED_ISSUE_REFERENCES_MAX,
              })),
            ),
          { links: [], truncated: true },
        );
  };

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("gitlab"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,

    getViewer: (input) =>
      cli.getViewerUsername({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listMergeRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({ ...batch, continues: true })),
        ),

    getChangeRequestChecks: (input) =>
      cli.getMergeRequestDetail(input).pipe(
        Effect.map(({ state, checks }) => ({ state, checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    // Merge settings only affect the detail panel's actions.
    getChangeRequestPreview: (input) =>
      cli.getMergeRequestDetail(input).pipe(Effect.mapError(fail("getChangeRequestPreview"))),

    getChangeRequestSummary: (input) =>
      cli.getMergeRequestDetail(input).pipe(Effect.mapError(fail("getChangeRequestSummary"))),

    getChangeRequest: (input) => {
      const linkedIssues = recoverRead(cli.listLinkedIssues(input), {
        links: [] as ReadonlyArray<IssueLink>,
        truncated: true,
      });
      return Effect.all(
        [
          cli.getMergeRequestDetail(input),
          cli.getProjectMergeCapabilities({ cwd: input.cwd, repository: input.repository }),
          // A section of links is worth less than the merge request it hangs off, so a project
          // whose issues this account cannot read leaves it empty rather than failing the detail.
          linkedIssues,
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.flatMap(([mergeRequest, mergeCapabilities, linkedIssues]) =>
          citedIssues(input, mergeRequest, linkedIssues.links).pipe(
            Effect.map((cited): ProviderChangeRequestDetail => ({
              ...mergeRequest,
              mergeCapabilities,
              viewerPermissions: gitLabViewerPermissions(mergeRequest),
              linkedIssues: mergeIssueLinks(linkedIssues.links, cited.links),
              linkedIssuesTruncated: linkedIssues.truncated || cited.truncated,
              // A GitLab too old to count the divergence says nothing here rather than "up to
              // date": the banner is worth missing, and a wrong all-clear is not worth showing.
              baseComparison:
                mergeRequest.divergedCommits === undefined
                  ? "unknown"
                  : mergeRequest.divergedCommits > 0
                    ? "behind"
                    : "up-to-date",
              ...(mergeRequest.divergedCommits === undefined
                ? {}
                : { behindBy: mergeRequest.divergedCommits }),
            })),
          ),
        ),
        Effect.mapError(fail("getChangeRequest")),
      );
    },

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          recoverRead(cli.listNotes(input), { comments: [], truncated: true }),
          recoverRead(cli.listCommits(input), []),
          recoverRead(cli.listDiscussions(input), { threads: [], truncated: true }),
          recoverRead(cli.listReactions(input), {
            reactions: [] as ReadonlyArray<PullRequestReaction>,
            reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
          }),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([notes, commits, discussions, awards]): ProviderChangeRequestActivity => ({
          reactions: awards.reactions,
          comments: notes.comments.map((comment) => ({
            ...comment,
            reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          })),
          commentCount: notes.comments.length,
          commentsTruncated: notes.truncated || discussions.truncated,
          reviewThreads: discussions.threads.map((thread) => ({
            ...thread,
            comments: thread.comments.map((comment) => ({
              ...comment,
              reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
            })),
          })),
          commits,
        })),
      ),

    getViewerPermissions: (input) =>
      cli
        .getMergeRequestDetail(input)
        .pipe(Effect.mapError(fail("getViewerPermissions")), Effect.map(gitLabViewerPermissions)),

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getMergeRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    getFileRevisions: (input) =>
      cli.getFileRevisions(input).pipe(
        Effect.mapError(fail("getFileRevisions")),
        Effect.map((revisions) => ({ revisions })),
      ),

    // MR reviewers are users; groups belong to approval rules.
    listReviewerCandidates: (input) =>
      cli
        .listReviewerCandidates({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    listRepositoryLabels: (input) =>
      cli
        .listProjectLabels({ cwd: input.cwd, repository: input.repository, search: input.query })
        .pipe(Effect.mapError(fail("listRepositoryLabels"))),

    searchRepositoryAuthors: (input) =>
      cli
        .listProjectUsers({ cwd: input.cwd, repository: input.repository, search: input.query })
        .pipe(Effect.mapError(fail("searchRepositoryAuthors"))),

    setReviewerRequest: (input) =>
      cli
        .setReviewerRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    runAction: (input) =>
      cli
        .runMergeRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updateMergeRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) => cli.commentOnMergeRequest(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) =>
      cli
        .updateNote({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          noteId: input.commentId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) => cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToDiscussion({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setReaction: (input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { noteId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),

    setThreadResolution: (input) =>
      cli
        .setDiscussionResolution({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
