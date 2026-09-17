import * as Schema from "effect/Schema";

import {
  ISSUE_LIST_QUERY_MAX_LENGTH,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

const BoundedQuery = Schema.String.check(Schema.isMaxLength(ISSUE_LIST_QUERY_MAX_LENGTH));
const BoundedLabel = Schema.String.check(Schema.isMaxLength(200));
export const IssuePanelPreferencesSchema = Schema.Struct({
  query: BoundedQuery,
  state: IssueListState,
  involvement: IssueInvolvement,
  label: Schema.optional(BoundedLabel),
  sort: IssueListSort,
  order: IssueListOrder,
});
export type IssuePanelPreferences = typeof IssuePanelPreferencesSchema.Type;

export const DEFAULT_ISSUE_PANEL_PREFERENCES: IssuePanelPreferences = {
  query: "",
  state: "open",
  involvement: "all",
  sort: "updated",
  order: "desc",
};

export function issuePanelPreferencesKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `t3.issues.panel.preferences:${JSON.stringify([environmentId, projectId])}`;
}
