import {
  EnvironmentId,
  type GitCommitDetails,
  type GitHistoryCommit,
  type VcsGetHistoryResult,
  type VcsRef,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

type PageAtom = {
  readonly result: {
    readonly _tag: "Success";
    readonly waiting: false;
    readonly value: VcsGetHistoryResult;
  };
};

const historyState = vi.hoisted(() => ({
  commitDetails: null as GitCommitDetails | null,
  diff: { diff: "", isRepo: true, truncated: false },
  getCommitDetails: vi.fn(),
  getCommitDiff: vi.fn(),
  getHistory: vi.fn(),
  pages: new Map<number | undefined, VcsGetHistoryResult>(),
  refresh: vi.fn(),
  refreshRefs: vi.fn(),
  refreshTags: vi.fn(),
  refs: [] as ReadonlyArray<VcsRef>,
  tags: [] as ReadonlyArray<VcsRef>,
  status: { aheadCount: 0, behindCount: 0, branchCommitCount: 0 },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useDeferredValue: <Value,>(value: Value) => value,
    useEffect: () => {},
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly value: ReadonlyArray<PageAtom["result"]> }) => atom.value,
}));

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    AsyncResult: {
      ...actual.AsyncResult,
      value: (result: PageAtom["result"]) => ({ _tag: "Some", value: result.value }),
    },
    Atom: {
      ...actual.Atom,
      make: (
        create: (get: (atom: PageAtom) => PageAtom["result"]) => ReadonlyArray<PageAtom["result"]>,
      ) => {
        const value = create((atom) => atom.result);
        return {
          pipe: () => ({ value }),
          value,
        };
      },
      withLabel: () => (atom: unknown) => atom,
    },
  };
});

vi.mock("@legendapp/list/react", () => ({
  LegendList: () => null,
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: historyState.refresh },
}));

vi.mock("../state/queries", () => ({
  usePaginatedBranches: (_target: unknown, options?: { readonly refKind?: string }) => {
    const refs = options?.refKind === "tag" ? historyState.tags : historyState.refs;
    return {
      data: {
        refs,
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: refs.length,
      },
      refs,
      error: null,
      isPending: false,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh: options?.refKind === "tag" ? historyState.refreshTags : historyState.refreshRefs,
    };
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (target: { readonly kind?: string } | null) => {
    const base = { error: null, isPending: false, refresh: vi.fn() };
    if (target?.kind === "refs") {
      return {
        ...base,
        data: {
          refs: historyState.refs,
          tags: historyState.tags,
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: historyState.refs.length,
        },
      };
    }
    if (target?.kind === "status") return { ...base, data: historyState.status };
    if (target?.kind === "commit-details")
      return { ...base, data: { commit: historyState.commitDetails } };
    if (target?.kind === "commit-diff") return { ...base, data: historyState.diff };
    return { ...base, data: null };
  },
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    getHistory: (target: { readonly input: { readonly cursor?: number } }) => {
      historyState.getHistory(target);
      const value = historyState.pages.get(target.input.cursor);
      if (!value) throw new Error(`Missing history page for cursor ${target.input.cursor}`);
      return { result: { _tag: "Success", waiting: false, value } } satisfies PageAtom;
    },
    getCommitDetails: (target: unknown) => {
      historyState.getCommitDetails(target);
      return { kind: "commit-details" };
    },
    getCommitDiff: (target: unknown) => {
      historyState.getCommitDiff(target);
      return { kind: "commit-diff" };
    },
    listRefs: () => ({ kind: "refs" }),
    status: () => ({ kind: "status" }),
  },
}));

import GitHistoryPanel, { isWideHistoryLayout } from "./GitHistoryPanel";

const environmentId = EnvironmentId.make("environment-local");

function commit(hash: string, subject: string, authorName = "Ada Lovelace"): GitHistoryCommit {
  return {
    hash,
    parentHashes: [],
    subject,
    authorName,
    authorEmail: "ada@example.com",
    authoredAt: "2026-08-01T12:00:00.000Z",
    refs: [],
  };
}

