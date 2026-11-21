import {
  WorkItemMatchError,
  normalizeWorkItemLinkKey,
  type IssueDetail,
  type IssueError,
  type IssueListEntry,
  type PullRequestDetail,
  type PullRequestListEntry,
  type WorkItemMatchInput,
  type WorkItemMatchResult,
  type WorkItemTaskSourceRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkItemLinks from "./WorkItemLinks.ts";

const issueItem = (entry: IssueListEntry) => ({
  source: {
    kind: "issue",
    reference: {
      projectId: entry.projectId,
      tracker: entry.tracker,
      host: entry.host,
      scope: entry.scope,
      key: entry.key,
    },
  } satisfies WorkItemTaskSourceRef,
  provider: entry.tracker,
  repository: entry.scope,
  displayKey: entry.displayKey,
  title: entry.title,
  url: entry.url,
});

const pullRequestItem = (entry: PullRequestListEntry | PullRequestDetail) => ({
  source: {
    kind: "pull-request",
    reference: {
      projectId: entry.projectId,
      host: new URL(entry.url).host,
      repository: entry.repository,
      number: entry.number,
    },
  } satisfies WorkItemTaskSourceRef,
  provider: entry.provider,
  repository: entry.repository,
  displayKey: `#${entry.number}`,
  title: entry.title,
  url: entry.url,
});

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []);

const normalizeUrl = (provider: string, url: string) =>
  normalizeWorkItemLinkKey({ provider, url }).url;

export class WorkItemMatches extends Context.Service<
  WorkItemMatches,
  {
    readonly find: (
      input: WorkItemMatchInput,
    ) => Effect.Effect<WorkItemMatchResult, WorkItemMatchError>;
  }
>()("t3/workItems/WorkItemMatches") {}

const make = Effect.gen(function* () {
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const links = yield* WorkItemLinks.WorkItemLinks;

  const read = (
    source: WorkItemTaskSourceRef,
  ): Effect.Effect<
    IssueDetail | PullRequestDetail,
    IssueError | PullRequestService.PullRequestError
  > =>
    source.kind === "issue"
      ? issues.detail(source.reference)
      : pullRequests.withRoutingCredential(source.reference, pullRequests.detail(source.reference));

  const find = Effect.fn("WorkItemMatches.find")(function* ({
    source,
    relationship,
  }: WorkItemMatchInput) {
    const failure =
      (operation: WorkItemMatchError["operation"], detail: string) => (cause: unknown) =>
        new WorkItemMatchError({ operation, source, detail, cause });
    const detail = yield* read(source).pipe(
      Effect.mapError(failure("read-source", "Could not read the source work item.")),
    );
    const item = "tracker" in detail ? issueItem(detail) : pullRequestItem(detail);
    const projectId = source.reference.projectId;
    const candidateKind =
      relationship === "duplicate"
        ? source.kind
        : source.kind === "issue"
          ? "pull-request"
          : "issue";
    const state = relationship === "duplicate" ? "all" : "open";
    const readCandidates: Effect.Effect<
      {
        readonly entries: readonly (
          | ReturnType<typeof issueItem>
          | ReturnType<typeof pullRequestItem>
        )[];
        readonly errors: readonly unknown[];
      },
      IssueError | PullRequestService.PullRequestError
    > =
      candidateKind === "issue"
        ? issues
            .list({ projectId, state, limit: 50 })
            .pipe(
              Effect.map(({ entries, errors }) => ({ entries: entries.map(issueItem), errors })),
            )
        : pullRequests.list({ projectId, state, limit: 50 }).pipe(
            Effect.map(({ entries, errors }) => ({
              entries: entries.map(pullRequestItem),
              errors,
            })),
          );
    const listed = yield* readCandidates.pipe(
      Effect.mapError(failure("list-candidates", "Could not list candidate work items.")),
    );
    if (listed.entries.length === 0 && listed.errors.length > 0) {
      return yield* failure(
        "list-candidates",
        "Could not list candidate work items.",
      )(listed.errors);
    }

    const seen = new Set([normalizeUrl(item.provider, item.url)]);
    if (relationship === "related") {
      const saved = yield* links
        .list({ source: item })
        .pipe(Effect.mapError(failure("list-candidates", "Could not read saved work item links.")));
      for (const link of saved.links) {
        const linked = candidateKind === "issue" ? link.issue : link.pullRequest;
        seen.add(normalizeUrl(linked.provider, linked.url));
      }
      const reported =
        "tracker" in detail ? detail.linkedPullRequests : (detail.linkedIssues ?? []);
      for (const linked of reported) seen.add(normalizeUrl(item.provider, linked.url));
    }
    const sourceWords = words(`${item.title} ${detail.body}`);
    const candidates = listed.entries
      .slice(0, 50)
      .flatMap((candidate) => {
        const url = normalizeUrl(candidate.provider, candidate.url);
        if (seen.has(url)) return [];
        seen.add(url);
        return [
          {
            candidate,
            score: [...words(candidate.title)].filter((word) => sourceWords.has(word)).length,
          },
        ];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ candidate }) => candidate);
    if (candidates.length === 0) return { matches: [] };

    const candidateDetails = yield* Effect.forEach(
      candidates,
      (candidate) =>
        read(candidate.source).pipe(
          Effect.map((result) => ({
            ...candidate,
            body: result.body,
            kind: candidate.source.kind,
          })),
          Effect.mapError(failure("read-candidate", `Could not read ${candidate.displayKey}.`)),
        ),
      { concurrency: 4 },
    );
    const project = yield* projects
      .getShell(projectId)
      .pipe(Effect.mapError(failure("generate", "Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* failure("generate", "The project is no longer available.")(projectId);
    }
    const generated = yield* settings.getSettings.pipe(
      Effect.flatMap((settings) =>
        generation.findWorkItemMatches({
          cwd: project.value.workspaceRoot,
          relationship,
          source: { ...item, kind: source.kind, body: detail.body },
          candidates: candidateDetails,
          modelSelection: settings.textGenerationModelSelection,
        }),
      ),
      Effect.mapError(failure("generate", "Could not generate work item matches.")),
    );
    const returned = new Set<number>();
    return {
      matches: generated.matches
        .flatMap(({ candidate, confidence, reason }) => {
          const match = candidates[candidate - 1];
          const explanation = reason.trim().slice(0, 300);
          if (match === undefined || returned.has(candidate) || explanation === "") return [];
          returned.add(candidate);
          const { source, provider, displayKey, title, url } = match;
          return [{ source, provider, displayKey, title, url, confidence, reason: explanation }];
        })
        .slice(0, 5),
    };
  });

  return WorkItemMatches.of({ find });
});

export const layer = Layer.effect(WorkItemMatches, make);
