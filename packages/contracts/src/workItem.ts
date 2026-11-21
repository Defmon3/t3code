import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueRef } from "./issue.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const WorkItemLinkKey = Schema.Struct({
  provider: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type WorkItemLinkKey = typeof WorkItemLinkKey.Type;

export function normalizeWorkItemLinkKey(input: WorkItemLinkKey): WorkItemLinkKey {
  try {
    const url = new URL(input.url);
    url.search = "";
    url.hash = "";
    if (input.provider.toLowerCase() === "linear") {
      const match = /^(.*\/issue\/[^/]+)(?:\/.*)?$/u.exec(url.pathname);
      if (match?.[1]) url.pathname = match[1];
    }
    return { provider: input.provider, url: url.toString() };
  } catch {
    return input;
  }
}

const WorkItemLinkedPullRequest = Schema.Struct({
  ...WorkItemLinkKey.fields,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
});

export const WorkItemLink = Schema.Struct({
  issue: Schema.Struct({
    ...WorkItemLinkKey.fields,
    displayKey: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
  }),
  pullRequest: WorkItemLinkedPullRequest,
});
export type WorkItemLink = typeof WorkItemLink.Type;

export const WorkItemLinksInput = Schema.Struct({ source: WorkItemLinkKey });
export type WorkItemLinksInput = typeof WorkItemLinksInput.Type;

export const WorkItemLinksResult = Schema.Struct({
  links: Schema.Array(WorkItemLink).check(Schema.isMaxLength(100)),
  truncated: Schema.Boolean,
});
export type WorkItemLinksResult = typeof WorkItemLinksResult.Type;

export const WorkItemLinkInput = Schema.Struct({
  issue: Schema.Union([
    IssueRef,
    Schema.Struct({ projectId: ProjectId, url: TrimmedNonEmptyString }),
  ]),
  pullRequest: PullRequestRef,
});
export type WorkItemLinkInput = typeof WorkItemLinkInput.Type;

export const WorkItemUnlinkInput = Schema.Struct({
  issue: WorkItemLinkKey,
  pullRequest: WorkItemLinkKey,
});
export type WorkItemUnlinkInput = typeof WorkItemUnlinkInput.Type;

export class WorkItemLinkError extends Schema.TaggedError<WorkItemLinkError>()(
  "WorkItemLinkError",
  {
    operation: Schema.Literals(["list", "link", "unlink"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work item link ${this.operation} failed: ${this.detail}`;
  }
}

export const WorkItemTaskSourceRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("issue"), reference: IssueRef }),
  Schema.Struct({ kind: Schema.Literal("pull-request"), reference: PullRequestRef }),
]);
export type WorkItemTaskSourceRef = typeof WorkItemTaskSourceRef.Type;

export const WorkItemMatchRelationship = Schema.Literals(["related", "duplicate"]);
export type WorkItemMatchRelationship = typeof WorkItemMatchRelationship.Type;

export const WorkItemMatchInput = Schema.Struct({
  relationship: WorkItemMatchRelationship,
  source: WorkItemTaskSourceRef,
});
export type WorkItemMatchInput = typeof WorkItemMatchInput.Type;

export const WorkItemMatch = Schema.Struct({
  source: WorkItemTaskSourceRef,
  provider: TrimmedNonEmptyString,
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  confidence: Schema.Literals(["high", "medium"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type WorkItemMatch = typeof WorkItemMatch.Type;

export const WorkItemMatchResult = Schema.Struct({
  matches: Schema.Array(WorkItemMatch).check(Schema.isMaxLength(5)),
});
export type WorkItemMatchResult = typeof WorkItemMatchResult.Type;

export class WorkItemMatchError extends Schema.TaggedError<WorkItemMatchError>()(
  "WorkItemMatchError",
  {
    operation: Schema.Literals(["read-source", "list-candidates", "read-candidate", "generate"]),
    source: WorkItemTaskSourceRef,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work item matching failed during ${this.operation}: ${this.detail}`;
  }
}
