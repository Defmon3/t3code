import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { GitHubIssueListInput, GitHubIssueRepository } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { decodeIssueSearchJson, decodeRepositoryJson } from "./GitHubIssueJson.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const REPOSITORY_CACHE_TTL = Duration.minutes(5);
const REPOSITORY_CACHE_CAPACITY = 64;
const PAGE_SIZE = 50;
const SCOPE_CONTROLLING_QUALIFIER = /^(?:repo|org|user|is|state|sort):/i;

export class GitHubIssueCliError extends Schema.TaggedErrorClass<GitHubIssueCliError>()(
  "GitHubIssueCliError",
  {
    reason: Schema.Literals(["not-github", "missing-tool", "unauthenticated", "failed"]),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export type GitHubIssueCliResult = ReturnType<typeof decodeIssueSearchJson>;
type GitHubRepositoryLocator = { readonly nameWithOwner: string; readonly host: string };

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function remoteHost(remote: string): string | null {
  try {
    return new URL(remote.replace(/^git@([^:]+):/, "ssh://$1/")).host.toLowerCase();
  } catch {
    return null;
  }
}
function repositoryNameWithOwnerFromRemote(remote: string): string | null {
  const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote);
  if (parsed !== null) return parsed;
  try {
    const path = new URL(remote.replace(/^git@([^:]+):/, "ssh://$1/")).pathname
      .replace(/\.git\/?$/i, "")
      .split("/")
      .filter(Boolean);
    return path.length === 2 ? `${path[0]}/${path[1]}` : null;
  } catch {
    return null;
  }
}
function githubRepositoryLocator(remote: string): GitHubRepositoryLocator | null {
  const host = remoteHost(remote);
  const nameWithOwner = repositoryNameWithOwnerFromRemote(remote);
  return host === null || nameWithOwner === null ? null : { nameWithOwner, host };
}
function repositoryViewArgument(locator: GitHubRepositoryLocator): string {
  return locator.host === "github.com"
    ? locator.nameWithOwner
    : `${locator.host}/${locator.nameWithOwner}`;
}
function decodeRepositoryViewJson(
  raw: string,
  locator: GitHubRepositoryLocator,
): GitHubIssueRepository {
  const repository = decodeRepositoryJson(raw, locator.host);
  if (repository.nameWithOwner.toLowerCase() !== locator.nameWithOwner.toLowerCase())
    throw new Error("GitHub repository view does not match the selected remote.");
  return repository;
}
function userSearchTerms(query: unknown): string | null {
  if (typeof query !== "string") return null;
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const character of query) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      token += character;
      escaped = true;
    } else if (character === '"') {
      token += character;
      quoted = !quoted;
    } else if (/\s/.test(character) && !quoted) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (token.length > 0) tokens.push(token);
  const preserved = tokens.filter(
    (entry) => !SCOPE_CONTROLLING_QUALIFIER.test(entry) && entry.toUpperCase() !== "OR",
  );
  return preserved.length === 0 ? null : preserved.join(" ");
}
function searchText(
  input: GitHubIssueListInput,
  repository: GitHubIssueRepository,
  state: "open" | "closed",
  sort?: string,
) {
  const filters = input.filters;
  return [
    userSearchTerms(input.query),
    `repo:${repository.nameWithOwner}`,
    "is:issue",
    `state:${state}`,
    filters?.author ? `author:${quoted(filters.author)}` : null,
    filters?.assignee ? `assignee:${quoted(filters.assignee)}` : null,
    filters?.milestone ? `milestone:${quoted(filters.milestone)}` : null,
    filters?.issueType ? `type:${quoted(filters.issueType)}` : null,
    ...(filters?.labels ?? []).map((label) => `label:${quoted(label)}`),
    sort,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}
function graphQuery(
  input: GitHubIssueListInput,
  repository: GitHubIssueRepository,
  after: string | null,
) {
  const selected = searchText(
    input,
    repository,
    input.state,
    input.sort === "oldest" ? "sort:created-asc" : "sort:created-desc",
  );
  const fields =
    "__typename ... on Issue { number title url state createdAt author { login } labels(first: 100) { nodes { name color } } assignees(first: 100) { nodes { login } } milestone { title } issueType { name color } comments { totalCount } }";
  const page = after === null ? "" : `, after: ${JSON.stringify(after)}`;
  return `query { open: search(query: ${JSON.stringify(searchText(input, repository, "open"))}, type: ISSUE, first: 1) { issueCount } closed: search(query: ${JSON.stringify(searchText(input, repository, "closed"))}, type: ISSUE, first: 1) { issueCount } selected: search(query: ${JSON.stringify(selected)}, type: ISSUE, first: ${PAGE_SIZE}${page}) { issueCount pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`;
}
function mapProcessError(error: unknown, operation: string): GitHubIssueCliError {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as {
      readonly _tag: string;
      readonly failureKind?: string;
      readonly cause?: unknown;
    };
    if (
      tagged._tag === "VcsProcessSpawnError" &&
      tagged.cause instanceof PlatformError.PlatformError &&
      tagged.cause.reason._tag === "NotFound" &&
      tagged.cause.reason.module === "ChildProcess" &&
      tagged.cause.reason.method === "spawn"
    )
      return new GitHubIssueCliError({
        reason: "missing-tool",
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    if (tagged.failureKind === "authentication")
      return new GitHubIssueCliError({
        reason: "unauthenticated",
        operation,
        detail: "GitHub CLI is not authenticated.",
        cause: error,
      });
  }
  return new GitHubIssueCliError({
    reason: "failed",
    operation,
    detail: "GitHub issue query failed.",
    cause: error,
  });
}

export class GitHubIssueCli extends Context.Service<
  GitHubIssueCli,
  {
    readonly list: (input: {
      readonly input: GitHubIssueListInput;
      readonly after: string | null;
    }) => Effect.Effect<GitHubIssueCliResult, GitHubIssueCliError>;
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/githubIssues/GitHubIssueCli") {}

export const make = Effect.gen(function* () {
  const providerRegistry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const process = yield* VcsProcess.VcsProcess;
  const resolveRepository = Effect.fn("GitHubIssueCli.resolveRepository")(function* (cwd: string) {
    const context = yield* providerRegistry.resolveHandle({ cwd }).pipe(
      Effect.map((handle) => handle.context),
      Effect.mapError(
        (error) =>
          new GitHubIssueCliError({
            reason: "failed",
            operation: "resolveProvider",
            detail: "Source control provider discovery failed.",
            cause: error,
          }),
      ),
    );
    if (context?.provider.kind !== "github")
      return yield* new GitHubIssueCliError({
        reason: "not-github",
        operation: "resolveProvider",
        detail: "This workspace is not connected to a GitHub repository.",
      });
    const locator = githubRepositoryLocator(context.remoteUrl);
    if (locator === null)
      return yield* new GitHubIssueCliError({
        reason: "not-github",
        operation: "resolveProvider",
        detail: "The selected GitHub remote has no usable repository identity.",
      });
    const output = yield* process
      .run({
        operation: "GitHubIssueCli.repoView",
        command: "gh",
        args: [
          "repo",
          "view",
          repositoryViewArgument(locator),
          "--json",
          "nameWithOwner,url,hasIssuesEnabled,isArchived",
        ],
        cwd,
        timeoutMs: 30_000,
      })
      .pipe(Effect.mapError((error) => mapProcessError(error, "repoView")));
    return yield* Effect.try({
      try: () => decodeRepositoryViewJson(output.stdout, locator),
      catch: (cause) =>
        new GitHubIssueCliError({
          reason: "failed",
          operation: "repoView",
          detail: "GitHub returned an invalid repository identity.",
          cause,
        }),
    });
  });
  const repositoryCache = yield* Cache.makeWith<string, GitHubIssueRepository, GitHubIssueCliError>(
    resolveRepository,
    {
      capacity: REPOSITORY_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? REPOSITORY_CACHE_TTL : Duration.zero),
    },
  );
  return GitHubIssueCli.of({
    list: ({ input, after }) =>
      Cache.get(repositoryCache, input.cwd).pipe(
        Effect.flatMap((repository) =>
          process
            .run({
              operation: "GitHubIssueCli.search",
              command: "gh",
              args: [
                "api",
                "graphql",
                "--hostname",
                new URL(repository.url).host,
                "-f",
                `query=${graphQuery(input, repository, after)}`,
              ],
              cwd: input.cwd,
              timeoutMs: 30_000,
            })
            .pipe(
              Effect.mapError((error) => mapProcessError(error, "list")),
              Effect.flatMap((output) =>
                Effect.try({
                  try: () => decodeIssueSearchJson(output.stdout, repository, input),
                  catch: (cause) =>
                    new GitHubIssueCliError({
                      reason: "failed",
                      operation: "list",
                      detail: "GitHub returned an invalid issue response.",
                      cause,
                    }),
                }),
              ),
            ),
        ),
      ),
    invalidate: (cwd) => Cache.invalidate(repositoryCache, cwd),
  });
});
export const layer = Layer.effect(GitHubIssueCli, make);
export {
  decodeRepositoryViewJson,
  githubRepositoryLocator,
  graphQuery,
  mapProcessError,
  repositoryViewArgument,
  searchText,
};
