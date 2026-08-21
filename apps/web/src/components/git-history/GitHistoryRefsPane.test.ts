import type { VcsHistoryRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildGitRefTree } from "../../lib/gitRefTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { buildRefPaneRows, GitRefsPane } from "./GitHistoryRefsPane";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useMemo: reactHookHarness.useMemo };
});

function ref(name: string, isTag = false): VcsHistoryRef {
  return {
    current: false,
    isDefault: false,
    isRemote: false,
    ...(isTag ? { isTag: true } : {}),
    name,
    worktreePath: null,
  };
}

describe("buildRefPaneRows", () => {
  it("keeps a large expanded tag hierarchy as list data instead of render items", () => {
    const rows = buildRefPaneRows({
      localRefTree: [],
      remoteRefTree: [],
      tagRefTree: buildGitRefTree(
        Array.from({ length: 10_000 }, (_, index) => ref(`release/${index}`, true)),
      ),
      expandedRefKeys: new Set(["section:local", "section:tags", "tags:release"]),
      filterActive: false,
      hasMoreRefs: false,
      refPaginationError: null,
    });

    expect(rows).toHaveLength(10_006);
    expect(rows.filter((row) => row.kind === "ref")).toHaveLength(10_000);
    expect(rows.find((row) => row.key === "section:tags")).toMatchObject({
      count: 10_000,
      open: true,
    });
  });

  it("opens tag descendants while filtering without changing folder keys", () => {
    const rows = buildRefPaneRows({
      localRefTree: [],
      remoteRefTree: [],
      tagRefTree: buildGitRefTree([ref("release/v1", true)]),
      expandedRefKeys: new Set(),
      filterActive: true,
      hasMoreRefs: false,
      refPaginationError: null,
    });

    expect(rows.map((row) => row.key)).toContain("tags:release");
    expect(rows.map((row) => row.key)).toContain("refs/tags/release/v1");
  });

  it("keeps branch selection and favorite toggling as isolated sibling actions", () => {
    const selected: string[] = [];
    const favorites: string[] = [];
    const branch = { ...ref("feature/ui"), aheadCount: 2 };
    hooks.beginRender();
    const pane = GitRefsPane({
      refFilter: "",
      onRefFilterChange: () => undefined,
      selectedRevision: null,
      onSelectAll: () => undefined,
      currentRef: null,
      onSelectRef: () => undefined,
      normalizedRefFilter: "",
      localRefTree: buildGitRefTree([branch]),
      remoteRefTree: [],
      tagRefTree: [],
      expandedRefKeys: new Set(["section:local"]),
      onToggleRefKey: () => undefined,
      sharedRefTreeProps: {
        filterActive: false,
        expanded: new Set(),
        selectedRevision: null,
        favoriteBranches: new Set(["feature/ui"]),
        onToggle: () => undefined,
        onSelect: (branch) => selected.push(branch),
        onToggleFavorite: (branch) => favorites.push(branch),
      },
      hasMoreRefs: false,
      isFetchingMoreRefs: false,
      isRefSnapshotComplete: true,
      onLoadMoreRefs: () => undefined,
      refPaginationError: null,
      onRetryRefs: () => undefined,
    });
    const list = visitElements(pane, (element) => typeof element.props.renderItem === "function");
    const rows = list?.props.data as ReadonlyArray<{ readonly kind: string; readonly key: string }>;
    const renderItem = list?.props.renderItem as (input: {
      readonly item: (typeof rows)[number];
    }) => unknown;
    const row = renderItem({ item: rows.find((item) => item.kind === "ref")! });
    const favoriteButton = visitElements(
      row,
      (element) => element.props["aria-label"] === "Remove feature/ui from favorites",
    );
    const selectButton = visitElements(row, (element) => element.props["aria-pressed"] === false);

    expect(favoriteButton).not.toBeNull();
    expect(String(selectButton?.props.className)).toContain("h-full");
    expect(String(favoriteButton?.props.className)).toContain("h-full");
    expect(String(favoriteButton?.props.className)).toContain("min-w-6");
    expect(
      visitElements(
        selectButton,
        (element) => element.props.title === "2 commits ahead of the configured upstream",
      ),
    ).not.toBeNull();
    const filledStars: unknown[] = [];
    visitElements(row, (element) => {
      if (String(element.props.className).includes("fill-amber-400")) filledStars.push(element);
      return false;
    });
    expect(filledStars).toHaveLength(1);
    (favoriteButton?.props.onClick as () => void)();
    expect(favorites).toEqual(["feature/ui"]);
    expect(selected).toEqual([]);
    (selectButton?.props.onClick as () => void)();
    expect(selected).toEqual(["feature/ui"]);
  });
});
