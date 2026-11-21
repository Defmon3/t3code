import { expect, it } from "@effect/vitest";
import {
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueListEntry,
  type PullRequestDetail,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkItemLinks from "./WorkItemLinks.ts";
import * as WorkItemMatches from "./WorkItemMatches.ts";

const projectId = ProjectId.make("project");
const createdAt = "2026-01-01T00:00:00Z";
const issue = (key: string, title: string): IssueListEntry => ({
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "ENG",
  key,
  url: `https://linear.app/acme/issue/${key}/some-title`,
  displayKey: key,
  projectId,
  projectTitle: "Repository",
  title,
  state: { category: "open", name: "Open" },
  author: null,
  createdAt,
  updatedAt: createdAt,
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
});
const source = issue("ENG-11", "Repair login state");
const duplicate = issue("ENG-12", "Repair login cache");
const pullRequest = (number: number, title: string): PullRequestListEntry => ({
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "acme/web",
  url: `https://github.com/acme/web/pull/${number}`,
  number,
  title,
  projectId,
  projectTitle: "Repository",
  state: "open",
  author: null,
  createdAt,
  updatedAt: createdAt,
  headBranch: "topic",
  baseBranch: "main",
  isDraft: false,
  mergeability: "unknown",
  additions: 0,
  deletions: 0,
  viewerReviewRequested: false,
  labels: [],
});
const saved = pullRequest(19, "Repair login state");
const candidate = pullRequest(20, "Repair login cache");

it.effect.each([
  { relationship: "related", displayKey: "#20" },
  { relationship: "duplicate", displayKey: "ENG-12" },
] as const)(
  "suggests $relationship items by their current tracker references",
  ({ relationship, displayKey }) =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        Layer.mock(IssueService.IssueService)({
          detail: ({ key }) =>
            Effect.succeed({
              ...(key === source.key ? source : duplicate),
              body: "Restore login after session changes.",
              linkedPullRequests: [],
              writable: true,
              viewer: null,
              states: [],
              comments: [],
              commentsCursor: null,
              events: [],
              capabilities: {
                create: true,
                edit: true,
                comment: true,
                labels: true,
                assignees: true,
                reactions: false,
                templates: false,
                linkedPullRequests: true,
                events: true,
                search: true,
              },
              viewerPermissions: {
                setState: true,
                comment: true,
                edit: true,
                labels: true,
                assignees: true,
              },
            }),
          list: () =>
            Effect.succeed({
              entries: [source, duplicate],
              errors: [],
              nextCursors: {},
              trackers: [],
              viewers: {},
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.succeed({
              provider: candidate.provider,
              projectId: candidate.projectId,
              number: candidate.number,
              url: candidate.url,
              repository: candidate.repository,
              title: candidate.title,
              body: "Fix login.",
            } as PullRequestDetail),
          withRoutingCredential: (_, operation) => operation,
          list: () =>
            Effect.succeed({
              entries: [saved, candidate],
              errors: [],
              nextCursors: {},
              viewers: {},
              providers: [],
              truncated: false,
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Repository",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
            }),
        }),
        Layer.mock(WorkItemLinks.WorkItemLinks)({
          list: () =>
            Effect.succeed({
              links: [{ issue: { ...source, provider: "linear" }, pullRequest: saved }],
              truncated: false,
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(TextGeneration.TextGeneration)({
          findWorkItemMatches: () =>
            Effect.succeed({
              matches: [
                { candidate: 1, confidence: "high", reason: "  Same login bug.  " },
                { candidate: 1, confidence: "medium", reason: "Duplicate output" },
                { candidate: 2, confidence: "medium", reason: "Unknown candidate" },
              ],
            }),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const matches = yield* WorkItemMatches.WorkItemMatches;
        return yield* matches.find({
          source: { kind: "issue", reference: source },
          relationship,
        });
      }).pipe(Effect.provide(WorkItemMatches.layer.pipe(Layer.provide(dependencies))));
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        displayKey,
        reason: "Same login bug.",
        source:
          relationship === "related"
            ? { kind: "pull-request", reference: { host: "github.com", number: 20 } }
            : {
                kind: "issue",
                reference: { tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-12" },
              },
      });
    }),
);
