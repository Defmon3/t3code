import * as Schema from "effect/Schema";
import {
  ISSUE_LIST_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ISSUE_PANEL_PREFERENCES,
  issuePanelPreferencesKey,
  IssuePanelPreferencesSchema,
} from "./issuePanelPreferences";

const ENVIRONMENT_1 = "environment-1" as EnvironmentId;
const ENVIRONMENT_2 = "environment-2" as EnvironmentId;
const PROJECT_1 = "project-1" as ProjectId;
const PROJECT_2 = "project-2" as ProjectId;
const QUERY =
  "is:issue state:open (author:Defmon3 OR author:Argus-commit-bot OR assignee:Defmon3 ) -label:question -label:status/fixed-in-branch -label:status/picked-up -label:group/child -label:group/parent -label:postponed";
const IssuePanelPreferencesJson = Schema.fromJsonString(IssuePanelPreferencesSchema);
const decodeIssuePanelPreferences = Schema.decodeSync(IssuePanelPreferencesJson);
const encodeIssuePanelPreferences = Schema.encodeSync(IssuePanelPreferencesJson);
const decodeUnknownIssuePanelPreferences = Schema.decodeUnknownOption(IssuePanelPreferencesSchema);

describe("issue panel preferences", () => {
  it("uses a separate storage key for each environment and project", () => {
    expect(issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_1)).not.toBe(
      issuePanelPreferencesKey(ENVIRONMENT_2, PROJECT_2),
    );
    expect(issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_1)).not.toBe(
      issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_2),
    );
  });

  it("round-trips the full issue query", () => {
    const preferences = {
      ...DEFAULT_ISSUE_PANEL_PREFERENCES,
      query: QUERY,
    };

    expect(decodeIssuePanelPreferences(encodeIssuePanelPreferences(preferences))).toEqual(
      preferences,
    );
  });

  it("rejects corrupt preferences", () => {
    const corrupt: unknown = {
      ...DEFAULT_ISSUE_PANEL_PREFERENCES,
      query: "x".repeat(ISSUE_LIST_QUERY_MAX_LENGTH + 1),
    };

    expect(decodeUnknownIssuePanelPreferences(corrupt)._tag).toBe("None");
  });
});
