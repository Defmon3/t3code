import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsPanel } from "./PullRequestsPanel";

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    invalidate: {},
    list: (input: unknown) => input,
  },
  usePullRequestListStats: () => ({ stats: [], refresh: () => undefined }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("~/state/queries", () => ({
  useDebouncedValue: (value: string) => value,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: false,
      nextCursors: {},
    },
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));

describe("PullRequestsPanel", () => {
  it("renders the repository-scoped pull request browser", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsPanel
        environmentId={"env-1" as never}
        projectId={"project-1" as never}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Search pull requests"');
    expect(markup).toContain("This repository has no pull requests to open.");
    expect(markup).toContain("Filter pull requests");
    expect(markup).toContain('aria-label="Refresh pull requests"');
  });
});