function page(
  commits: ReadonlyArray<GitHistoryCommit>,
  options?: { readonly hasMore?: boolean; readonly nextCursor?: number | null },
): VcsGetHistoryResult {
  return {
    commits,
    isRepo: true,
    hasMore: options?.hasMore ?? false,
    nextCursor: options?.nextCursor ?? null,
  };
}

function gitRef(
  name: string,
  options?: {
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly current?: boolean;
    readonly isRemote?: boolean;
    readonly isTag?: boolean;
    readonly upstreamName?: string;
  },
): VcsRef {
  return {
    name,
    current: options?.current ?? false,
    isDefault: false,
    isRemote: options?.isRemote ?? false,
    ...(options?.isTag ? { isTag: true } : {}),
    ...(options?.aheadCount === undefined ? {} : { aheadCount: options.aheadCount }),
    ...(options?.behindCount === undefined ? {} : { behindCount: options.behindCount }),
    ...(options?.upstreamName === undefined ? {} : { upstreamName: options.upstreamName }),
    worktreePath: null,
  };
}

function renderPanel(issueUrlPrefix?: string): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return GitHistoryPanel({
    environmentId,
    cwd: "C:/workspace",
    ...(issueUrlPrefix ? { issueUrlPrefix } : {}),
  }) as ReactElement<Record<string, unknown>>;
}

function historyList(panel: ReactElement<Record<string, unknown>>) {
  const list = visitElements(
    panel,
    (element) =>
      element.props.estimatedItemSize === 30 && typeof element.props.keyExtractor === "function",
  );
  expect(list).not.toBeNull();
  return list as ReactElement<{
    readonly data: ReadonlyArray<{
      readonly commit: GitHistoryCommit;
      readonly graph: { readonly edges: ReadonlyArray<{ readonly kind: string }> };
    }>;
    readonly renderItem: (props: {
      readonly item: {
        readonly commit: GitHistoryCommit;
        readonly graph: { readonly edges: ReadonlyArray<unknown> };
      };
    }) => ReactElement<Record<string, unknown>>;
  }>;
}

function renderComponent(
  element: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = element.type as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement<Record<string, unknown>>;
  return component(element.props);
}

function componentTree(
  panel: ReactElement<Record<string, unknown>>,
  componentName: string,
  props?: Partial<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = visitElements(
    panel,
    (element) =>
      typeof element.type === "function" &&
      element.type.name === componentName &&
      Object.entries(props ?? {}).every(([key, value]) => element.props[key] === value),
  );
  expect(component).not.toBeNull();
  return renderComponent(component as ReactElement<Record<string, unknown>>);
}

