import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { useDebouncedValue, usePaginatedHistoryRefs } from "../../state/queries";
import type { GitHistoryRevisionState } from "./GitHistoryPanelState";

const EMPTY_FAVORITE_BRANCHES: ReadonlyArray<string> = [];
const FavoriteBranchesSchema = Schema.Array(Schema.String);
const REF_FILTER_DEBOUNCE_MS = 175;

export type GitHistoryRevision = GitHistoryRevisionState;

export function toggleGitHistoryFavorite(
  favorites: ReadonlyArray<string>,
  branch: string,
): ReadonlyArray<string> {
  return favorites.includes(branch)
    ? favorites.filter((value) => value !== branch)
    : [...favorites, branch];
}

export function useGitHistoryRefs(
  environmentId: EnvironmentId,
  cwd: string,
  revision: number,
  scopeKey = `${environmentId}:${cwd}`,
  state?: {
    readonly selectedRevision: GitHistoryRevision | null | undefined;
    readonly onSelectedRevisionChange: (
      selectedRevision: GitHistoryRevision | null | undefined,
    ) => void;
  },
) {
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState(() => ({
    scopeKey,
    selectedRevision: state?.selectedRevision,
  }));
  const selectedRevisionValue =
    selectedRevisionState.scopeKey === scopeKey
      ? selectedRevisionState.selectedRevision
      : undefined;
  if (selectedRevisionState.scopeKey !== scopeKey) {
    setSelectedRevision({ scopeKey, selectedRevision: state?.selectedRevision });
  }
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const deferredRefFilter = useDebouncedValue(refFilter.trim(), REF_FILTER_DEBOUNCE_MS);
  const normalizedRefFilter = refFilter.trim().toLocaleLowerCase();
  const shouldLoadRemote =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:remote") ||
    selectedRevisionValue?.revision.startsWith("refs/remotes/") === true;
  const shouldLoadTags =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:tags") ||
    selectedRevisionValue?.revision.startsWith("refs/tags/") === true;
  const refs = usePaginatedHistoryRefs(
    { environmentId, cwd, query: deferredRefFilter },
    { limit: 200, namespace: "local", revision },
  );
  const remote = usePaginatedHistoryRefs(
    shouldLoadRemote
      ? { environmentId, cwd, query: deferredRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "remote", revision },
  );
  const tags = usePaginatedHistoryRefs(
    shouldLoadTags
      ? { environmentId, cwd, query: deferredRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "tag", revision },
  );
  const localRefs = refs.refs;
  const remoteRefs = remote.refs;
  const tagRefs = tags.refs;
  const repositoryKey = refs.data?.repositoryKey ?? null;
  const favoriteStorageKey =
    repositoryKey === null
      ? null
      : `t3code:git-history-favorites:v1:${environmentId}:${repositoryKey}`;
  const [persistedFavoriteBranches, setFavoriteBranches] = useLocalStorage(
    favoriteStorageKey,
    EMPTY_FAVORITE_BRANCHES,
    FavoriteBranchesSchema,
  );
  const localRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(localRefs), normalizedRefFilter),
    [localRefs, normalizedRefFilter],
  );
  const favoriteBranchSet = useMemo(
    () => new Set(persistedFavoriteBranches),
    [persistedFavoriteBranches],
  );
  const favoriteRefs = useMemo(
    () =>
      localRefs.filter(
        (ref) =>
          favoriteBranchSet.has(ref.name) &&
          (normalizedRefFilter.length === 0 ||
            ref.name.toLocaleLowerCase().includes(normalizedRefFilter)),
      ),
    [favoriteBranchSet, localRefs, normalizedRefFilter],
  );
  const remoteRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(remoteRefs), normalizedRefFilter),
    [normalizedRefFilter, remoteRefs],
  );
  const tagRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(tagRefs), normalizedRefFilter),
    [normalizedRefFilter, tagRefs],
  );
  const currentRefResult = refs.data?.currentRef;
  const lastResolvedCurrentRef = useRef<VcsHistoryRef | null | undefined>(undefined);
  if (currentRefResult !== undefined) lastResolvedCurrentRef.current = currentRefResult;
  const currentRef =
    currentRefResult === undefined ? lastResolvedCurrentRef.current : currentRefResult;
  const defaultSelectedRevision = useMemo(() => {
    if (currentRef === undefined) return refs.error === null ? undefined : null;
    if (currentRef === null) return null;
    return { label: currentRef.name, revision: `refs/heads/${currentRef.name}` };
  }, [currentRef, refs.error]);
  const selectedRefWasRemoved = useMemo(() => {
    if (selectedRevisionValue === undefined || selectedRevisionValue === null) return false;
    if (deferredRefFilter.length > 0) return false;
    const selectedRef = selectedRevisionValue.revision;
    if (selectedRef.startsWith("refs/heads/")) {
      return (
        refs.data?.isComplete === true &&
        refs.data.nextCursor === null &&
        !localRefs.some((ref) => selectedRef === `refs/heads/${ref.name}`)
      );
    }
    if (selectedRef.startsWith("refs/remotes/")) {
      return (
        remote.data?.isComplete === true &&
        remote.data.nextCursor === null &&
        !remoteRefs.some((ref) => selectedRef === `refs/remotes/${ref.name}`)
      );
    }
    if (selectedRef.startsWith("refs/tags/")) {
      return (
        tags.data?.isComplete === true &&
        tags.data.nextCursor === null &&
        !tagRefs.some((ref) => selectedRef === `refs/tags/${ref.name}`)
      );
    }
    return false;
  }, [
    localRefs,
    deferredRefFilter,
    refs.data?.isComplete,
    refs.data?.nextCursor,
    remote.data?.isComplete,
    remote.data?.nextCursor,
    remoteRefs,
    selectedRevisionValue,
    tagRefs,
    tags.data?.isComplete,
    tags.data?.nextCursor,
  ]);
  const selectedRevision =
    selectedRevisionValue === undefined || selectedRefWasRemoved
      ? defaultSelectedRevision
      : selectedRevisionValue;
  const initialLocalRefError =
    currentRef === undefined && selectedRevisionValue === undefined ? refs.error : null;
  const toggleRefKey = useCallback((key: string) => {
    setExpandedRefKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectRef = useCallback(
    (label: string, revision: string) => {
      const next = { label, revision };
      setSelectedRevision({ scopeKey, selectedRevision: next });
      state?.onSelectedRevisionChange(next);
    },
    [scopeKey, state],
  );
  const selectAllRefs = useCallback(() => {
    setSelectedRevision({ scopeKey, selectedRevision: null });
    state?.onSelectedRevisionChange(null);
  }, [scopeKey, state]);
  const toggleFavorite = useCallback(
    (branch: string) => {
      const toggle = (current: ReadonlyArray<string>) => toggleGitHistoryFavorite(current, branch);
      setFavoriteBranches(toggle);
    },
    [setFavoriteBranches],
  );

  useEffect(() => {
    if (!selectedRefWasRemoved) return;
    setSelectedRevision({ scopeKey, selectedRevision: undefined });
    state?.onSelectedRevisionChange(undefined);
  }, [scopeKey, selectedRefWasRemoved, state]);

  const refNamespaces = [
    { namespace: "local", query: refs, enabled: true },
    { namespace: "remote", query: remote, enabled: shouldLoadRemote },
    { namespace: "tag", query: tags, enabled: shouldLoadTags },
  ] as const;
  const enabledRefNamespaces = refNamespaces.filter(({ enabled }) => enabled);

  return {
    currentRef,
    expandedRefKeys,
    favoriteBranches: favoriteBranchSet,
    favoriteRefs,
    hasMoreRefs: enabledRefNamespaces.some(
      ({ query }) => query.data?.nextCursor !== null && query.data?.nextCursor !== undefined,
    ),
    isFetchingMoreRefs: enabledRefNamespaces.some(({ query }) => query.isFetchingNextPage),
    isRefSnapshotComplete: enabledRefNamespaces.every(
      ({ query }) => query.data?.isComplete !== false,
    ),
    initialLocalRefError,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs: () => enabledRefNamespaces.forEach(({ query }) => query.loadNext()),
    refreshRefs: () => {
      refNamespaces.forEach(({ query }) => query.refresh());
    },
    onRetryRefs: () =>
      enabledRefNamespaces.forEach(({ query }) => {
        if (query.error) query.retry();
      }),
    refPaginationError: enabledRefNamespaces.find(({ query }) => query.error)?.query.error ?? null,
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs,
    selectRef,
    selectedRevision,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleRefKey,
    toggleFavorite,
  };
}
