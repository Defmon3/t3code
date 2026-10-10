import * as Schema from "effect/Schema";

import {
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

const BoundedLabel = Schema.String.check(Schema.isMaxLength(200));
const MAX_ISSUE_SEARCH_QUERY_LENGTH = 200;

export function normalizeIssueSearchQuery(query: string): string {
  return query.trim().slice(0, MAX_ISSUE_SEARCH_QUERY_LENGTH);
}

export const IssuePanelPreferencesSchema = Schema.Struct({
  state: IssueListState,
  involvement: IssueInvolvement,
  label: Schema.optional(BoundedLabel),
  sort: IssueListSort,
  order: IssueListOrder,
});
export type IssuePanelPreferences = typeof IssuePanelPreferencesSchema.Type;

export interface IssuePanelPreferencePatch {
  readonly state?: IssueListState | undefined;
  readonly involvement?: IssueInvolvement | undefined;
  readonly label?: string | undefined;
  readonly sort?: IssueListSort | undefined;
  readonly order?: IssueListOrder | undefined;
}

export const DEFAULT_ISSUE_PANEL_PREFERENCES: IssuePanelPreferences = {
  state: "open",
  involvement: "all",
  sort: "updated",
  order: "desc",
};

export function resolveIssuePanelPreferences(
  preferences: IssuePanelPreferences,
  overrides: IssuePanelPreferencePatch,
): IssuePanelPreferences {
  return {
    state: overrides.state ?? preferences.state,
    involvement: overrides.involvement ?? preferences.involvement,
    label: "label" in overrides ? overrides.label : preferences.label,
    sort: overrides.sort ?? preferences.sort,
    order: overrides.order ?? preferences.order,
  };
}

export function issuePanelPreferencePatch(
  input: IssuePanelPreferencePatch & {
    readonly query?: string | undefined;
    readonly projectId?: ProjectId | undefined;
  },
): IssuePanelPreferencePatch | null {
  const patch: IssuePanelPreferencePatch = {
    ...("state" in input ? { state: input.state } : {}),
    ...("involvement" in input ? { involvement: input.involvement } : {}),
    ...("label" in input ? { label: input.label } : {}),
    ...("sort" in input ? { sort: input.sort } : {}),
    ...("order" in input ? { order: input.order } : {}),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}

export function issuePanelPreferencesKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `t3.issues.panel.preferences:${JSON.stringify([environmentId, projectId])}`;
}
