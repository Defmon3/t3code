import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = {
  fileDiffNames: [] as string[],
  virtualizer: null as {
    className: string | undefined;
    contentClassName: string | undefined;
    config: Record<string, unknown> | undefined;
  } | null,
};

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { fileDiff: { name?: string } }) => {
    testState.fileDiffNames.push(props.fileDiff.name ?? "");
    return <div />;
  },
  Virtualizer: (props: {
    children: ReactNode;
    className?: string;
    contentClassName?: string;
    config?: Record<string, unknown>;
  }) => {
    testState.virtualizer = {
      className: props.className,
      contentClassName: props.contentClassName,
      config: props.config,
    };
    return <div>{props.children}</div>;
  },
}));

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode }) => <button>{props.children}</button>,
}));

vi.mock("../ui/select", () => ({
  Select: (props: { children: ReactNode }) => <div>{props.children}</div>,
  SelectItem: (props: { children: ReactNode }) => <div>{props.children}</div>,
  SelectPopup: (props: { children: ReactNode }) => <div>{props.children}</div>,
  SelectTrigger: (props: { children: ReactNode }) => <button>{props.children}</button>,
  SelectValue: (props: { children: ReactNode }) => <span>{props.children}</span>,
}));

import { CommitDiffView } from "./GitHistoryCommitDiff";

describe("CommitDiffView", () => {
  beforeEach(() => {
    testState.fileDiffNames = [];
    testState.virtualizer = null;
  });

  it("virtualizes all changed files while preserving their diff order", () => {
    renderToStaticMarkup(
      <CommitDiffView
        hash="0123456789abcdef"
        files={[
          { path: "first.ts", status: "M" },
          { path: "second.ts", status: "M" },
        ]}
        diff={[
          "diff --git a/first.ts b/first.ts",
          "--- a/first.ts",
          "+++ b/first.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "diff --git a/second.ts b/second.ts",
          "--- a/second.ts",
          "+++ b/second.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
        ].join("\n")}
        truncated={false}
        isPending={false}
        error={null}
        onBack={vi.fn()}
        onSelectFile={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(testState.virtualizer).toMatchObject({
      className: "min-h-0 flex-1 overflow-auto",
      contentClassName: "diff-render-surface space-y-2 p-2",
      config: { overscrollSize: 600, intersectionObserverMargin: 1200 },
    });
    expect(testState.fileDiffNames).toEqual(["first.ts", "second.ts"]);
  });
});
