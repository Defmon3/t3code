import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { useDebouncedValue, usePaginatedHistoryRefs } from "../../state/queries";
import type { GitHistoryRevisionState } from "./GitHistoryPanelState";

const EMPTY_FAVORITE_BRANCHES: ReadonlyArray<string> = [];
const FavoriteBranchesSchema = Schema.Array(Schema.String);
const REF_FILTER_DEBOUNCE_MS = 175;

export type GitHistoryRevision = GitHistoryRevisionState;

export function gitHistoryFavoriteStorageKey(
  environmentId: EnvironmentId,
  repositoryKey: string,
): string {
  return `t3code:git-history-favorites:v1:${environmentId}:${repositoryKey}`;
}

export function toggleGitHistoryFavorite(
  favorites: ReadonlyArray<string>,
  branch: string,
): ReadonlyArray<string> {
  return favorites.includes(branch)
    ? favorites.filter((value) => value !== branch)
    : [...favorites, branch];
}

function useGitHistoryFavorites(
  environmentId: EnvironmentId,
  repositoryKey: string | null,
  localRefs: ReadonlyArray<VcsHistoryRef>,
  normalizedRefFilter: string,
) {
  const favoriteStorageKey =
    repositoryKey === null ? null : gitHistoryFavoriteStorageKey(environmentId, repositoryKey);
  const [persistedFavoriteBranches, setFavoriteBranches] = useLocalStorage(
    favoriteStorageKey,
    EMPTY_FAVORITE_BRANCHES,
    FavoriteBranchesSchema,
  );
  const favoriteBranchSet = new Set(persistedFavoriteBranches);
  const favoriteRefs = localRefs.filter(
    (ref) =>
      favoriteBranchSet.has(ref.name) &&
      (normalizedRefFilter.length === 0 ||
        ref.name.toLocaleLowerCase().includes(normalizedRefFilter)),
  );
  return { favoriteBranchSet, favoriteRefs, setFavoriteBranches };
}

function useGitHistoryRefCatalog(
  environmentId: EnvironmentId,
  cwd: string,
  revision: number,
  refFilter: string,
  expandedRefKeys: ReadonlySet<string>,
  selectedRevisionValue: GitHistoryRevision | null | undefined,
) {
  const trimmedRefFilter = refFilter.trim();
  const deferredRefFilter = useDebouncedValue(trimmedRefFilter, REF_FILTER_DEBOUNCE_MS);
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

  const normalizedRefFilter = trimmedRefFilter.toLocaleLowerCase();
  const localRefs = refs.refs;
  const localRefTree = filterGitRefTree(buildGitRefTree(localRefs), normalizedRefFilter);
  const remoteRefs = remote.refs;
  const remoteRefTree = filterGitRefTree(buildGitRefTree(remoteRefs), normalizedRefFilter);
  const tagRefs = tags.refs;
  const tagRefTree = filterGitRefTree(buildGitRefTree(tagRefs), normalizedRefFilter);
  return {
    deferredRefFilter,
    normalizedRefFilter,
    shouldLoadRemote,
    shouldLoadTags,
    refs,
    remote,
    tags,
    localRefs,
    remoteRefs,
    tagRefs,
    localRefTree,
    remoteRefTree,
    tagRefTree,
  };
}

export function useGitHistoryRefs(
  environmentId: EnvironmentId,
  cwd: string,
  revision: number,
  requestedScopeKey?: string,
  state?: {
    readonly selectedRevision: GitHistoryRevision | null | undefined;
    readonly onSelectedRevisionChange: (
      selectedRevision: GitHistoryRevision | null | undefined,
    ) => void;
  },
) {
  const scopeKey = requestedScopeKey ?? `${environmentId}:${cwd}`;
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState(() => ({
    scopeKey,
    selectedRevision: state?.selectedRevision,
  }));
  const selectedRevisionValue =
    state !== undefined
      ? state.selectedRevision
      : selectedRevisionState.scopeKey === scopeKey
        ? selectedRevisionState.selectedRevision
        : undefined;
  if (selectedRevisionState.scopeKey !== scopeKey) {
    setSelectedRevision({ scopeKey, selectedRevision: state?.selectedRevision });
  }
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const {
    deferredRefFilter,
    normalizedRefFilter,
    shouldLoadRemote,
    shouldLoadTags,
    refs,
    remote,
    tags,
    localRefs,
    remoteRefs,
    tagRefs,
    localRefTree,
    remoteRefTree,
    tagRefTree,
  } = useGitHistoryRefCatalog(
    environmentId,
    cwd,
    revision,
    refFilter,
    expandedRefKeys,
    selectedRevisionValue,
  );
  const { favoriteBranchSet, favoriteRefs, setFavoriteBranches } = useGitHistoryFavorites(
    environmentId,
    refs.data?.repositoryKey ?? null,
    localRefs,
    normalizedRefFilter,
  );
  const currentRefResult = refs.data?.currentRef;
  const [lastResolvedCurrentRef, setLastResolvedCurrentRef] = useState<{
    scopeKey: string;
    value: VcsHistoryRef | null | undefined;
  }>({ scopeKey, value: undefined });
  if (
    lastResolvedCurrentRef.scopeKey !== scopeKey ||
    (currentRefResult !== undefined && lastResolvedCurrentRef.value !== currentRefResult)
  ) {
    setLastResolvedCurrentRef({ scopeKey, value: currentRefResult });
  }
  const currentRef =
    currentRefResult !== undefined
      ? currentRefResult
      : lastResolvedCurrentRef.scopeKey === scopeKey
        ? lastResolvedCurrentRef.value
        : undefined;
  const defaultSelectedRevision = (() => {
    if (currentRef === undefined) return refs.error === null ? undefined : null;
    if (currentRef === null) return null;
    return { label: currentRef.name, revision: `refs/heads/${currentRef.name}` };
  })();
  const resolveSelectedRefRemoval = () => {
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
  };
  const toggleRefKey = (key: string) => {
    setExpandedRefKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectRef = (label: string, revision: string) => {
    const next = { label, revision };
    setSelectedRevision({ scopeKey, selectedRevision: next });
    state?.onSelectedRevisionChange(next);
  };
  const selectAllRefs = () => {
    setSelectedRevision({ scopeKey, selectedRevision: null });
    state?.onSelectedRevisionChange(null);
  };
  const toggleFavorite = (branch: string) => {
    const toggle = (current: ReadonlyArray<string>) => toggleGitHistoryFavorite(current, branch);
    setFavoriteBranches(toggle);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears a deleted ref from the owning panel external state store
  useEffect(() => {
    if (resolveSelectedRefRemoval()) state?.onSelectedRevisionChange(undefined);
  }, [resolveSelectedRefRemoval, state]);
  const selectedRefWasRemoved = resolveSelectedRefRemoval();
  if (state === undefined && selectedRefWasRemoved) {
    setSelectedRevision({ scopeKey, selectedRevision: undefined });
  }
  const selectedRevision =
    selectedRevisionValue === undefined || selectedRefWasRemoved
      ? defaultSelectedRevision
      : selectedRevisionValue;
  const initialLocalRefError =
    currentRef === undefined && selectedRevisionValue === undefined ? refs.error : null;
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
