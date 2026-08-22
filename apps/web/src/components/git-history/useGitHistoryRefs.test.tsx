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
  nextCursor: null as string | null,
  validation: new Map<string, ReadonlyArray<VcsHistoryRef>>(),
  validationError: null as string | null,
  validationRefresh: vi.fn(),
  validationRetry: vi.fn(),
}));
const debounceState = vi.hoisted(() => ({ value: "" }));
const historyRefTargets = vi.hoisted(
  () =>
    [] as Array<{
      readonly namespace: string;
      readonly query: string | undefined;
      readonly enabled: boolean;
    }>,
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
    target: { readonly environmentId: EnvironmentId | null; readonly query?: string },
    options: { readonly namespace: string },
  ) => {
    historyRefTargets.push({
      namespace: options.namespace,
      query: target.query,
      enabled: target.environmentId !== null,
    });
    const key = `${options.namespace}:${target.query ?? ""}`;
    const validationRefs = target.query === undefined ? undefined : refState.validation.get(key);
    const isValidationQuery = validationRefs !== undefined;
    const refs =
      validationRefs ??
      (options.namespace === "local"
        ? refState.local
        : options.namespace === "remote"
          ? refState.remote
          : refState.tags);
    return {
      data: {
        currentRef: null,
        nextCursor: isValidationQuery ? null : refState.nextCursor,
        isComplete: isValidationQuery ? true : refState.isComplete,
      },
      refs,
      error: isValidationQuery ? refState.validationError : null,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh: isValidationQuery ? refState.validationRefresh : vi.fn(),
      retry: isValidationQuery ? refState.validationRetry : vi.fn(),
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

function ref(name: string, isRemote = false, isTag = false): VcsHistoryRef {
  return {
    current: false,
    isDefault: false,
    isRemote,
    ...(isTag ? { isTag: true } : {}),
    name,
    worktreePath: null,
  };
}

function renderRefs() {
  hooks.beginRender();
  const historyRefs = useGitHistoryRefs(environmentId, "C:/workspace");
  const pane = GitRefsPane({
    refFilter: historyRefs.refFilter,
    onRefFilterChange: historyRefs.setRefFilter,
    selectedRevision: historyRefs.selectedRevision ?? null,
    onSelectAll: historyRefs.selectAllRefs,
    currentRef: historyRefs.currentRef ?? null,
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
    refState.nextCursor = null;
    refState.validation.clear();
    refState.validationError = null;
    refState.validationRefresh.mockReset();
    refState.validationRetry.mockReset();
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
    expect(historyRefTargets.slice(-4)).toEqual([
      { namespace: "local", query: "", enabled: true },
      { namespace: "remote", query: undefined, enabled: false },
      { namespace: "tag", query: undefined, enabled: false },
      { namespace: "local", query: undefined, enabled: false },
    ]);

    debounceState.value = "feature";
    renderRefs();
    expect(historyRefTargets.slice(-4)).toEqual([
      { namespace: "local", query: "feature", enabled: true },
      { namespace: "remote", query: "feature", enabled: true },
      { namespace: "tag", query: "feature", enabled: true },
      { namespace: "local", query: undefined, enabled: false },
    ]);
  });

  it("keeps a selected remote ref found beyond the paginated main tree", () => {
    const selectedName = "origin/feature/250";
    refState.remote = Array.from({ length: 200 }, (_, index) =>
      ref(`origin/feature/${index}`, true),
    );
    refState.isComplete = false;
    refState.nextCursor = "remote-page-2";
    refState.validation.set(`remote:${selectedName}`, [ref(selectedName, true)]);

    const initial = renderRefs();
    initial.historyRefs.selectRef(selectedName, `refs/remotes/${selectedName}`);
    const selected = renderRefs();

    expect(selected.historyRefs.selectedRevision?.revision).toBe(`refs/remotes/${selectedName}`);
    expect(historyRefTargets).toContainEqual({
      namespace: "remote",
      query: selectedName,
      enabled: true,
    });
  });

  it("revalidates and clears a deep selected ref after manual refresh", () => {
    const selectedName = "origin/feature/250";
    const validationKey = `remote:${selectedName}`;
    refState.remote = Array.from({ length: 200 }, (_, index) =>
      ref(`origin/feature/${index}`, true),
    );
    refState.isComplete = false;
    refState.nextCursor = "remote-page-2";
    refState.validation.set(validationKey, [ref(selectedName, true)]);

    const initial = renderRefs();
    initial.historyRefs.selectRef(selectedName, `refs/remotes/${selectedName}`);
    const selected = renderRefs();
    const validationRequestsBeforeRefresh = historyRefTargets.filter(
      (target) => target.namespace === "remote" && target.query === selectedName && target.enabled,
    ).length;

    refState.validation.set(validationKey, []);
    selected.historyRefs.refreshRefs();
    const refreshed = renderRefs();

    expect(refState.validationRefresh).toHaveBeenCalledOnce();
    expect(refreshed.historyRefs.selectedRevision).toBeNull();
    expect(
      historyRefTargets.filter(
        (target) =>
          target.namespace === "remote" && target.query === selectedName && target.enabled,
      ),
    ).toHaveLength(validationRequestsBeforeRefresh + 1);
  });

  it("surfaces and retries an active selected-ref validation error", () => {
    const selectedName = "origin/feature/250";
    refState.remote = Array.from({ length: 200 }, (_, index) =>
      ref(`origin/feature/${index}`, true),
    );
    refState.isComplete = false;
    refState.nextCursor = "remote-page-2";
    refState.validation.set(`remote:${selectedName}`, [ref(selectedName, true)]);

    const initial = renderRefs();
    initial.historyRefs.selectRef(selectedName, `refs/remotes/${selectedName}`);
    refState.validationError = "temporary selected ref validation failure";
    const selected = renderRefs();

    expect(selected.historyRefs.refPaginationError).toBe(
      "temporary selected ref validation failure",
    );
    selected.historyRefs.onRetryRefs();
    expect(refState.validationRetry).toHaveBeenCalledOnce();
  });

  it("clears a deleted selected ref with a paginated main tree", () => {
    const selectedName = "origin/deleted";
    refState.remote = Array.from({ length: 200 }, (_, index) =>
      ref(`origin/feature/${index}`, true),
    );
    refState.isComplete = false;
    refState.nextCursor = "remote-page-2";
    refState.validation.set(`remote:${selectedName}`, []);

    const initial = renderRefs();
    initial.historyRefs.selectRef(selectedName, `refs/remotes/${selectedName}`);
    const selected = renderRefs();

    expect(selected.historyRefs.selectedRevision).toBeNull();
    expect(historyRefTargets).toContainEqual({
      namespace: "remote",
      query: selectedName,
      enabled: true,
    });
  });

  it("validates a collapsed selected remote ref and stops loading it after selection clears", () => {
    refState.remote = [ref("origin/obsolete", true)];

    const initial = renderRefs();
    initial.historyRefs.selectRef("origin/obsolete", "refs/remotes/origin/obsolete");
    const selected = renderRefs();
    expect(selected.historyRefs.selectedRevision?.revision).toBe("refs/remotes/origin/obsolete");
    expect(historyRefTargets.at(-3)).toEqual({ namespace: "remote", query: "", enabled: true });

    refState.remote = [];
    const removed = renderRefs();
    expect(removed.historyRefs.selectedRevision).toBeNull();
    expect(historyRefTargets.at(-3)).toEqual({ namespace: "remote", query: "", enabled: true });

    removed.historyRefs.selectAllRefs();
    renderRefs();
    expect(historyRefTargets.at(-3)).toEqual({
      namespace: "remote",
      query: undefined,
      enabled: false,
    });
  });

  it("validates a collapsed selected tag ref and stops loading it after selection clears", () => {
    refState.tags = [ref("v1.2.3", false, true)];

    const initial = renderRefs();
    initial.historyRefs.selectRef("v1.2.3", "refs/tags/v1.2.3");
    const selected = renderRefs();
    expect(selected.historyRefs.selectedRevision?.revision).toBe("refs/tags/v1.2.3");
    expect(historyRefTargets.at(-2)).toEqual({ namespace: "tag", query: "", enabled: true });

    refState.tags = [];
    const removed = renderRefs();
    expect(removed.historyRefs.selectedRevision).toBeNull();
    expect(historyRefTargets.at(-2)).toEqual({ namespace: "tag", query: "", enabled: true });

    removed.historyRefs.selectAllRefs();
    renderRefs();
    expect(historyRefTargets.at(-2)).toEqual({
      namespace: "tag",
      query: undefined,
      enabled: false,
    });
  });
});
