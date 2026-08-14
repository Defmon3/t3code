import { assert, it } from "@effect/vitest";
import { decodeIssueSearchJson, decodeRepositoryJson } from "./GitHubIssueJson.ts";
const repository = {
  nameWithOwner: "o/r",
  url: "https://github.com/o/r",
  canCreateIssue: false as const,
  newIssueUrl: null,
};
it("derives a creation link only for enabled, non-archived repositories", () => {
  const result = decodeRepositoryJson(
    JSON.stringify({
      nameWithOwner: "o/r",
      url: "https://github.com/o/r",
      hasIssuesEnabled: true,
      isArchived: false,
    }),
    "github.com",
  );
  assert.strictEqual(result.newIssueUrl, "https://github.com/o/r/issues/new/choose");
});
it("rejects a repository on another host", () =>
  assert.throws(() =>
    decodeRepositoryJson(
      JSON.stringify({
        nameWithOwner: "o/r",
        url: "https://evil.example/o/r",
        hasIssuesEnabled: true,
        isArchived: false,
      }),
      "github.com",
    ),
  ));

it("decodes count searches that return only issueCount", () => {
  const result = decodeIssueSearchJson(
    JSON.stringify({
      data: {
        open: { issueCount: 3 },
        closed: { issueCount: 2 },
        selected: {
          issueCount: 3,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              __typename: "Issue",
              number: 1,
              title: "Issue",
              url: "https://github.com/o/r/issues/1",
              state: "OPEN",
              createdAt: "2026-08-14T00:00:00Z",
              author: { login: "octo" },
              labels: { nodes: [{ name: "bug", color: "ff0000" }] },
              assignees: { nodes: [{ login: "octocat" }] },
              milestone: { title: "v1" },
              issueType: { name: "Bug", color: "ff0000" },
              comments: { totalCount: 1 },
            },
          ],
        },
      },
    }),
    repository,
    { cwd: "x", state: "open", sort: "newest" },
  );
  assert.strictEqual(result.openCount, 3);
  assert.strictEqual(result.closedCount, 2);
  assert.strictEqual(result.items[0]?.number, 1);
});
