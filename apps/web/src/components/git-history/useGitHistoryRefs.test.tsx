import { EnvironmentId, type VcsRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const refState = vi.hoisted(() => ({
  local: [] as ReadonlyArray<VcsRef>,
  remote: [] as ReadonlyArray<VcsRef>,
  tags: [] as ReadonlyArray<VcsRef>,
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

vi.mock("../../state/queries", () => ({
  usePaginatedBranches: (_target: unknown, options: { readonly namespace: string }) => {
    const refs =
      options.namespace === "local"
        ? refState.local
        : options.namespace === "remote"
          ? refState.remote
          : refState.tags;
    return {
      data: { currentRef: null, nextCursor: null },
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
import { useGitHistoryRefs } from "./useGitHistoryRefs";

const environmentId = EnvironmentId.make("environment-local");

function ref(name: string, isRemote = false): VcsRef {
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
      onToggle: historyRefs.toggleRefKey,
      onSelect: historyRefs.selectRef,
    },
    hasMoreRefs: historyRefs.hasMoreRefs,
    isFetchingMoreRefs: historyRefs.isFetchingMoreRefs,
    onLoadMoreRefs: historyRefs.onLoadMoreRefs,
    refPaginationError: historyRefs.refPaginationError,
    onRetryRefs: historyRefs.onRetryRefs,
  }) as ReactElement<Record<string, unknown>>;
  const list = visitElements(pane, (element) => typeof element.props.keyExtractor === "function");
  expect(list).not.toBeNull();
  return { historyRefs, rows: list!.props.data as ReadonlyArray<unknown> };
}

describe("useGitHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));
    refState.tags = [];
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
});
