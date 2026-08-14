import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const QueryValue = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const QualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Cursor = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const GitHubIssueState = Schema.Literals(["open", "closed"]);
export type GitHubIssueState = typeof GitHubIssueState.Type;
export const GitHubIssueSort = Schema.Literals(["newest", "oldest"]);
export type GitHubIssueSort = typeof GitHubIssueSort.Type;

export const GitHubIssueFilters = Schema.Struct({
  author: Schema.optional(QualifierValue),
  labels: Schema.optional(Schema.Array(QualifierValue).check(Schema.isMaxLength(10))),
  assignee: Schema.optional(QualifierValue),
  milestone: Schema.optional(QualifierValue),
  issueType: Schema.optional(QualifierValue),
});
export type GitHubIssueFilters = typeof GitHubIssueFilters.Type;

export const GitHubIssueListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  state: GitHubIssueState,
  query: Schema.optional(QueryValue),
  filters: Schema.optional(GitHubIssueFilters),
  sort: GitHubIssueSort,
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Schema.Literal(50)),
});
export type GitHubIssueListInput = typeof GitHubIssueListInput.Type;

export const GitHubIssueInvalidateInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type GitHubIssueInvalidateInput = typeof GitHubIssueInvalidateInput.Type;

export const GitHubIssueActor = Schema.Struct({ login: TrimmedNonEmptyString });
export type GitHubIssueActor = typeof GitHubIssueActor.Type;
export const GitHubIssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.String,
});
export type GitHubIssueLabel = typeof GitHubIssueLabel.Type;
export const GitHubIssueMilestone = Schema.Struct({ title: TrimmedNonEmptyString });
export type GitHubIssueMilestone = typeof GitHubIssueMilestone.Type;
export const GitHubIssueType = Schema.Struct({ name: TrimmedNonEmptyString, color: Schema.String });
export type GitHubIssueType = typeof GitHubIssueType.Type;
export const GitHubIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: TrimmedNonEmptyString,
  state: GitHubIssueState,
  author: Schema.NullOr(GitHubIssueActor),
  createdAt: IsoDateTime,
  labels: Schema.Array(GitHubIssueLabel),
  assignees: Schema.Array(GitHubIssueActor),
  milestone: Schema.NullOr(GitHubIssueMilestone),
  issueType: Schema.NullOr(GitHubIssueType),
  commentCount: NonNegativeInt,
});
export type GitHubIssue = typeof GitHubIssue.Type;

const GitHubIssueRepositoryUnavailable = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  canCreateIssue: Schema.Literal(false),
  newIssueUrl: Schema.Null,
});
const GitHubIssueRepositoryAvailable = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  canCreateIssue: Schema.Literal(true),
  newIssueUrl: TrimmedNonEmptyString,
});
export const GitHubIssueRepository = Schema.Union([
  GitHubIssueRepositoryUnavailable,
  GitHubIssueRepositoryAvailable,
]);
export type GitHubIssueRepository = typeof GitHubIssueRepository.Type;
export const GitHubIssueListResult = Schema.Struct({
  repository: GitHubIssueRepository,
  items: Schema.Array(GitHubIssue),
  openCount: NonNegativeInt,
  closedCount: NonNegativeInt,
  totalCount: NonNegativeInt,
  nextCursor: Schema.NullOr(Cursor),
  hasMore: Schema.Boolean,
  searchCapReached: Schema.Boolean,
});
export type GitHubIssueListResult = typeof GitHubIssueListResult.Type;

export const GitHubIssuesUnavailableReason = Schema.Literals([
  "not-github",
  "missing-tool",
  "unauthenticated",
]);
export type GitHubIssuesUnavailableReason = typeof GitHubIssuesUnavailableReason.Type;
export class GitHubIssuesUnavailableError extends Schema.TaggedErrorClass<GitHubIssuesUnavailableError>()(
  "GitHubIssuesUnavailableError",
  { reason: GitHubIssuesUnavailableReason, cause: Schema.optional(Schema.Defect()) },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GitHubIssuesUnavailableError)(this, { status: 503 });
  }
  override get message() {
    return `GitHub issues are unavailable: ${this.reason}.`;
  }
}
export class GitHubIssuesOperationError extends Schema.TaggedErrorClass<GitHubIssuesOperationError>()(
  "GitHubIssuesOperationError",
  {
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GitHubIssuesOperationError)(this, { status: 502 });
  }
  override get message() {
    return `GitHub issues operation ${this.operation} failed: ${this.detail}`;
  }
}
