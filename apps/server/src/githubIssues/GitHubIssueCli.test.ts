import { assert, it } from "@effect/vitest";
import * as PlatformError from "effect/PlatformError";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import {
  decodeRepositoryViewJson,
  githubRepositoryLocator,
  graphQuery,
  mapProcessError,
  repositoryViewArgument,
  searchText,
} from "./GitHubIssueCli.ts";
const repository = {
  nameWithOwner: "owner/repo",
  url: "https://github.com/owner/repo",
  canCreateIssue: false as const,
  newIssueUrl: null,
};
it("builds an issue-only query with quoted filters and oldest sort", () => {
  const query = graphQuery(
    {
      cwd: "x",
      state: "open",
      sort: "oldest",
      query: "two words",
      filters: { labels: ["needs review"], author: "octo" },
    },
    repository,
    null,
  );
  assert.include(query, "is:issue");
  assert.notInclude(query, "is:pr");
  assert.include(query, "sort:created-asc");
  assert.include(query, 'label:\\"needs review\\"');
});

it("selects issue fields through the SearchResultItem Issue fragment", () => {
  const query = graphQuery({ cwd: "x", state: "open", sort: "newest" }, repository, null);
  assert.include(query, "nodes { __typename ... on Issue { number");
  assert.notInclude(query, "nodes { __typename number");
});

it("keeps user search terms and quotes while appending authoritative scope", () => {
  const search = searchText(
    {
      cwd: "x",
      state: "open",
      sort: "newest",
      query:
        'repo:other/repo is:pr state:closed sort:oldest label:bug author:octo two words OR "OR" "exact phrase"',
    },
    repository,
    "open",
    "sort:created-desc",
  );
  assert.strictEqual(
    search,
    'label:bug author:octo two words "OR" "exact phrase" repo:owner/repo is:issue state:open sort:created-desc',
  );
});

it("keeps qualifier-like text inside phrases while removing complete scope tokens", () => {
  const search = searchText(
    {
      cwd: "x",
      state: "open",
      sort: "newest",
      query: '"foo repo:other" repo:"other repo" "escaped \\"repo:other\\""  ',
    },
    repository,
    "open",
  );
  assert.strictEqual(
    search,
    '"foo repo:other" "escaped \\"repo:other\\"" repo:owner/repo is:issue state:open',
  );
});

it("resolves public and registry-identified enterprise remotes to explicit repository locators", () => {
  assert.deepStrictEqual(githubRepositoryLocator("https://github.com/owner/repo.git"), {
    nameWithOwner: "owner/repo",
    host: "github.com",
  });
  assert.deepStrictEqual(githubRepositoryLocator("git@code.example.test:owner/repo.git"), {
    nameWithOwner: "owner/repo",
    host: "code.example.test",
  });
  assert.strictEqual(
    repositoryViewArgument({ nameWithOwner: "owner/repo", host: "github.com" }),
    "owner/repo",
  );
  assert.strictEqual(
    repositoryViewArgument({ nameWithOwner: "owner/repo", host: "github.example.test" }),
    "github.example.test/owner/repo",
  );
});

it("rejects a repository view response for a different remote repository", () => {
  assert.throws(() =>
    decodeRepositoryViewJson(
      JSON.stringify({
        nameWithOwner: "other/repo",
        url: "https://github.com/other/repo",
        hasIssuesEnabled: true,
        isArchived: false,
      }),
      { nameWithOwner: "owner/repo", host: "github.com" },
    ),
  );
  assert.doesNotThrow(() =>
    decodeRepositoryViewJson(
      JSON.stringify({
        nameWithOwner: "OWNER/REPO",
        url: "https://github.com/OWNER/REPO",
        hasIssuesEnabled: true,
        isArchived: false,
      }),
      { nameWithOwner: "owner/repo", host: "github.com" },
    ),
  );
});

it("classifies only a missing gh spawn as a missing tool", () => {
  const missingTool = new VcsProcessSpawnError({
    operation: "GitHubIssueCli.search",
    command: "gh",
    cwd: "x",
    cause: PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "gh",
    }),
  });
  const missingCwd = new VcsProcessSpawnError({
    operation: "GitHubIssueCli.search",
    command: "gh",
    cwd: "x",
    cause: PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "access",
      pathOrDescriptor: "x",
    }),
  });
  assert.strictEqual(mapProcessError(missingTool, "search").reason, "missing-tool");
  assert.strictEqual(mapProcessError(missingCwd, "search").reason, "failed");
});
