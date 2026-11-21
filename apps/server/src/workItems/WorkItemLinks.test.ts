import { expect, it } from "@effect/vitest";
import {
  IssueTrackerKind,
  ProjectId,
  PullRequestOperationError,
  type IssueDetail,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as IssueService from "../issue/IssueService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "./WorkItemLinks.ts";

const projectId = ProjectId.make("project-1");
const tracker = IssueTrackerKind.make("linear");
const issueRef = { projectId, tracker, host: "linear.app", scope: "ENG", key: "ENG-123" };
const pullRequestRef = { projectId, host: "github.com", repository: "team/repo", number: 7 };
const issueUrl = "https://linear.app/team/issue/ENG-123/first-title?ref=home#activity";
const pullRequestUrl = "https://github.com/team/repo/pull/7";

it.effect("saves one pair from both sides, preserving the tracker key through a title change", () =>
  Effect.gen(function* () {
    const currentIssueUrl = yield* Ref.make(issueUrl);
    const issueDetail = Ref.get(currentIssueUrl).pipe(
      Effect.map(
        (url) =>
          ({
            tracker,
            displayKey: "ENG-123",
            title: "Issue",
            url,
          }) as IssueDetail,
      ),
    );
    const dependencies = Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(IssueService.IssueService)({
        detail: () => issueDetail,
        resolveUrl: () =>
          issueDetail.pipe(Effect.map((issue) => ({ ...issueRef, writable: true, issue }))),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        withRoutingCredential: (reference, operation) =>
          reference.expectedAccountId === "denied"
            ? Effect.fail(
                new PullRequestOperationError({ operation: "routing", detail: "Account changed." }),
              )
            : operation,
        detail: () =>
          Effect.succeed({
            provider: "github",
            repository: "team/repo",
            number: 7,
            title: "Pull request",
            url: pullRequestUrl,
          } as PullRequestDetail),
      }),
    );

    yield* Effect.gen(function* () {
      const links = yield* WorkItemLinks.WorkItemLinks;
      const source = { provider: "linear", url: issueUrl };
      const refused = yield* links
        .link({
          issue: issueRef,
          pullRequest: { ...pullRequestRef, expectedAccountId: "denied" },
        })
        .pipe(Effect.flip);
      expect(refused.operation).toBe("link");
      expect((yield* links.list({ source })).links).toEqual([]);

      const first = yield* links.link({
        issue: { projectId, url: issueUrl },
        pullRequest: pullRequestRef,
      });
      yield* Ref.set(currentIssueUrl, "https://linear.app/team/issue/ENG-123/new-title");
      const second = yield* links.link({ issue: issueRef, pullRequest: pullRequestRef });
      expect(first.issue).toMatchObject({
        url: "https://linear.app/team/issue/ENG-123",
        displayKey: "ENG-123",
      });
      expect(second).toEqual(first);
      expect(yield* links.list({ source })).toEqual({ links: [first], truncated: false });
      expect(yield* links.list({ source: { provider: "github", url: pullRequestUrl } })).toEqual({
        links: [first],
        truncated: false,
      });
      expect(
        (yield* links.list({
          source: {
            provider: "linear",
            url: "https://linear.example/team/issue/ENG-123",
          },
        })).links,
      ).toEqual([]);

      yield* links.unlink(first);
      yield* links.unlink(first);
      expect((yield* links.list({ source })).links).toEqual([]);
    }).pipe(Effect.provide(WorkItemLinks.layer.pipe(Layer.provide(dependencies))));
  }),
);
