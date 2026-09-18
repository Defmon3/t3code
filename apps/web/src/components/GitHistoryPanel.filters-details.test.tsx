import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

import {
  componentElement,
  componentTree,
  commit,
  environmentId,
  flushEffects,
  gitRef,
  historyList,
  historyPageSize,
  historyState,
  newestMatchingCommitHash,
  page,
  primaryCommitHash,
  renderComponent,
  renderPanel,
  secondaryCommitHash,
  workspacePath,
} from "./GitHistoryPanel.test-fixture";
import { CommitDiffView } from "./git-history/GitHistoryCommitDiff";

describe("GitHistoryPanel filters and details", () => {
  it("filters history by commit message", () => {
    historyState.pages.set(
      undefined,
      page([
        commit(primaryCommitHash, "Prepare release"),
        commit(secondaryCommitHash, "Fix graph layout"),
      ]),
    );

    const panel = renderPanel();
    const filter = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    expect(filter).not.toBeNull();
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({
      target: { value: "release" },
    });

    const filtered = historyList(renderPanel());
    expect(filtered.props.data.map((row) => row.commit.subject)).toEqual(["Prepare release"]);
  });

  it("clears the history filter when the target changes and does not restore it", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Prepare release")]));
    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    (
      search?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({ target: { value: "release" } });
    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-label"] === "Filter Git history",
      )?.props.value,
    ).toBe("release");

    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();
    historyState.connection = { phase: "connected", generation: 1 };

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-label"] === "Filter Git history",
      )?.props.value,
    ).toBe("");
  });

  it("keeps a history search to the loaded page until the user requests older commits", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "Fix graph layout")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", page([commit(secondaryCommitHash, "Release notes")]));

    const initialPanel = renderPanel();
    flushEffects();
    const filter = visitElements(
      initialPanel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({ target: { value: "release" } });
    renderPanel();
    flushEffects();
    const filteredPanel = renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledTimes(1);
    expect(historyState.getHistory).not.toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        cursor: "history-page-2",
        limit: historyPageSize,
      },
    });
    const searchOlder = visitElements(
      filteredPanel,
      (element) => element.props.children === "Search older commits",
    );
    expect(searchOlder).not.toBeNull();
  });

  it("clears a hash search from the clear button or Escape key", () => {
    const matchingCommitHash = "0acf007c21111111111111111111111111111111";
    historyState.pages.set(
      undefined,
      page([
        commit(matchingCommitHash, "Matching commit"),
        commit(secondaryCommitHash, "Other commit"),
      ]),
    );

    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const changeSearch = search?.props.onChange as
      | ((event: { readonly target: { readonly value: string } }) => void)
      | undefined;
    changeSearch?.({ target: { value: "0acf007c2" } });
    expect(historyList(renderPanel()).props.data).toHaveLength(1);

    const clear = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Clear Git history search",
    );
    (clear?.props.onClick as (() => void) | undefined)?.();
    expect(historyList(renderPanel()).props.data).toHaveLength(2);

    changeSearch?.({ target: { value: "0acf007c2" } });
    const filteredSearch = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const preventDefault = vi.fn();
    (
      filteredSearch?.props.onKeyDown as
        | ((event: { readonly key: string; readonly preventDefault: () => void }) => void)
        | undefined
    )?.({ key: "Escape", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(historyList(renderPanel()).props.data).toHaveLength(2);
  });

  it("keeps a trailing-space search visible, literal, and clearable", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Add Git history panel")]));

    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const changeSearch = search?.props.onChange as
      | ((event: { readonly target: { readonly value: string } }) => void)
      | undefined;
    const historyQueryCallCount = historyState.getHistory.mock.calls.length;
    changeSearch?.({ target: { value: "fix " } });

    const filteredPanel = renderPanel();
    const filteredSearch = visitElements(
      filteredPanel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    expect(filteredSearch).not.toBeNull();
    expect(filteredSearch?.props.value).toBe("fix ");
    expect(historyState.getHistory).toHaveBeenCalledTimes(historyQueryCallCount);
    const clear = visitElements(
      filteredPanel,
      (element) => element.props["aria-label"] === "Clear Git history search",
    );
    expect(clear).not.toBeNull();
    (clear?.props.onClick as (() => void) | undefined)?.();
    expect(historyList(renderPanel()).props.data).toHaveLength(1);
  });

  it("rebuilds the graph from the text-filtered commits", () => {
    historyState.pages.set(
      undefined,
      page([
        {
          ...commit(newestMatchingCommitHash, "Match newest"),
          parentHashes: ["b"],
        },
        {
          ...commit(secondaryCommitHash, "Hidden parent"),
          parentHashes: ["a"],
        },
        commit(primaryCommitHash, "Match oldest"),
      ]),
    );

    const filter = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({ target: { value: "match" } });

    const filtered = historyList(renderPanel());
    expect(filtered.props.data.map((row) => row.commit.hash)).toEqual([
      newestMatchingCommitHash,
      primaryCommitHash,
    ]);
    expect(filtered.props.data.flatMap((row) => row.graph.edges)).not.toContainEqual(
      expect.objectContaining({ kind: "parent" }),
    );
  });

  it("deduplicates overlapping pages and keeps Load more in the scrolling column footer", () => {
    const duplicate = commit(primaryCommitHash, "Initial commit");
    historyState.pages.set(
      undefined,
      page([duplicate], { hasMore: true, nextCursor: "next-page" }),
    );
    historyState.pages.set(
      "next-page",
      page([duplicate, commit(secondaryCommitHash, "Second page commit")]),
    );

    const panel = renderPanel();
    const scrollingColumn = visitElements(
      panel,
      (element) => element.props.className === "flex h-full min-w-0 flex-col",
    );
    expect(scrollingColumn).not.toBeNull();
    const footer = visitElements(
      scrollingColumn,
      (element) =>
        element.props.className === "flex shrink-0 justify-center border-t border-border/50 p-2",
    );
    expect(footer).not.toBeNull();
    const loadMore = visitElements(footer, (element) => element.props.children === "Load more");
    expect(loadMore).not.toBeNull();
    (loadMore?.props.onClick as (() => void) | undefined)?.();

    const expanded = historyList(renderPanel());
    expect(expanded.props.data.map((row) => row.commit.hash)).toEqual([
      primaryCommitHash,
      secondaryCommitHash,
    ]);
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        cursor: "next-page",
        limit: historyPageSize,
      },
    });
  });

  it("filters, expands, and selects nested branches while showing the branch commit count", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));
    historyState.refs = [
      gitRef("feature/api"),
      gitRef("feature/ui", {
        aheadCount: 10,
        current: true,
        upstreamName: "origin/feature/ui",
      }),
      gitRef("development", {
        aheadCount: 3,
        behindCount: 2,
        upstreamName: "origin/development",
      }),
      gitRef("main"),
    ];
    historyState.status = { aheadCount: 3, behindCount: 2 };

    const initial = renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/heads/feature/ui",
      },
    });
    const initialPane = componentTree(initial, "GitRefsPane");
    const initialList = componentElement(initialPane, "LegendList");
    expect(initialList.props.recycleItems).toBe(true);
    const initialRows = initialList.props.data as Array<{
      readonly key: string;
      readonly open?: boolean;
    }>;
    const featureFolder = initialRows.find((row) => row.key === "local:feature");
    expect(featureFolder?.open).toBe(false);

    const renderInitialRow = initialList.props.renderItem as (props: {
      readonly item: (typeof initialRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const featureFolderRow = renderInitialRow({ item: featureFolder! });
    const featureFolderButton = visitElements(
      featureFolderRow,
      (element) => element.props["aria-expanded"] === false,
    );
    (featureFolderButton?.props.onClick as (() => void) | undefined)?.();
    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedList = componentElement(expandedPane, "LegendList");
    const expandedRows = expandedList.props.data as Array<{ readonly key: string }>;
    expect(expandedRows.map((row) => row.key)).toContain("refs/heads/feature/ui");
    const renderExpandedRow = expandedList.props.renderItem as (props: {
      readonly item: (typeof expandedRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const uiBranch = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/heads/feature/ui")!,
    });
    expect(
      visitElements(
        uiBranch,
        (element) => element.props.children === "10 commits ahead of origin/feature/ui",
      ),
    ).not.toBeNull();
    const developmentBranch = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/heads/development")!,
    });
    expect(
      visitElements(
        developmentBranch,
        (element) => element.props.children === "3 commits ahead of origin/development",
      ),
    ).not.toBeNull();
    const developmentButton = visitElements(
      developmentBranch,
      (element) =>
        element.props["aria-label"] ===
        "development. 3 commits ahead of upstream origin/development. 2 commits behind upstream origin/development.",
    );
    expect(developmentButton?.props["aria-label"]).toBe(
      "development. 3 commits ahead of upstream origin/development. 2 commits behind upstream origin/development.",
    );
    expect(
      visitElements(
        developmentBranch,
        (element) => element.props.children === "2 commits behind origin/development",
      ),
    ).not.toBeNull();
    const uiBranchButton = visitElements(
      uiBranch,
      (element) =>
        element.props["aria-label"] ===
        "feature/ui. 10 commits ahead of upstream origin/feature/ui.",
    );
    (uiBranchButton?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/heads/feature/ui",
      },
    });

    const filter = visitElements(
      expandedPane,
      (element) => element.props["aria-label"] === "Filter branches and tags",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({
      target: { value: "api" },
    });
    const filtered = renderPanel();
    const filteredPane = componentTree(filtered, "GitRefsPane");
    const filteredList = componentElement(filteredPane, "LegendList");
    const filteredRows = filteredList.props.data as Array<{ readonly key: string }>;
    expect(filteredRows.map((row) => row.key)).toContain("refs/heads/feature/api");
    expect(filteredRows.map((row) => row.key)).not.toContain("refs/heads/feature/ui");
  });

  it("lists and selects tags from the refs snapshot even when history has no tag decorations", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));
    historyState.tags = [gitRef("v1.2.3", { kind: "tag" })];

    const initial = renderPanel();
    const initialPane = componentTree(initial, "GitRefsPane");
    const initialList = componentElement(initialPane, "LegendList");
    const initialRows = initialList.props.data as Array<{ readonly key: string }>;
    const renderInitialRow = initialList.props.renderItem as (props: {
      readonly item: (typeof initialRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const tagsSectionRow = renderInitialRow({
      item: initialRows.find((row) => row.key === "section:tags")!,
    });
    const tagsSectionButton = visitElements(
      tagsSectionRow,
      (element) => element.props["aria-expanded"] === false,
    );
    (tagsSectionButton?.props.onClick as (() => void) | undefined)?.();

    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedList = componentElement(expandedPane, "LegendList");
    const expandedRows = expandedList.props.data as Array<{ readonly key: string }>;
    expect(expandedRows.map((row) => row.key)).toContain("refs/tags/v1.2.3");
    const renderExpandedRow = expandedList.props.renderItem as (props: {
      readonly item: (typeof expandedRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const tagRow = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/tags/v1.2.3")!,
    });
    const tagButton = visitElements(tagRow, (element) => element.props["aria-label"] === "v1.2.3");
    (tagButton?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/tags/v1.2.3",
      },
    });
  });

  it("opens the full commit diff from selected commit details", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();

    const detailsPane = componentTree(renderPanel(), "CommitDetailsPane");
    const showDiff = visitElements(
      detailsPane,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("View all changes"),
    );
    expect(showDiff).not.toBeNull();
    (showDiff?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
  });

  it("shows the short commit hash in every history row", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const shortHash = visitElements(
      historyRow,
      (element) => element.props.children === historyCommit.hash.slice(0, 8),
    );
    const shortHashTooltip = visitElements(
      historyRow,
      (element) => element.props.children === `Copy full commit hash ${historyCommit.hash}`,
    );

    expect(shortHash).not.toBeNull();
    expect(shortHash?.props["aria-label"]).toBe(`Copy commit hash ${historyCommit.hash}`);
    expect(shortHashTooltip).not.toBeNull();
  });

  it("shows an error toast when copying a history hash is rejected", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const copyHash = visitElements(
      historyRow,
      (element) => element.props["aria-label"] === `Copy commit hash ${historyCommit.hash}`,
    );
    (copyHash?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not copy commit hash",
      description: "Clipboard permission was denied.",
    });
  });

  it("gives every selectable commit its author, date, and parent topology", () => {
    const historyCommit = {
      ...commit(primaryCommitHash, "Merge release", "Grace Hopper"),
      parentHashes: ["parent-one", "parent-two"],
    };
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectableRow = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );

    expect(selectableRow?.props["aria-label"]).toContain("Author Grace Hopper");
    expect(selectableRow?.props["aria-label"]).toContain("2-parent merge commit");
  });

  it("refreshes history and every ref namespace", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const refresh = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Refresh Git history",
    );
    (refresh?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.refreshRefs).toHaveBeenCalledOnce();
    expect(historyState.refreshRemoteRefs).toHaveBeenCalledOnce();
    expect(historyState.refreshTags).toHaveBeenCalledOnce();
  });

  it("opens a changed file diff from selected commit details", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = {
      ...historyCommit,
      body: "",
    };
    historyState.diff = {
      diff: "diff --git a/src/panel.tsx b/src/panel.tsx\n+added line\n",
      isRepo: true,
      truncated: false,
    };

    const initial = renderPanel();
    const list = historyList(initial);
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();

    const details = renderPanel();
    const detailsPane = componentTree(details, "CommitDetailsPane");
    const fileTree = visitElements(
      detailsPane,
      (element) => typeof element.type === "function" && element.type.name === "CommitFilesTree",
    );
    expect(fileTree).not.toBeNull();
    expect(renderComponent(fileTree!).props.recycleItems).toBe(true);
    (fileTree?.props.onShowDiff as ((path: string) => void) | undefined)?.("src/panel.tsx");

    const diff = renderPanel();
    expect(historyState.getCommitDetails).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        cwd: workspacePath,
        hash: historyCommit.hash,
        filePath: "src/panel.tsx",
      },
    });
    const diffView = visitElements(
      diff,
      (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
    );
    expect(diffView?.props).toMatchObject({ hash: historyCommit.hash, filePath: "src/panel.tsx" });
  });

  it("lets the diff load changed files beyond the first page", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };
    historyState.commitFiles = {
      files: [{ status: "A", path: "first.ts" }],
      isRepo: true,
      nextCursor: "files-page-2",
      hasMore: true,
      capped: false,
    };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    renderPanel();
    flushEffects();
    const detailsPane = componentElement(renderPanel(), "CommitDetailsPane");
    (detailsPane.props.onShowDiff as ((hash: string, filePath?: string) => void) | undefined)?.(
      historyCommit.hash,
    );

    const diffView = componentElement(renderPanel(), "CommitDiffView");
    expect(diffView.props).toMatchObject({ filesHasMore: true, filesLoading: false });
    const diff = renderComponent(diffView);
    const loadMore = visitElements(diff, (element) => element.props.children === "Load more files");

    expect(loadMore).not.toBeNull();
    expect(loadMore?.props.onClick).toBe(diffView.props.onLoadMoreFiles);
  });

  it("lets the diff retry a failed changed-file continuation", () => {
    const retryFiles = vi.fn();
    hooks.beginRender();
    const diff = CommitDiffView({
      hash: primaryCommitHash,
      files: [{ status: "A", path: "first.ts" }],
      filesError: true,
      filesHasMore: true,
      filesLoading: false,
      diff: null,
      truncated: false,
      isPending: false,
      error: null,
      onBack: vi.fn(),
      onSelectFile: vi.fn(),
      onRetry: vi.fn(),
      onLoadMoreFiles: vi.fn(),
      onRetryFiles: retryFiles,
    });
    const retry = visitElements(
      diff,
      (element) => element.props.children === "Retry loading files",
    );

    expect(retry).not.toBeNull();
    expect(retry?.props.onClick).toBe(retryFiles);
  });
});