describe("GitHistoryPanel", () => {
  beforeEach(() => {
    hooks.reset();
    historyState.commitDetails = null;
    historyState.diff = { diff: "", isRepo: true, truncated: false };
    historyState.getCommitDetails.mockReset();
    historyState.getCommitDiff.mockReset();
    historyState.getHistory.mockReset();
    historyState.pages.clear();
    historyState.refresh.mockReset();
    historyState.refreshRefs.mockReset();
    historyState.refreshTags.mockReset();
    historyState.refs = [];
    historyState.tags = [];
    historyState.status = { aheadCount: 0, behindCount: 0, branchCommitCount: 0 };
  });

  it("renders populated history rows through the virtualized list", () => {
    historyState.pages.set(
      undefined,
      page([
        commit("aaaaaaaa11111111111111111111111111111111", "Add Git history panel"),
        commit("bbbbbbbb22222222222222222222222222222222", "Expose commit graph", "Grace Hopper"),
      ]),
    );

    const panel = renderPanel();
    const list = historyList(panel);

    expect(list.props.data.map((row) => row.commit.subject)).toEqual([
      "Add Git history panel",
      "Expose commit graph",
    ]);
    expect(historyState.getHistory).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "C:/workspace", limit: 100, queryGeneration: 0 },
    });
  });

  it("keeps the desktop refs and details workflow available at ordinary desktop widths", () => {
    expect(isWideHistoryLayout(1119)).toBe(false);
    expect(isWideHistoryLayout(1120)).toBe(true);
  });

  it("filters history by commit message", () => {
    historyState.pages.set(
      undefined,
      page([
        commit("aaaaaaaa11111111111111111111111111111111", "Prepare release"),
        commit("bbbbbbbb22222222222222222222222222222222", "Fix graph layout"),
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

  it("clears a hash search from the clear button or Escape key", () => {
    historyState.pages.set(
      undefined,
      page([
        commit("0acf007c21111111111111111111111111111111", "Matching commit"),
        commit("bbbbbbbb22222222222222222222222222222222", "Other commit"),
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

  it("keeps a no-match search visible and clearable", () => {
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Add Git history panel")]),
    );

    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const changeSearch = search?.props.onChange as
      | ((event: { readonly target: { readonly value: string } }) => void)
      | undefined;
    changeSearch?.({ target: { value: "fix " } });

    const filteredPanel = renderPanel();
    expect(
      visitElements(
        filteredPanel,
        (element) => element.props["aria-label"] === "Filter Git history",
      ),
    ).not.toBeNull();
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
          ...commit("cccccccc33333333333333333333333333333333", "Match newest"),
          parentHashes: ["b"],
        },
        {
          ...commit("bbbbbbbb22222222222222222222222222222222", "Hidden parent"),
          parentHashes: ["a"],
        },
        commit("aaaaaaaa11111111111111111111111111111111", "Match oldest"),
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
      "cccccccc33333333333333333333333333333333",
      "aaaaaaaa11111111111111111111111111111111",
    ]);
    expect(filtered.props.data.flatMap((row) => row.graph.edges)).not.toContainEqual(
      expect.objectContaining({ kind: "parent" }),
    );
  });

  it("deduplicates overlapping pages and keeps Load more in the scrolling column footer", () => {
    const duplicate = commit("aaaaaaaa11111111111111111111111111111111", "Initial commit");
    historyState.pages.set(undefined, page([duplicate], { hasMore: true, nextCursor: 1 }));
    historyState.pages.set(
      1,
      page([duplicate, commit("bbbbbbbb22222222222222222222222222222222", "Second page commit")]),
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
      "aaaaaaaa11111111111111111111111111111111",
      "bbbbbbbb22222222222222222222222222222222",
    ]);
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "C:/workspace", cursor: 1, limit: 100, queryGeneration: 0 },
    });
  });

  it("filters, expands, and selects nested branches while showing the branch commit count", () => {
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
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
    historyState.status = { aheadCount: 3, behindCount: 2, branchCommitCount: 10 };

    const initial = renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        cwd: "C:/workspace",
        limit: 100,
        queryGeneration: 0,
        revision: "refs/heads/feature/ui",
      },
    });
    const initialPane = componentTree(initial, "GitRefsPane");
    const initialSection = componentTree(initialPane, "RefSection", { section: "local" });
    const initialTree = componentTree(initialSection, "RefTree");
    const featureFolder = visitElements(
      initialTree,
      (element) => element.props.title === "feature",
    );
    expect(featureFolder?.props["aria-expanded"]).toBe(false);

    (featureFolder?.props.onClick as (() => void) | undefined)?.();
    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedSection = componentTree(expandedPane, "RefSection", { section: "local" });
    const expandedTree = componentTree(expandedSection, "RefTree");
    const nestedTree = componentTree(expandedTree, "RefTree", { depth: 1 });
    const uiBranch = visitElements(nestedTree, (element) => element.props.title === "feature/ui");
    expect(uiBranch).not.toBeNull();
    expect(
      visitElements(
        nestedTree,
        (element) => element.props.title === "10 commits ahead of origin/feature/ui",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        initialTree,
        (element) => element.props.title === "3 commits ahead of origin/development",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        initialTree,
        (element) => element.props.title === "2 commits behind origin/development",
      ),
    ).not.toBeNull();
    (uiBranch?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        cwd: "C:/workspace",
        limit: 100,
        queryGeneration: 0,
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
    const filteredSection = componentTree(filteredPane, "RefSection", { section: "local" });
    const filteredTree = componentTree(filteredSection, "RefTree");
    const filteredNestedTree = componentTree(filteredTree, "RefTree", { depth: 1 });
    expect(
      visitElements(filteredNestedTree, (element) => element.props.title === "feature/api"),
    ).not.toBeNull();
    expect(
      visitElements(filteredNestedTree, (element) => element.props.title === "feature/ui"),
    ).toBeNull();
  });

  it("lists and selects tags from the refs snapshot even when history has no tag decorations", () => {
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
    historyState.tags = [gitRef("v1.2.3", { isTag: true })];

    const initial = renderPanel();
    const initialPane = componentTree(initial, "GitRefsPane");
    const tags = componentTree(initialPane, "RefSection", { section: "tags" });
    const tagsToggle = visitElements(tags, (element) => element.props["aria-expanded"] === false);
    (tagsToggle?.props.onClick as (() => void) | undefined)?.();

    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedTags = componentTree(expandedPane, "RefSection", { section: "tags" });
    const tagTree = componentTree(expandedTags, "RefTree");
    const tag = visitElements(tagTree, (element) => element.props.title === "v1.2.3");
    expect(tag).not.toBeNull();
    (tag?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "C:/workspace", limit: 100, queryGeneration: 0, revision: "refs/tags/v1.2.3" },
    });
  });

  it("opens the full commit diff from selected commit details", () => {
    const historyCommit = commit("aaaaaaaa11111111111111111111111111111111", "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "", changedFiles: [] };

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
      input: { cwd: "C:/workspace", hash: historyCommit.hash },
    });
  });

  it("shows the short commit hash in every history row", () => {
    const historyCommit = commit("aaaaaaaa11111111111111111111111111111111", "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const shortHash = visitElements(historyRow, (element) => element.props.children === "aaaaaaaa");

    expect(shortHash).not.toBeNull();
    expect(shortHash?.props.title).toBe(`Copy full commit hash ${historyCommit.hash}`);
    expect(shortHash?.props["aria-label"]).toBe(`Copy commit hash ${historyCommit.hash}`);
  });

  it("gives every selectable commit its author, date, and parent topology", () => {
    const historyCommit = {
      ...commit("aaaaaaaa11111111111111111111111111111111", "Merge release", "Grace Hopper"),
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

  it("refreshes both history and loaded refs", () => {
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );

    const refresh = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Refresh Git history",
    );
    (refresh?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.refreshRefs).toHaveBeenCalledOnce();
    expect(historyState.refreshTags).toHaveBeenCalledOnce();
  });

  it("links issue references to the active GitHub repository", () => {
    const historyCommit = commit(
      "aaaaaaaa11111111111111111111111111111111",
      "fix(repository): view (#602)",
    );
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel("https://github.com/VladsCoffeApp1/Argus/issues/"));
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const subject = componentTree(historyRow, "CommitSubject");
    const issueLink = visitElements(subject, (element) => element.props.children === "#602");

    expect(issueLink?.type).toBe("a");
    expect(issueLink?.props.href).toBe("https://github.com/VladsCoffeApp1/Argus/issues/602");
  });

  it("opens a changed file diff from selected commit details", () => {
    const historyCommit = commit("aaaaaaaa11111111111111111111111111111111", "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = {
      ...historyCommit,
      body: "",
      changedFiles: [{ status: "A", path: "src/panel.tsx" }],
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
    (fileTree?.props.onShowDiff as ((path: string) => void) | undefined)?.("src/panel.tsx");

    const diff = renderPanel();
    expect(historyState.getCommitDetails).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "C:/workspace", hash: historyCommit.hash },
    });
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "C:/workspace", hash: historyCommit.hash, filePath: "src/panel.tsx" },
    });
    const diffView = visitElements(
      diff,
      (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
    );
    expect(diffView?.props).toMatchObject({ hash: historyCommit.hash, filePath: "src/panel.tsx" });
  });
});
