import { describe, expect, it } from "vite-plus/test";

import { visitElements } from "../test/reactElementTree";

import {
  componentElement,
  componentTree,
  commit,
  environmentId,
  expiredHistoryPage,
  expiredSnapshotCause,
  flushEffects,
  fontState,
  gitRef,
  historyList,
  historyPageSize,
  historyState,
  loadMoreHistory,
  page,
  primaryCommitHash,
  renderComponent,
  renderPanel,
  secondaryCommitHash,
  stubResizeObserver,
  workspacePath,
} from "./GitHistoryPanel.test-fixture";

describe("GitHistoryPanel paging", () => {
  it("does not start an all-refs history request while the current ref is unresolved", () => {
    historyState.refsResolved = false;

    const panel = renderPanel();

    expect(historyState.getHistory).not.toHaveBeenCalled();
    expect(
      visitElements(panel, (element) => element.props.children === "Loading history…"),
    ).not.toBeNull();
  });

  it("shows an initial ref failure with a reachable retry", () => {
    historyState.refsResolved = false;
    historyState.refsError = "Could not load refs.";

    const panel = renderPanel();
    const refsPane = componentElement(panel, "GitRefsPane");

    expect(historyState.getHistory).not.toHaveBeenCalled();
    expect(refsPane.props.refPaginationError).toBe("Could not load refs.");
    expect(
      visitElements(panel, (element) => element.props.children === "Could not load refs."),
    ).not.toBeNull();
    const retry = visitElements(panel, (element) => element.props.children === "Retry refs");
    expect(retry).not.toBeNull();
    (retry!.props.onClick as () => void)();
    expect(historyState.retryRefs).toHaveBeenCalledOnce();
  });

  it("starts current branch history after an initial ref failure recovers", () => {
    historyState.refsResolved = false;
    historyState.refsError = "Could not load refs.";

    renderPanel();
    expect(historyState.getHistory).not.toHaveBeenCalled();

    historyState.refsError = null;
    historyState.refsResolved = true;
    historyState.refs = [gitRef("main", { current: true })];

    renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize, revision: "refs/heads/main" },
    });
  });

  it("keeps the current branch history visible when a remote refs request fails", () => {
    historyState.refs = [gitRef("main", { current: true })];
    historyState.remoteRefsError = "Could not load remote refs.";

    renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize, revision: "refs/heads/main" },
    });
  });

  it("keeps the current branch history visible when a tag refs request fails", () => {
    historyState.refs = [gitRef("main", { current: true })];
    historyState.tagsError = "Could not load tags.";

    renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize, revision: "refs/heads/main" },
    });
  });

  it("waits for a capped history snapshot to exhaust before showing its notice", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "Initial")], {
        capped: true,
        hasMore: true,
        nextCursor: "next",
      }),
    );

    let panel = renderPanel();

    expect(
      visitElements(
        panel,
        (element) => element.props.children === "History results were capped by the server.",
      ),
    ).toBeNull();

    historyState.pages.set("next", page([commit(secondaryCommitHash, "Last")], { capped: true }));
    loadMoreHistory(panel);
    panel = renderPanel();

    expect(
      visitElements(
        panel,
        (element) => element.props.children === "History results were capped by the server.",
      ),
    ).not.toBeNull();
  });

  it("restarts history after the environment connection generation changes", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    renderPanel();
    historyState.getHistory.mockClear();
    historyState.connection = { phase: "connected", generation: 2 };

    renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });

  it("keeps the narrow branches sheet open when the history target rekeys", () => {
    stubResizeObserver(539);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branches = visitElements(
      renderPanel(),
      (element) => element.props["aria-controls"] === "git-history-refs-panel",
    );
    (branches?.props.onClick as (() => void) | undefined)?.();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-refs-panel",
      )?.props["aria-expanded"],
    ).toBe(true);

    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();
    flushEffects();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-refs-panel",
      )?.props["aria-expanded"],
    ).toBe(true);
  });

  it("closes the narrow details sheet when the history target rekeys", () => {
    stubResizeObserver(539);
    const historyCommit = commit(primaryCommitHash, "Initial");
    historyState.pages.set(undefined, page([historyCommit]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    const details = visitElements(
      renderPanel(),
      (element) => element.props["aria-controls"] === "git-history-details-panel",
    );
    (details?.props.onClick as (() => void) | undefined)?.();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-details-panel",
      )?.props["aria-expanded"],
    ).toBe(true);

    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();
    flushEffects();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-details-panel",
      )?.props["aria-expanded"],
    ).toBe(false);
  });

  it("restores the history header when opening a diff from narrow details", () => {
    stubResizeObserver(539);
    const historyCommit = commit(primaryCommitHash, "Initial");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const list = historyList(renderPanel());
    const row = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      row,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    const details = visitElements(
      renderPanel(),
      (element) => element.props["aria-controls"] === "git-history-details-panel",
    );
    (details?.props.onClick as (() => void) | undefined)?.();
    const detailsPane = componentElement(renderPanel(), "CommitDetailsPane");
    (detailsPane.props.onShowDiff as ((hash: string) => void) | undefined)?.(historyCommit.hash);
    const panel = renderPanel();

    expect(
      visitElements(panel, (element) => element.type === "header")?.props.inert,
    ).toBeUndefined();
    expect(
      visitElements(
        panel,
        (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
      ),
    ).not.toBeNull();
    const branches = visitElements(
      panel,
      (element) => element.props["aria-controls"] === "git-history-refs-panel",
    );
    (branches?.props.onClick as (() => void) | undefined)?.();
    const history = renderPanel();

    expect(
      visitElements(
        history,
        (element) => element.props["aria-controls"] === "git-history-refs-panel",
      )?.props["aria-expanded"],
    ).toBe(true);
    expect(
      visitElements(
        history,
        (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
      ),
    ).toBeNull();
  });

  it("restarts the first history page after a typed continuation expiry", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "First")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", expiredHistoryPage());

    const first = renderPanel();
    loadMoreHistory(first);
    renderPanel();
    flushEffects();
    renderPanel();

    const requests = historyState.getHistory.mock.calls.map(([target]) => target);
    expect(requests).toContainEqual({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, cursor: "history-page-2", limit: historyPageSize },
    });
    expect(requests.at(-1)).toEqual({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });

  it("recovers a second continuation expiry once after a successful recovery", () => {
    const firstPage = page([commit(primaryCommitHash, "First")], {
      hasMore: true,
      nextCursor: "history-page-2",
    });
    historyState.pages.set(undefined, firstPage);
    historyState.pages.set("history-page-2", expiredHistoryPage());

    const first = renderPanel();
    loadMoreHistory(first);
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();

    const recovered = renderPanel();
    loadMoreHistory(recovered);
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();

    const generations = historyState.getHistory.mock.calls.map(([target]) => target.cacheKey);
    expect(generations).toContain(2);
    expect(generations).not.toContain(3);
    expect(generations.at(-1)).toBe(2);
  });

  it("clears an open commit selection when the history target changes", () => {
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
    const details = renderPanel();
    const detailsPane = componentTree(details, "CommitDetailsPane");
    const showDiff = visitElements(
      detailsPane,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("View all changes"),
    );
    (showDiff?.props.onClick as (() => void) | undefined)?.();
    renderPanel();

    historyState.historyRevision = 1;
    renderPanel();

    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
    expect(componentElement(renderPanel(), "CommitDetailsPane").props.hasSelection).toBe(false);
    expect(
      visitElements(
        renderPanel(),
        (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
      ),
    ).toBeNull();
  });

  it("discards loaded history cursor pages when the environment reconnects", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "First")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", page([commit(secondaryCommitHash, "Second")]));

    const initial = renderPanel();
    loadMoreHistory(initial);
    renderPanel();
    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();

    expect(
      historyState.getHistory.mock.calls.slice(-3).map(([target]) => target.input.cursor),
    ).toEqual([undefined, "history-page-2", undefined]);
  });

  it("keeps graph rows stable when history query results have not changed", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "First")]));

    const first = historyList(renderPanel());
    const second = historyList(renderPanel());

    expect(second.props.data).toBe(first.props.data);
  });

  it("keeps row separators out of the graph column", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    const content = visitElements(
      historyRow,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("grid-cols-") &&
        element.props.className.includes("border-b"),
    );

    expect(historyRow.props.className).not.toContain("border-b");
    expect(graph).not.toBeNull();
    expect(content).not.toBeNull();

    const graphRoot = renderComponent(graph!);
    const graphSvg = visitElements(graphRoot, (element) => element.type === "svg");
    expect(graphRoot.props.className).not.toContain("overflow-visible");
    expect(graphSvg).not.toBeNull();
    expect(graphSvg!.props.className).toBe("absolute inset-0");
    expect(graphSvg!.props.height).toBe(30);
    expect(graphSvg!.props.viewBox).toBe("0 0 44 30");
  });

  it("scales the list and graph geometry with the interface font size", () => {
    fontState.interfaceSize = 20;
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    expect(graph).not.toBeNull();
    const graphRoot = renderComponent(graph!);
    const graphSvg = visitElements(graphRoot, (element) => element.type === "svg");

    expect(list.props.estimatedItemSize).toBe(37.5);
    expect(historyRow.props.style).toMatchObject({ height: 37.5 });
    expect(graphSvg!.props.height).toBe(37.5);
    expect(graphSvg!.props.viewBox).toBe("0 0 44 37.5");
  });

  it("keeps graph paths within each paint-contained row while joining adjacent lanes", () => {
    fontState.interfaceSize = 20;
    const parent = commit(secondaryCommitHash, "Parent");
    const child = {
      ...commit(primaryCommitHash, "Child"),
      parentHashes: [parent.hash],
    };
    historyState.pages.set(undefined, page([child, parent]));

    const list = historyList(renderPanel());
    const graphRoots = list.props.data.map((row) => {
      const historyRow = renderComponent(list.props.renderItem({ item: row }));
      const graph = visitElements(
        historyRow,
        (element) => typeof element.type === "function" && element.type.name === "GraphCell",
      );
      expect(graph).not.toBeNull();
      return renderComponent(graph!);
    });
    const childSvg = visitElements(graphRoots[0], (element) => element.type === "svg");
    const parentSvg = visitElements(graphRoots[1], (element) => element.type === "svg");
    const childParentEdge = visitElements(
      graphRoots[0],
      (element) => element.props["data-edge-kind"] === "parent",
    );
    const parentIncoming = visitElements(
      graphRoots[1],
      (element) => element.type === "line" && element.props.y1 === "0",
    );

    expect(childSvg).not.toBeNull();
    expect(parentSvg).not.toBeNull();
    expect(childSvg!.props.className).toBe("absolute inset-0");
    expect(childSvg!.props.viewBox).toBe("0 0 44 37.5");
    expect(childSvg!.props.height).toBe(37.5);
    expect(childParentEdge!.props.d).toContain("L 11.5 37.5");
    expect(childParentEdge!.props.strokeLinecap).toBe("square");
    expect(parentIncoming).not.toBeNull();
    expect(parentIncoming!.props.strokeLinecap).toBe("square");
  });

  it("keeps missing-parent graph paths dashed without boundary overlays", () => {
    const child = {
      ...commit(primaryCommitHash, "Child"),
      parentHashes: [secondaryCommitHash],
    };
    historyState.pages.set(undefined, page([child]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    expect(graph).not.toBeNull();
    const graphRoot = renderComponent(graph!);
    const missingParent = visitElements(
      graphRoot,
      (element) =>
        element.props["data-edge-kind"] === "parent" && element.props.strokeDasharray === "3 2",
    );

    expect(missingParent).not.toBeNull();
    expect(missingParent!.props.strokeLinecap).toBe("butt");
  });

  it("creates a fresh changed-file first-page generation after each recovered snapshot expiry", () => {
    const errorCause = expiredSnapshotCause();
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };
    historyState.commitFiles = {
      files: [{ status: "M", path: "stale.ts" }],
      isRepo: true,
      nextCursor: "stale-cursor",
      hasMore: true,
      capped: true,
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
    expect(componentElement(renderPanel(), "CommitDetailsPane").props).toMatchObject({
      files: [{ status: "M", path: "stale.ts" }],
      filesCapped: true,
      filesHasMore: true,
    });

    historyState.commitFilesErrorCause = errorCause;
    renderPanel();
    flushEffects();
    expect(componentElement(renderPanel(), "CommitDetailsPane").props).toMatchObject({
      files: [],
      filesCapped: false,
      filesHasMore: false,
    });
  });

  it("renders populated history rows through the virtualized list", () => {
    historyState.pages.set(
      undefined,
      page([
        commit(primaryCommitHash, "Add Git history panel"),
        commit(secondaryCommitHash, "Expose commit graph", "Grace Hopper"),
      ]),
    );

    const panel = renderPanel();
    const list = historyList(panel);

    expect(list.props.data.map((row) => row.commit.subject)).toEqual([
      "Add Git history panel",
      "Expose commit graph",
    ]);
    expect(list.props.recycleItems).toBe(false);
    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });
});
