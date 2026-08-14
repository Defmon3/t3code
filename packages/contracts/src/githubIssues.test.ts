import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { GitHubIssueListInput, GitHubIssueListResult } from "./githubIssues.ts";

const decodeGitHubIssueListInput = Schema.decodeUnknownSync(GitHubIssueListInput);
const decodeGitHubIssueListResult = Schema.decodeUnknownSync(GitHubIssueListResult);

it("decodes nullable issue metadata with positive issue numbers and zero counts", () => {
  const decoded = decodeGitHubIssueListResult({
    repository: {
      nameWithOwner: "o/r",
      url: "https://github.com/o/r",
      canCreateIssue: false,
      newIssueUrl: null,
    },
    items: [
      {
        number: 1,
        title: "x",
        url: "https://github.com/o/r/issues/1",
        state: "open",
        author: null,
        createdAt: "2026-01-01T00:00:00Z",
        labels: [],
        assignees: [],
        milestone: null,
        issueType: null,
        commentCount: 0,
      },
    ],
    openCount: 0,
    closedCount: 0,
    totalCount: 0,
    nextCursor: null,
    hasMore: false,
    searchCapReached: false,
  });
  assert.strictEqual(decoded.items[0]?.commentCount, 0);
});
it("rejects issue number zero", () => {
  assert.throws(() =>
    decodeGitHubIssueListResult({
      repository: {
        nameWithOwner: "o/r",
        url: "https://github.com/o/r",
        canCreateIssue: false,
        newIssueUrl: null,
      },
      items: [
        {
          number: 0,
          title: "x",
          url: "https://github.com/o/r/issues/0",
          state: "open",
          author: null,
          createdAt: "2026-01-01T00:00:00Z",
          labels: [],
          assignees: [],
          milestone: null,
          issueType: null,
          commentCount: 0,
        },
      ],
      openCount: 0,
      closedCount: 0,
      totalCount: 0,
      nextCursor: null,
      hasMore: false,
      searchCapReached: false,
    }),
  );
});
it("rejects unbounded issue query input", () => {
  assert.throws(() =>
    decodeGitHubIssueListInput({ cwd: "x", state: "open", sort: "newest", query: "x".repeat(257) }),
  );
});
