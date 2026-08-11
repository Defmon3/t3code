import type { EnvironmentId, VcsRef } from "@t3tools/contracts";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { usePaginatedBranches } from "../../state/queries";

export interface GitHistoryRevision {
  readonly label: string;
  readonly revision: string;
}

export function useGitHistoryRefs(environmentId: EnvironmentId, cwd: string) {
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState<
    GitHistoryRevision | null | undefined
  >(undefined);
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const deferredRefFilter = useDeferredValue(refFilter.trim());
  const normalizedRefFilter = refFilter.trim().toLocaleLowerCase();
  const refs = usePaginatedBranches(
    { environmentId, cwd, query: deferredRefFilter },
    { limit: 200, includeMatchingRemoteRefs: true, refKind: "all" },
  );
  const tags = usePaginatedBranches(
    { environmentId, cwd, query: deferredRefFilter },
    { limit: 200, refKind: "tag" },
  );
  const mergedRefs = refs.refs;
  const tagRefs = tags.refs;
  const { localRefs, remoteRefs } = useMemo(() => {
    const local: VcsRef[] = [];
    const remote: VcsRef[] = [];
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
  const remoteRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(remoteRefs), normalizedRefFilter),
    [normalizedRefFilter, remoteRefs],
  );
  const tagRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(tagRefs), normalizedRefFilter),
    [normalizedRefFilter, tagRefs],
  );
  const currentRef = useMemo(() => localRefs.find((ref) => ref.current) ?? null, [localRefs]);
  const selectedRevision =
    selectedRevisionState === undefined
      ? currentRef === null
        ? null
        : { label: currentRef.name, revision: `refs/heads/${currentRef.name}` }
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

  useEffect(() => {
    setSelectedRevision(undefined);
    setRefFilter("");
    setExpandedRefKeys(new Set(["section:local"]));
  }, [cwd, environmentId]);

  return {
    currentRef,
    expandedRefKeys,
    hasMoreRefs:
      (refs.data?.nextCursor !== null && refs.data?.nextCursor !== undefined) ||
      (tags.data?.nextCursor !== null && tags.data?.nextCursor !== undefined),
    isFetchingMoreRefs: refs.isFetchingNextPage || tags.isFetchingNextPage,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs: () => {
      refs.loadNext();
      tags.loadNext();
    },
    refreshRefs: () => {
      refs.refresh();
      tags.refresh();
    },
    onRetryRefs: () => {
      if (refs.error) refs.retry();
      if (tags.error) tags.retry();
    },
    refPaginationError: refs.error ?? tags.error,
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
  };
}
