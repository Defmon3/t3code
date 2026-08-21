import { EnvironmentId, type VcsHistoryRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const refState = vi.hoisted(() => ({
  local: [] as ReadonlyArray<VcsHistoryRef>,
  remote: [] as ReadonlyArray<VcsHistoryRef>,
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  isComplete: true,
}));
const debounceState = vi.hoisted(() => ({ value: "" }));
const historyRefTargets = vi.hoisted(
  () => [] as Array<{ readonly namespace: string; readonly query: string | undefined }>,
);

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/queries", () => ({
  useDebouncedValue: () => debounceState.value,
  usePaginatedHistoryRefs: (
    target: { readonly query?: string },
    options: { readonly namespace: string },
  ) => {
    historyRefTargets.push({ namespace: options.namespace, query: target.query });
    const refs =
      options.namespace === "local"
        ? refState.local
        : options.namespace === "remote"
          ? refState.remote
          : refState.tags;
    return {
      data: { currentRef: null, nextCursor: null, isComplete: refState.isComplete },
      refs,
      error: null,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh: vi.fn(),
      retry: vi.fn(),
    };
  },
}));

vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [[], vi.fn()],
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

function renderRefs() {
  hooks.beginRender();
  const historyRefs = useGitHistoryRefs(environmentId, "C:/workspace");
  const pane = GitRefsPane({
    refFilter: historyRefs.refFilter,
    onRefFilterChange: historyRefs.setRefFilter,
    selectedRevision: historyRefs.selectedRevision,
    onSelectAll: historyRefs.selectAllRefs,
    currentRef: historyRefs.currentRef,
    onSelectRef: historyRefs.selectRef,
    normalizedRefFilter: historyRefs.normalizedRefFilter,
    localRefTree: historyRefs.localRefTree,
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
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));
    refState.tags = [];
    refState.isComplete = true;
    debounceState.value = "";
    historyRefTargets.length = 0;
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

  it("adds and removes a branch favorite under its repository storage key", () => {
    const key = gitHistoryFavoriteStorageKey(environmentId, "C:/workspace");
    expect(key).toBe("t3code:git-history-favorites:v1:environment-local:C:/workspace");
    expect(toggleGitHistoryFavorite([], "feature/ui")).toEqual(["feature/ui"]);
    expect(toggleGitHistoryFavorite(["feature/ui"], "feature/ui")).toEqual([]);
  });

  it("keeps history-ref RPC query keys unchanged until a typed filter settles", () => {
    const initial = renderRefs();
    initial.historyRefs.setRefFilter("f");
    renderRefs().historyRefs.setRefFilter("fe");
    renderRefs().historyRefs.setRefFilter("feature");
    const rapidInput = renderRefs();

    expect(rapidInput.historyRefs.refFilter).toBe("feature");
    expect(historyRefTargets.slice(-3)).toEqual([
      { namespace: "local", query: "" },
      { namespace: "remote", query: undefined },
      { namespace: "tag", query: undefined },
    ]);

    debounceState.value = "feature";
    renderRefs();
    expect(historyRefTargets.slice(-3)).toEqual([
      { namespace: "local", query: "feature" },
      { namespace: "remote", query: "feature" },
      { namespace: "tag", query: "feature" },
    ]);
  });
});
