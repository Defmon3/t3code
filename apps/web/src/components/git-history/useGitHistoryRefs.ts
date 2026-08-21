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

type GitHistoryRefNamespace = "local" | "remote" | "tag";

function selectedRefValidationTarget(
  revision: string | undefined,
): { readonly name: string; readonly namespace: GitHistoryRefNamespace } | null {
  if (revision?.startsWith("refs/heads/")) {
    return { name: revision.slice("refs/heads/".length), namespace: "local" };
  }
  if (revision?.startsWith("refs/remotes/")) {
    return { name: revision.slice("refs/remotes/".length), namespace: "remote" };
  }
  if (revision?.startsWith("refs/tags/")) {
    return { name: revision.slice("refs/tags/".length), namespace: "tag" };
  }
  return null;
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
  const selectedRevision = selectedRevisionState?.revision;
  const shouldLoadRemote =
    debouncedRefFilter.length > 0 ||
    expandedRefKeys.has("section:remote") ||
    selectedRevision?.startsWith("refs/remotes/") === true;
  const shouldLoadTags =
    debouncedRefFilter.length > 0 ||
    expandedRefKeys.has("section:tags") ||
    selectedRevision?.startsWith("refs/tags/") === true;
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
  const validationTarget = selectedRefValidationTarget(selectedRevision);
  const selectedRefKnown =
    validationTarget?.namespace === "local"
      ? localRefs.some((ref) => ref.name === validationTarget.name)
      : validationTarget?.namespace === "remote"
        ? remoteRefs.some((ref) => ref.name === validationTarget.name)
        : validationTarget?.namespace === "tag"
          ? tagRefs.some((ref) => ref.name === validationTarget.name)
          : false;
  const shouldValidateSelectedRef =
    validationTarget !== null && debouncedRefFilter.length === 0 && !selectedRefKnown;
  const selectedRefValidation = usePaginatedHistoryRefs(
    shouldValidateSelectedRef
      ? { environmentId, cwd, query: validationTarget?.name ?? "" }
      : { environmentId: null, cwd: null },
    {
      limit: 200,
      namespace: validationTarget?.namespace ?? "local",
      revision,
    },
  );
  const selectedRefFoundByValidation =
    validationTarget !== null &&
    selectedRefValidation.refs.some((ref) => ref.name === validationTarget.name);
  const currentRef = refs.data?.currentRef;
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
    if (validationTarget === null || debouncedRefFilter.length > 0 || selectedRefKnown)
      return false;
    return (
      shouldValidateSelectedRef &&
      selectedRefValidation.data?.isComplete === true &&
      selectedRefValidation.data.nextCursor === null &&
      !selectedRefFoundByValidation
    );
  }, [
    debouncedRefFilter,
    selectedRefFoundByValidation,
    selectedRefKnown,
    selectedRefValidation.data?.isComplete,
    selectedRefValidation.data?.nextCursor,
    shouldValidateSelectedRef,
    validationTarget,
  ]);
  const resolvedSelectedRevision =
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

  useEffect(() => {
    if (
      !shouldValidateSelectedRef ||
      selectedRefFoundByValidation ||
      selectedRefValidation.data?.nextCursor === null ||
      selectedRefValidation.data?.nextCursor === undefined ||
      selectedRefValidation.isFetchingNextPage
    )
      return;
    selectedRefValidation.loadNext();
  }, [
    selectedRefFoundByValidation,
    selectedRefValidation.data?.nextCursor,
    selectedRefValidation.isFetchingNextPage,
    selectedRefValidation.loadNext,
    shouldValidateSelectedRef,
  ]);

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
      if (shouldValidateSelectedRef) selectedRefValidation.refresh();
    },
    onRetryRefs: () => {
      if (refs.error) refs.retry();
      if (remote.error) remote.retry();
      if (tags.error) tags.retry();
      if (shouldValidateSelectedRef && selectedRefValidation.error) selectedRefValidation.retry();
    },
    refPaginationError:
      refs.error ??
      remote.error ??
      tags.error ??
      (shouldValidateSelectedRef ? selectedRefValidation.error : null),
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs,
    selectRef,
    selectedRevision: resolvedSelectedRevision,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleRefKey,
    toggleFavorite,
  };
}
