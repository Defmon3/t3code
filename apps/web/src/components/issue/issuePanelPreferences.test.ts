import * as Schema from "effect/Schema";
import { IssueListInput, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ISSUE_PANEL_PREFERENCES,
  issuePanelPreferencePatch,
  issuePanelPreferencesKey,
  IssuePanelPreferencesSchema,
  normalizeIssueSearchQuery,
  resolveIssuePanelPreferences,
} from "./issuePanelPreferences";

const ENVIRONMENT_1 = "environment-1" as EnvironmentId;
const ENVIRONMENT_2 = "environment-2" as EnvironmentId;
const PROJECT_1 = "project-1" as ProjectId;
const PROJECT_2 = "project-2" as ProjectId;
const IssuePanelPreferencesJson = Schema.fromJsonString(IssuePanelPreferencesSchema);
const decodeIssuePanelPreferences = Schema.decodeSync(IssuePanelPreferencesJson);
const encodeIssuePanelPreferences = Schema.encodeSync(IssuePanelPreferencesJson);
const decodeUnknownIssuePanelPreferences = Schema.decodeUnknownOption(IssuePanelPreferencesSchema);
const decodeIssueListInput = Schema.decodeUnknownSync(IssueListInput);

describe("issue panel preferences", () => {
  it("uses a separate storage key for each environment and project", () => {
    expect(issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_1)).not.toBe(
      issuePanelPreferencesKey(ENVIRONMENT_2, PROJECT_2),
    );
    expect(issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_1)).not.toBe(
      issuePanelPreferencesKey(ENVIRONMENT_2, PROJECT_1),
    );
    expect(issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_1)).not.toBe(
      issuePanelPreferencesKey(ENVIRONMENT_1, PROJECT_2),
    );
  });

  it("round-trips all saved filters", () => {
    const preferences = {
      ...DEFAULT_ISSUE_PANEL_PREFERENCES,
      state: "closed" as const,
      involvement: "mentioned" as const,
      label: "status/fixed-in-branch",
      sort: "created" as const,
      order: "asc" as const,
    };

    expect(decodeIssuePanelPreferences(encodeIssuePanelPreferences(preferences))).toEqual(
      preferences,
    );
  });

  it("hydrates absent route filters from the shared preferences", () => {
    const preferences = {
      ...DEFAULT_ISSUE_PANEL_PREFERENCES,
      state: "closed" as const,
      involvement: "mentioned" as const,
      label: "status/fixed-in-branch",
      sort: "created" as const,
      order: "asc" as const,
    };

    expect(resolveIssuePanelPreferences(preferences, {})).toEqual(preferences);
  });

  it("keeps explicit route filters over shared preferences", () => {
    expect(
      resolveIssuePanelPreferences(
        { ...DEFAULT_ISSUE_PANEL_PREFERENCES, state: "closed", label: "status/fixed" },
        { state: "open", label: "status/picked" },
      ),
    ).toMatchObject({ state: "open", label: "status/picked" });
  });

  it("writes route filter changes without treating query edits as preferences", () => {
    expect(issuePanelPreferencePatch({ state: "closed", sort: "created" })).toEqual({
      state: "closed",
      sort: "created",
    });
    expect(issuePanelPreferencePatch({ query: "exact search text" })).toBeNull();
  });

  it("normalizes search text before it reaches the issue-list contract", () => {
    const atLimit = "x".repeat(200);
    const overLimit = `${atLimit}x`;

    expect(normalizeIssueSearchQuery(atLimit)).toBe(atLimit);
    expect(normalizeIssueSearchQuery(overLimit)).toBe(atLimit);
    expect(normalizeIssueSearchQuery(` ${atLimit}`)).toBe(atLimit);
    expect(normalizeIssueSearchQuery("   ")).toBe("");
    expect(
      decodeIssueListInput({ state: "open", query: normalizeIssueSearchQuery(overLimit) }),
    ).toEqual({
      state: "open",
      query: atLimit,
    });
    expect(decodeIssueListInput({ state: "open" })).toEqual({ state: "open" });
  });

  it("rejects corrupt preferences", () => {
    const corrupt: unknown = {
      ...DEFAULT_ISSUE_PANEL_PREFERENCES,
      label: "x".repeat(201),
    };

    expect(decodeUnknownIssuePanelPreferences(corrupt)._tag).toBe("None");
  });
});
