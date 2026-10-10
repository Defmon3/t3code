import { describe, expect, it } from "vite-plus/test";
import { migratePersistedRightPanelState } from "./rightPanelStore";

const validSelection = { projectId: "project-a", repository: "org/repo", number: 42 };

describe("Repository selection migration", () => {
  it("preserves a valid repository selection when the legacy issue selection is malformed", () => {
    const state = migratePersistedRightPanelState({
      byThreadKey: {
        "env:thread": {
          isOpen: true,
          activeSurfaceId: "issues",
          surfaces: [
            { id: "issues", kind: "issues", selected: { number: "broken" } },
            {
              id: "repository",
              kind: "repository",
              view: "history",
              selectedIssue: validSelection,
            },
          ],
        },
      },
    });
    expect(state.byThreadKey["env:thread"]?.surfaces).toEqual([
      { id: "repository", kind: "repository", view: "issues", selectedIssue: validSelection },
    ]);
  });

  it("prefers a valid legacy selection when both selections are valid", () => {
    const legacySelection = { ...validSelection, number: 43 };
    const state = migratePersistedRightPanelState({
      byThreadKey: {
        "env:thread": {
          isOpen: true,
          activeSurfaceId: "repository",
          surfaces: [
            { id: "issues", kind: "issues", selected: legacySelection },
            {
              id: "repository",
              kind: "repository",
              view: "history",
              selectedIssue: validSelection,
            },
          ],
        },
      },
    });
    expect(state.byThreadKey["env:thread"]?.surfaces).toEqual([
      { id: "repository", kind: "repository", view: "history", selectedIssue: legacySelection },
    ]);
  });
});
