import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import GitHistoryWithIssuesPanel from "./GitHistoryWithIssuesPanel";

vi.mock("./GitHistoryPanel", () => ({
  default: () => <div>History content</div>,
}));

vi.mock("./issue/IssuesPanel", () => ({
  IssuesPanel: () => <div>Issues content</div>,
}));

describe("GitHistoryWithIssuesPanel", () => {
  it("exposes Issues beside History in the repository pane", () => {
    const markup = renderToStaticMarkup(
      <GitHistoryWithIssuesPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        issuesCapabilityState="ready"
        projectId={"project-1" as never}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Repository history and issues"');
    expect(markup).toContain(">History</button>");
    expect(markup).toContain(">Issues</button>");
    expect(markup).toContain("History content");
  });
});
