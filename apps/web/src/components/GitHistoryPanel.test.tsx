import { EnvironmentId, type GitHistoryCommit, type VcsGetHistoryResult } from "@t3tools/contracts";
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
  getHistory: vi.fn(),
  pages: new Map<number | undefined, VcsGetHistoryResult>(),
  refresh: vi.fn(),
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

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { refs: [], isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: 0 },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    getHistory: (target: { readonly input: { readonly cursor?: number } }) => {
      historyState.getHistory(target);
      const value = historyState.pages.get(target.input.cursor);
      if (!value) throw new Error(`Missing history page for cursor ${target.input.cursor}`);
      return { result: { _tag: "Success", waiting: false, value } } satisfies PageAtom;
    },
    listRefs: () => Symbol("refs"),
  },
}));

import GitHistoryPanel from "./GitHistoryPanel";

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

function renderPanel(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return GitHistoryPanel({ environmentId, cwd: "C:/workspace" }) as ReactElement<
    Record<string, unknown>
  >;
}

function historyList(panel: ReactElement<Record<string, unknown>>) {
  const list = visitElements(
    panel,
    (element) =>
      element.props.estimatedItemSize === 54 && typeof element.props.keyExtractor === "function",
  );
  expect(list).not.toBeNull();
  return list as ReactElement<{
    readonly data: ReadonlyArray<{ readonly commit: GitHistoryCommit }>;
  }>;
}

describe("GitHistoryPanel", () => {
  beforeEach(() => {
    hooks.reset();
    historyState.getHistory.mockReset();
    historyState.pages.clear();
    historyState.refresh.mockReset();
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
      input: { cwd: "C:/workspace", limit: 100 },
    });
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
      (element) => element.props.className === "flex min-h-0 min-w-0 flex-1 flex-col",
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
      input: { cwd: "C:/workspace", cursor: 1, limit: 100 },
    });
  });
});
