import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { useDebouncedValue, usePaginatedHistoryRefs } from "../../state/queries";
import { useLocalStorage } from "../../hooks/useLocalStorage";

const EMPTY_FAVORITE_BRANCHES: ReadonlyArray<string> = [];
const FavoriteBranchesSchema = Schema.Array(Schema.String);
const REF_FILTER_DEBOUNCE_MS = 175;

export interface GitHistoryRevision {
  readonly label: string;
  readonly revision: string;
}

export function gitHistoryFavoriteStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `t3code:git-history-favorites:v1:${environmentId}:${cwd}`;
}

export function toggleGitHistoryFavorite(
  favorites: ReadonlyArray<string>,
  branch: string,
): ReadonlyArray<string> {
  return favorites.includes(branch)
    ? favorites.filter((value) => value !== branch)
    : [...favorites, branch];
}

export function useGitHistoryRefs(environmentId: EnvironmentId, cwd: string, revision = 0) {
  const [favoriteBranches, setFavoriteBranches] = useLocalStorage(
    gitHistoryFavoriteStorageKey(environmentId, cwd),
    EMPTY_FAVORITE_BRANCHES,
    FavoriteBranchesSchema,
  );
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState<
    GitHistoryRevision | null | undefined
  >(undefined);
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const debouncedRefFilter = useDebouncedValue(refFilter.trim(), REF_FILTER_DEBOUNCE_MS);
  const normalizedRefFilter = refFilter.trim().toLocaleLowerCase();
  const shouldLoadRemote = debouncedRefFilter.length > 0 || expandedRefKeys.has("section:remote");
  const shouldLoadTags = debouncedRefFilter.length > 0 || expandedRefKeys.has("section:tags");
  const refs = usePaginatedHistoryRefs(
    { environmentId, cwd, query: debouncedRefFilter },
    { limit: 200, namespace: "local", revision },
  );
  const remote = usePaginatedHistoryRefs(
    shouldLoadRemote
      ? { environmentId, cwd, query: debouncedRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "remote", revision },
  );
  const tags = usePaginatedHistoryRefs(
    shouldLoadTags
      ? { environmentId, cwd, query: debouncedRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "tag", revision },
  );
  const mergedRefs = useMemo(() => [...refs.refs, ...remote.refs], [refs.refs, remote.refs]);
  const tagRefs = tags.refs;
  const { localRefs, remoteRefs } = useMemo(() => {
    const local: VcsHistoryRef[] = [];
    const remote: VcsHistoryRef[] = [];
    for (const ref of mergedRefs) {
      if (ref.isRemote) remote.push(ref);
      else if (!ref.isTag) local.push(ref);
    }
    return { localRefs: local, remoteRefs: remote };
  }, [mergedRefs]);
  const localRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(localRefs), normalizedRefFilter),
    [localRefs, normalizedRefFilter],
  );
  const favoriteBranchSet = useMemo(() => new Set(favoriteBranches), [favoriteBranches]);
  const remoteRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(remoteRefs), normalizedRefFilter),
    [normalizedRefFilter, remoteRefs],
  );
  const tagRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(tagRefs), normalizedRefFilter),
    [normalizedRefFilter, tagRefs],
  );
  const currentRef = refs.data?.currentRef ?? null;
  const defaultSelectedRevision = useMemo(
    () =>
      currentRef === undefined
        ? undefined
        : currentRef === null
          ? null
          : { label: currentRef.name, revision: `refs/heads/${currentRef.name}` },
    [currentRef],
  );
  const selectedRefWasRemoved = useMemo(() => {
    if (selectedRevisionState === undefined || selectedRevisionState === null) return false;
    if (debouncedRefFilter.length > 0) return false;
    const selectedRef = selectedRevisionState.revision;
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
    debouncedRefFilter,
    localRefs,
    refs.data?.isComplete,
    refs.data?.nextCursor,
    remote.data?.isComplete,
    remote.data?.nextCursor,
    remoteRefs,
    selectedRevisionState,
    tagRefs,
    tags.data?.isComplete,
    tags.data?.nextCursor,
  ]);
  const selectedRevision =
    selectedRevisionState === undefined || selectedRefWasRemoved
      ? defaultSelectedRevision
      : selectedRevisionState;
  const toggleRefKey = useCallback((key: string) => {
    setExpandedRefKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectRef = useCallback((label: string, revision: string) => {
    setSelectedRevision({ label, revision });
  }, []);
  const selectAllRefs = useCallback(() => {
    setSelectedRevision(null);
  }, []);
  const toggleFavorite = useCallback(
    (branch: string) => {
      setFavoriteBranches((current) => toggleGitHistoryFavorite(current, branch));
    },
    [setFavoriteBranches],
  );

  useEffect(() => {
    setSelectedRevision(undefined);
    setRefFilter("");
    setExpandedRefKeys(new Set(["section:local"]));
  }, [cwd, environmentId]);

  useEffect(() => {
    if (selectedRefWasRemoved) setSelectedRevision(undefined);
  }, [selectedRefWasRemoved]);

  return {
    currentRef,
    expandedRefKeys,
    favoriteBranches: favoriteBranchSet,
    hasMoreRefs:
      (refs.data?.nextCursor !== null && refs.data?.nextCursor !== undefined) ||
      (remote.data?.nextCursor !== null && remote.data?.nextCursor !== undefined) ||
      (tags.data?.nextCursor !== null && tags.data?.nextCursor !== undefined),
    isFetchingMoreRefs:
      refs.isFetchingNextPage || remote.isFetchingNextPage || tags.isFetchingNextPage,
    isRefSnapshotComplete:
      refs.data?.isComplete !== false &&
      remote.data?.isComplete !== false &&
      tags.data?.isComplete !== false,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs: () => {
      refs.loadNext();
      remote.loadNext();
      tags.loadNext();
    },
    refreshRefs: () => {
      refs.refresh();
      remote.refresh();
      tags.refresh();
    },
    onRetryRefs: () => {
      if (refs.error) refs.retry();
      if (remote.error) remote.retry();
      if (tags.error) tags.retry();
    },
    refPaginationError: refs.error ?? remote.error ?? tags.error,
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs,
    selectRef,
    selectedRevision: selectedRevision ?? null,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleRefKey,
    toggleFavorite,
  };
}
