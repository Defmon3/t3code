import { EnvironmentId, type VcsHistoryRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const refState = vi.hoisted(() => ({
  favoriteBranches: [] as ReadonlyArray<string>,
  isResolved: true,
  local: [] as ReadonlyArray<VcsHistoryRef>,
  remote: [] as ReadonlyArray<VcsHistoryRef>,
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  isComplete: true,
  requests: [] as Array<{
    readonly target: unknown;
    readonly options: { readonly namespace: string };
  }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useDeferredValue: <Value,>(value: Value) => value,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [
    refState.favoriteBranches,
    (next: ReadonlyArray<string> | ((current: ReadonlyArray<string>) => ReadonlyArray<string>)) => {
      refState.favoriteBranches =
        typeof next === "function" ? next(refState.favoriteBranches) : next;
    },
  ],
}));

vi.mock("../../state/queries", () => ({
  useDebouncedValue: <Value,>(value: Value) => value,
  usePaginatedHistoryRefs: (target: unknown, options: { readonly namespace: string }) => {
    refState.requests.push({ target, options });
    const refs =
      options.namespace === "local"
        ? refState.local
        : options.namespace === "remote"
          ? refState.remote
          : refState.tags;
    return {
      data: refState.isResolved
        ? { currentRef: null, nextCursor: null, isComplete: refState.isComplete }
        : undefined,
      refs,
      error: null,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh: vi.fn(),
      retry: vi.fn(),
    };
  },
}));

import { GitRefsPane } from "./GitHistoryRefsPane";
import {
  gitHistoryFavoriteStorageKey,
  toggleGitHistoryFavorite,
  useGitHistoryRefs,
} from "./useGitHistoryRefs";

const environmentId = EnvironmentId.make("environment-local");

function ref(name: string, isRemote = false): VcsHistoryRef {
  return { current: false, isDefault: false, isRemote, name, worktreePath: null };
}

function renderRefs(currentEnvironmentId = environmentId, cwd = "C:/workspace", revision = 0) {
  hooks.beginRender();
  const historyRefs = useGitHistoryRefs(currentEnvironmentId, cwd, revision);
  const pane = GitRefsPane({
    refFilter: historyRefs.refFilter,
    onRefFilterChange: historyRefs.setRefFilter,
    selectedRevision: historyRefs.selectedRevision ?? null,
    onSelectAll: historyRefs.selectAllRefs,
    currentRef: historyRefs.currentRef,
    onSelectRef: historyRefs.selectRef,
    normalizedRefFilter: historyRefs.normalizedRefFilter,
    localRefTree: historyRefs.localRefTree,
    favoriteRefs: historyRefs.favoriteRefs,
    remoteRefTree: historyRefs.remoteRefTree,
    tagRefTree: historyRefs.tagRefTree,
    expandedRefKeys: historyRefs.expandedRefKeys,
    onToggleRefKey: historyRefs.toggleRefKey,
    sharedRefTreeProps: {
      filterActive: false,
      expanded: historyRefs.expandedRefKeys,
      selectedRevision: historyRefs.selectedRevision?.revision ?? null,
      favoriteBranches: historyRefs.favoriteBranches,
      onToggle: historyRefs.toggleRefKey,
      onSelect: historyRefs.selectRef,
      onToggleFavorite: historyRefs.toggleFavorite,
    },
    hasMoreRefs: historyRefs.hasMoreRefs,
    isFetchingMoreRefs: historyRefs.isFetchingMoreRefs,
    isRefSnapshotComplete: historyRefs.isRefSnapshotComplete,
    onLoadMoreRefs: historyRefs.onLoadMoreRefs,
    refPaginationError: historyRefs.refPaginationError,
    onRetryRefs: historyRefs.onRetryRefs,
  }) as ReactElement<Record<string, unknown>>;
  const list = visitElements(pane, (element) => typeof element.props.keyExtractor === "function");
  expect(list).not.toBeNull();
  const capStatus = visitElements(pane, (element) => element.props.role === "status");
  return { historyRefs, rows: list!.props.data as ReadonlyArray<unknown>, capStatus };
}

describe("useGitHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    refState.favoriteBranches = [];
    refState.isResolved = true;
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));
    refState.tags = [];
    refState.isComplete = true;
    refState.requests = [];
  });

  it("preserves ref trees and the 10k-row virtual-list model across unchanged rerenders", () => {
    const collapsed = renderRefs();
    collapsed.historyRefs.toggleRefKey("section:remote");
    const first = renderRefs();
    const second = renderRefs();

    expect(second.historyRefs.localRefs).toBe(first.historyRefs.localRefs);
    expect(second.historyRefs.remoteRefs).toBe(first.historyRefs.remoteRefs);
    expect(second.historyRefs.localRefTree).toBe(first.historyRefs.localRefTree);
    expect(second.historyRefs.remoteRefTree).toBe(first.historyRefs.remoteRefTree);
    expect(second.rows).toBe(first.rows);
    expect(second.rows).toHaveLength(10_005);
  });

  it("states the first-10,000 cap when the server snapshot is incomplete", () => {
    refState.isComplete = false;

    const rendered = renderRefs();

    expect(rendered.capStatus?.props.children).toBe("Showing the first 10,000 matching refs.");
  });

  it("scopes favorite storage and toggles branch membership", () => {
    expect(gitHistoryFavoriteStorageKey(environmentId, "C:/workspace")).toBe(
      "t3code:git-history-favorites:v1:environment-local:C:/workspace",
    );
    expect(toggleGitHistoryFavorite([], "feature/favorite")).toEqual(["feature/favorite"]);
    expect(toggleGitHistoryFavorite(["feature/favorite"], "feature/favorite")).toEqual([]);
  });

  it("keeps the selection unresolved until the current ref resolves", () => {
    refState.isResolved = false;

    expect(renderRefs().historyRefs.selectedRevision).toBeUndefined();
  });

  it("does not carry a selected revision into a new unresolved scope", () => {
    const initial = renderRefs();
    initial.historyRefs.selectRef("feature/selected", "refs/heads/feature/selected");
    renderRefs();
    refState.isResolved = false;

    expect(
      renderRefs(environmentId, "C:/other-workspace").historyRefs.selectedRevision,
    ).toBeUndefined();
  });

  it("loads a collapsed selected remote namespace for removal recovery", () => {
    const initial = renderRefs();
    initial.historyRefs.selectRef("origin/main", "refs/remotes/origin/main");
    refState.requests = [];

    renderRefs();

    expect(refState.requests).toContainEqual({
      target: { environmentId, cwd: "C:/workspace", query: "" },
      options: { limit: 200, namespace: "remote", revision: 0 },
    });
  });

  it("filters favorite projection inputs before rendering rows", () => {
    refState.local = [ref("feature/favorite"), ref("feature/hidden")];
    refState.favoriteBranches = ["feature/favorite", "feature/hidden"];
    const initial = renderRefs();
    initial.historyRefs.setRefFilter("favorite");

    expect(renderRefs().historyRefs.favoriteRefs.map((ref) => ref.name)).toEqual([
      "feature/favorite",
    ]);
  });
});
