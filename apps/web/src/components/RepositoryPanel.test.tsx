import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import RepositoryPanel from "./RepositoryPanel";

vi.mock("./GitHistoryPanel", () => ({
  default: () => <div>History content</div>,
}));

vi.mock("./issue/IssuesPanel", () => ({
  IssuesPanel: () => <div>Issues content</div>,
}));

vi.mock("./pullRequest/PullRequestsPanel", () => ({
  PullRequestsPanel: () => <div>Pull requests content</div>,
}));

describe("RepositoryPanel", () => {
  it("exposes Issues beside History in the repository pane", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="history"
        onViewChange={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Repository history, issues, and pull requests"');
    expect(markup).toContain(">History</button>");
    expect(markup).toContain(">Issues</button>");
    expect(markup).toContain(">Pull Requests</button>");
    expect(markup).toContain("History content");
  });

  it("shows the existing pull request browser in the shared pane", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="pull-requests"
        onViewChange={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
      />,
    );

    expect(markup).toContain("Pull requests content");
    expect(markup).toContain('aria-hidden="true"');
  });
});
