import * as Schema from "effect/Schema";
import type { GitHubIssue, GitHubIssueListInput, GitHubIssueRepository } from "@t3tools/contracts";

const RawRepository = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  hasIssuesEnabled: Schema.Boolean,
  isArchived: Schema.Boolean,
});
const RawActor = Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) });
const RawLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawIssue = Schema.Struct({
  __typename: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActor)),
  createdAt: Schema.String,
  labels: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawLabel) }))),
  assignees: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawActor) }))),
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
  issueType: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
  comments: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Int }))),
});
const RawCount = Schema.Struct({ issueCount: Schema.Int });
const RawSearch = Schema.Struct({
  issueCount: Schema.Int,
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(RawIssue),
});
const RawGraph = Schema.Struct({
  data: Schema.Struct({ open: RawCount, closed: RawCount, selected: RawSearch }),
});
const decodeRawRepository = Schema.decodeUnknownSync(RawRepository);
const decodeRawGraph = Schema.decodeUnknownSync(RawGraph);
type RawIssue = typeof RawIssue.Type;

function canonicalUrl(value: string, host: string, pathname?: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.host === host &&
      (pathname === undefined || url.pathname === pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
function actor(raw: typeof RawActor.Type | null | undefined) {
  return raw?.login?.trim() ? { login: raw.login.trim() } : null;
}
function issue(raw: RawIssue, repository: GitHubIssueRepository): GitHubIssue {
  if (raw.__typename !== "Issue") throw new Error("GitHub search returned a non-issue node.");
  const expected = `/${repository.nameWithOwner}/issues/${raw.number}`;
  const url = canonicalUrl(raw.url, new URL(repository.url).host, expected);
  if (url === null)
    throw new Error("GitHub returned an issue URL outside the resolved repository.");
  const state = raw.state.toLowerCase();
  if (
    (state !== "open" && state !== "closed") ||
    raw.number < 0 ||
    (raw.comments?.totalCount ?? 0) < 0
  )
    throw new Error("GitHub returned an invalid issue.");
  return {
    number: raw.number,
    title: raw.title,
    url,
    state,
    author: actor(raw.author),
    createdAt: raw.createdAt,
    labels: (raw.labels?.nodes ?? [])
      .filter((label) => label.name.trim())
      .map((label) => ({ name: label.name.trim(), color: label.color ?? "" })),
    assignees: (raw.assignees?.nodes ?? [])
      .map(actor)
      .filter((value): value is { login: string } => value !== null),
    milestone: raw.milestone?.title.trim() ? { title: raw.milestone.title.trim() } : null,
    issueType: raw.issueType?.name.trim()
      ? { name: raw.issueType.name.trim(), color: raw.issueType.color ?? "" }
      : null,
    commentCount: raw.comments?.totalCount ?? 0,
  };
}

export function decodeRepositoryJson(raw: string, remoteHost: string): GitHubIssueRepository {
  const decoded = decodeRawRepository(JSON.parse(raw));
  const url = canonicalUrl(decoded.url, remoteHost);
  if (url === null)
    throw new Error("GitHub repository URL does not match the configured remote host.");
  const enabled = decoded.hasIssuesEnabled && !decoded.isArchived;
  return enabled
    ? {
        nameWithOwner: decoded.nameWithOwner,
        url,
        canCreateIssue: true,
        newIssueUrl: `${url}/issues/new/choose`,
      }
    : { nameWithOwner: decoded.nameWithOwner, url, canCreateIssue: false, newIssueUrl: null };
}
export function decodeIssueSearchJson(
  raw: string,
  repository: GitHubIssueRepository,
  input: GitHubIssueListInput,
) {
  const decoded = decodeRawGraph(JSON.parse(raw)).data;
  const selected = decoded.selected;
  return {
    repository,
    items: selected.nodes.map((entry) => issue(entry, repository)),
    openCount: decoded.open.issueCount,
    closedCount: decoded.closed.issueCount,
    totalCount: selected.issueCount,
    pageInfo: selected.pageInfo,
    searchCapReached: selected.issueCount > 1000,
    input,
  };
}
