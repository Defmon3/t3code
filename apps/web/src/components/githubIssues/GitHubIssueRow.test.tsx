import type { GitHubIssue } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { GitHubIssueRow } from "./GitHubIssueRow";

describe("GitHubIssueRow", () => {
  it("names the issue accessibly with its visible metadata", () => {
    const issue: GitHubIssue = {
      number: 42,
      title: "Keep tree state",
      url: "https://github.com/t3tools/t3code/issues/42",
      state: "open",
      author: { login: "theo" },
      createdAt: "2026-08-14T00:00:00.000Z",
      labels: [{ name: "bug", color: "ff0000" }],
      assignees: [],
      milestone: null,
      issueType: null,
      commentCount: 3,
    };
    const markup = renderToStaticMarkup(<GitHubIssueRow issue={issue} wide onOpen={vi.fn()} />);

    expect(markup).toContain("Keep tree state");
    expect(markup).toContain("number 42");
    expect(markup).toContain("label bug");
    expect(markup).toContain("author theo");
  });

  it("places styled GitHub labels beside the title and the issue type before metadata", () => {
    const issue: GitHubIssue = {
      number: 42,
      title: "Keep tree state",
      url: "https://github.com/t3tools/t3code/issues/42",
      state: "open",
      author: { login: "theo" },
      createdAt: "2026-08-14T00:00:00.000Z",
      labels: [{ name: "bright", color: "00ff00" }],
      assignees: [],
      milestone: null,
      issueType: { name: "Regression", color: "RED" },
      commentCount: 3,
    };

    const markup = renderToStaticMarkup(<GitHubIssueRow issue={issue} wide onOpen={vi.fn()} />);

    expect(markup).toContain("border-color:#00ff00");
    expect(markup).toContain("background-color:#00ff001f");
    expect(markup).toContain("border-color:#cf222e");
    expect(markup).toContain("background-color:#cf222e1f");
    expect(markup).toContain("color:light-dark(color-mix(in srgb");
    expect(markup).toContain("sm:h-5 sm:min-h-5 sm:text-xs");
    expect(markup.indexOf(">bright</span>")).toBeGreaterThan(
      markup.indexOf(">Keep tree state</span>"),
    );
    expect(markup.indexOf(">Regression</span>")).toBeLessThan(markup.indexOf(">#42</span>"));
    expect(markup).toContain(">Regression</span>");
  });

  it("uses the neutral outline treatment when GitHub returns a malformed label color", () => {
    const issue: GitHubIssue = {
      number: 42,
      title: "Keep tree state",
      url: "https://github.com/t3tools/t3code/issues/42",
      state: "open",
      author: { login: "theo" },
      createdAt: "2026-08-14T00:00:00.000Z",
      labels: [{ name: "uncolored", color: "not-a-color" }],
      assignees: [],
      milestone: null,
      issueType: null,
      commentCount: 3,
    };

    const markup = renderToStaticMarkup(<GitHubIssueRow issue={issue} wide onOpen={vi.fn()} />);

    expect(markup).toContain("border-input");
    expect(markup).not.toContain("background-color");
    expect(markup).toContain("label uncolored");
  });

  it("caps visible labels and assignees while retaining complete accessible metadata", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const issue: GitHubIssue = {
      number: 42,
      title: "Keep tree state",
      url: "https://github.com/t3tools/t3code/issues/42",
      state: "open",
      author: { login: "theo" },
      createdAt: "not-a-date",
      labels: [
        { name: "one", color: "ff0000" },
        { name: "two", color: "00ff00" },
        { name: "three", color: "0000ff" },
        { name: "four", color: "ffff00" },
      ],
      assignees: [{ login: "theo" }, { login: "sam" }, { login: "alex" }],
      milestone: { title: "@theo" },
      issueType: null,
      commentCount: 3,
    };

    try {
      const markup = renderToStaticMarkup(<GitHubIssueRow issue={issue} wide onOpen={vi.fn()} />);

      expect(markup).toContain(">+1</span>");
      expect(markup).not.toContain(">four</span>");
      expect(markup).toContain(">+1 assignees</span>");
      expect(markup).not.toContain(">@alex</span>");
      expect(markup).toContain("label four");
      expect(markup).toContain("assignee alex");
      expect(markup).toContain("Unknown time");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders future dates as future time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const issue: GitHubIssue = {
      number: 42,
      title: "Keep tree state",
      url: "https://github.com/t3tools/t3code/issues/42",
      state: "open",
      author: { login: "theo" },
      createdAt: "2026-08-15T12:05:00.000Z",
      labels: [],
      assignees: [],
      milestone: null,
      issueType: null,
      commentCount: 3,
    };

    try {
      const markup = renderToStaticMarkup(<GitHubIssueRow issue={issue} wide onOpen={vi.fn()} />);

      expect(markup).toContain("in 5m");
    } finally {
      vi.useRealTimers();
    }
  });
});
