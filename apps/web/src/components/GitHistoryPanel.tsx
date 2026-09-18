import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitCommitChangedFile, GitHistoryCommit } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { FileIcon, GitBranchIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
  type SetStateAction,
} from "react";

import { layoutGitHistoryGraph } from "../lib/gitHistoryGraph";
import { cn } from "../lib/utils";
import { useClientSettings } from "../hooks/useSettings";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentConnectionState } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { isVcsSnapshotExpiredCause, makeVcsSnapshotCacheKey } from "../state/queries";
import { usePaginatedSnapshotPages } from "../state/snapshotPages";
import { CommitDetailsPane } from "./git-history/GitHistoryCommitDetails";
import { CommitDiffView } from "./git-history/GitHistoryCommitDiff";
import {
  CommitRow,
  gitHistoryRowHeight,
  currentHeadHash,
  firstParentHashes,
  graphColumnWidth,
  queryErrorMessage,
} from "./git-history/GitHistoryCommitList";
import { PaneResizeHandle } from "./git-history/GitHistoryPaneResizeHandle";
import { GitRefsPane } from "./git-history/GitHistoryRefsPane";
import type { CommitRefKind, GitHistoryRow } from "./git-history/GitHistoryVisualTypes";
import { useGitHistoryRefs } from "./git-history/useGitHistoryRefs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

const HISTORY_PAGE_SIZE = 100;
const WIDE_HISTORY_LAYOUT_MIN_WIDTH = 1120;
const REFS_PANE_MIN_WIDTH = 176;
const REFS_PANE_MAX_WIDTH = 480;
const DETAILS_PANE_MIN_WIDTH = 256;
const DETAILS_PANE_MAX_WIDTH = 720;
const HISTORY_CONTENT_MIN_WIDTH = 320;
const PANE_RESIZE_HANDLE_TOTAL_WIDTH = 16;

interface GitHistoryPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  active?: boolean;
}

export function isWideHistoryLayout(width: number): boolean {
  return width >= WIDE_HISTORY_LAYOUT_MIN_WIDTH;
}

function clampHistoryPaneWidths(input: {
  readonly panelWidth: number;
  readonly refsPaneWidth: number;
  readonly detailsPaneWidth: number;
}): { readonly refsPaneWidth: number; readonly detailsPaneWidth: number } {
  const maxSidePaneWidth = Math.max(
    REFS_PANE_MIN_WIDTH + DETAILS_PANE_MIN_WIDTH,
    input.panelWidth - HISTORY_CONTENT_MIN_WIDTH - PANE_RESIZE_HANDLE_TOTAL_WIDTH,
  );
  const refsPaneWidth = Math.min(
    Math.min(REFS_PANE_MAX_WIDTH, maxSidePaneWidth - DETAILS_PANE_MIN_WIDTH),
    Math.max(REFS_PANE_MIN_WIDTH, input.refsPaneWidth),
  );
  const detailsPaneWidth = Math.min(
    Math.min(DETAILS_PANE_MAX_WIDTH, maxSidePaneWidth - refsPaneWidth),
    Math.max(DETAILS_PANE_MIN_WIDTH, input.detailsPaneWidth),
  );
  return { refsPaneWidth, detailsPaneWidth };
}

function useHistoryPanelLayout(
  panelRef: RefObject<HTMLElement | null>,
  onResize: (width: number) => void,
): {
  readonly isWide: boolean;
  readonly widthRef: RefObject<number>;
} {
  const widthRef = useRef(Number.POSITIVE_INFINITY);
  const onResizeRef = useRef(onResize);
  const [isWide, setIsWide] = useState(true);
  onResizeRef.current = onResize;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      const nextIsWide = isWideHistoryLayout(width);
      if (nextIsWide !== isWideHistoryLayout(widthRef.current)) setIsWide(nextIsWide);
      widthRef.current = width;
      onResizeRef.current(width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef]);

  return { isWide, widthRef };
}

function GitHistoryPanelContent(props: GitHistoryPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const interfaceFontSize = useClientSettings((settings) => settings.fontSizeInterface);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const rowHeight = gitHistoryRowHeight(interfaceFontSize);
  const baseTargetKey = `${props.environmentId}:${props.cwd}`;
  const connection = useEnvironmentConnectionState(props.environmentId).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [paneWidths, setPaneWidths] = useState({ refsPaneWidth: 256, detailsPaneWidth: 384 });
  const { refsPaneWidth, detailsPaneWidth } = paneWidths;
  const { isWide: isWideLayout, widthRef: panelWidthRef } = useHistoryPanelLayout(
    panelRef,
    (panelWidth) => {
      if (!isWideHistoryLayout(panelWidth)) return;
      const nextWidths = clampHistoryPaneWidths({ panelWidth, ...paneWidths });
      if (
        nextWidths.refsPaneWidth !== paneWidths.refsPaneWidth ||
        nextWidths.detailsPaneWidth !== paneWidths.detailsPaneWidth
      ) {
        setPaneWidths(nextWidths);
      }
    },
  );
  const vcsHistoryRevision = useAtomValue(
    vcsEnvironment.historyRevisionAtom({ environmentId: props.environmentId, cwd: props.cwd }),
  );
  const historyRefs = useGitHistoryRefs(props.environmentId, props.cwd, vcsHistoryRevision);
  const { selectedRevision } = historyRefs;
  const refSelectionError = historyRefs.initialLocalRefError;
  const targetKey = `${baseTargetKey}:${selectedRevision?.revision ?? "all"}:${vcsHistoryRevision}:${connectionGeneration}`;
  const makeHistoryPageAtom = useMemo(() => {
    if (selectedRevision === undefined || refSelectionError !== null) return null;
    return (cursor: string | undefined, generation: number) =>
      vcsEnvironment.getHistory({
        environmentId: props.environmentId,
        cacheKey: makeVcsSnapshotCacheKey(generation, vcsHistoryRevision),
        input: {
          cwd: props.cwd,
          ...(selectedRevision === null ? {} : { revision: selectedRevision.revision }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: HISTORY_PAGE_SIZE,
        },
      });
  }, [props.cwd, props.environmentId, refSelectionError, selectedRevision, vcsHistoryRevision]);
  const pagination = usePaginatedSnapshotPages({
    targetKey: selectedRevision === undefined || refSelectionError !== null ? null : targetKey,
    label: "web:vcs-history-pages",
    makePageAtom: makeHistoryPageAtom,
    getNextCursor: (page) => (page.hasMore ? page.nextCursor : null),
    isExpiredError: isVcsSnapshotExpiredCause,
  });
  const { results, values } = pagination;
  const failed = pagination.failed;
  const error = failed?._tag === "Failure" ? queryErrorMessage(failed.cause) : null;
  const isPending =
    refSelectionError === null &&
    (selectedRevision === undefined || results.some((result) => result.waiting));
  const isInitialLoad =
    refSelectionError === null &&
    (selectedRevision === undefined || (values.length === 0 && isPending));
  const history = useMemo(() => {
    const commitsByHash = new Map<string, GitHistoryCommit>();
    for (const value of values) {
      for (const commit of value.commits) {
        if (!commitsByHash.has(commit.hash)) commitsByHash.set(commit.hash, commit);
      }
    }
    return [...commitsByHash.values()];
  }, [values]);
  const isRepo = values[0]?.isRepo ?? true;
  const lastPage = values.at(-1) ?? null;
  const nextCursor = lastPage?.nextCursor ?? null;
  const hasMoreFromServer = lastPage?.hasMore === true && nextCursor !== null;
  const historyCapped = values.some((value) => value.capped === true) && !hasMoreFromServer;
  const hasMore = hasMoreFromServer;
  const isFetchingNextPage = pagination.isFetchingNextPage;
  const [filterState, setFilterState] = useState({ targetKey, value: "" });
  const filter = filterState.targetKey === targetKey ? filterState.value : "";
  if (filterState.targetKey !== targetKey) setFilterState({ targetKey, value: "" });
  const setFilter = (value: string) => setFilterState({ targetKey, value });
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const deferredFilter = useDeferredValue(normalizedFilter);
  const activeFilter = normalizedFilter.length === 0 ? "" : deferredFilter;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectionState, setSelectionState] = useState<{
    readonly targetKey: string;
    readonly hash: string | null;
    readonly diffRequest: { readonly hash: string; readonly filePath?: string } | null;
  }>({ targetKey, hash: null, diffRequest: null });
  const selection =
    selectionState.targetKey === targetKey
      ? selectionState
      : { targetKey, hash: null, diffRequest: null };
  if (selectionState.targetKey !== targetKey) setSelectionState(selection);
  const selectedHash = selection.hash;
  const setSelectedHash = (next: SetStateAction<string | null>) => {
    setSelectionState((current) => {
      const previous = current.targetKey === targetKey ? current.hash : null;
      return {
        targetKey,
        hash: typeof next === "function" ? next(previous) : next,
        diffRequest: null,
      };
    });
  };
  const [mobilePaneState, setMobilePaneState] = useState<{
    readonly targetKey: string;
    readonly pane: "refs" | "details" | null;
  }>({ targetKey, pane: null });
  const mobilePane =
    mobilePaneState.targetKey === targetKey || mobilePaneState.pane === "refs"
      ? mobilePaneState.pane
      : null;
  if (mobilePaneState.targetKey !== targetKey) {
    setMobilePaneState({ targetKey, pane: mobilePane });
  }
  const setMobilePane = (next: SetStateAction<typeof mobilePane>) => {
    setMobilePaneState((current) => ({
      targetKey,
      pane:
        typeof next === "function"
          ? next(current.targetKey === targetKey ? current.pane : null)
          : next,
    }));
  };
  const previousMobilePane = useRef<typeof mobilePane>(null);
  const branchesButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const commitDiffRequest = selection.diffRequest;
  const setCommitDiffRequest = (request: typeof commitDiffRequest) => {
    setSelectionState((current) => ({
      targetKey,
      hash: current.targetKey === targetKey ? current.hash : null,
      diffRequest: request,
    }));
  };
  const showCommitDiff = (hash: string, filePath?: string) => {
    setMobilePane(null);
    setCommitDiffRequest(filePath ? { hash, filePath } : { hash });
  };
  const openMobilePane = (pane: "refs" | "details") => {
    setCommitDiffRequest(null);
    setMobilePane((current) => (current === pane ? null : pane));
  };
  const commitDetailsQuery = useEnvironmentQuery(
    selectedHash === null
      ? null
      : vcsEnvironment.getCommitDetails({
          environmentId: props.environmentId,
          cacheKey: vcsHistoryRevision,
          input: { cwd: props.cwd, hash: selectedHash },
        }),
  );
  const selectedCommitDetails = commitDetailsQuery.data?.commit ?? null;
  const makeCommitFilesPageAtom = useMemo(() => {
    if (selectedHash === null) return null;
    return (cursor: string | undefined, generation: number) =>
      vcsEnvironment.listCommitFiles({
        environmentId: props.environmentId,
        cacheKey: makeVcsSnapshotCacheKey(generation, vcsHistoryRevision),
        input: {
          cwd: props.cwd,
          hash: selectedHash,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
  }, [props.cwd, props.environmentId, selectedHash, vcsHistoryRevision]);
  const commitFilesPagination = usePaginatedSnapshotPages({
    targetKey:
      selectedHash === null ? null : `${baseTargetKey}:${vcsHistoryRevision}:${selectedHash}`,
    label: "web:vcs-commit-files-pages",
    makePageAtom: makeCommitFilesPageAtom,
    getNextCursor: (page) => (page.hasMore ? page.nextCursor : null),
    maxPages: 20,
    isExpiredError: isVcsSnapshotExpiredCause,
  });
  const selectedCommitFiles = useMemo(() => {
    const files = new Map<string, GitCommitChangedFile>();
    for (const page of commitFilesPagination.values) {
      for (const file of page.files) files.set(file.path, file);
    }
    return [...files.values()].slice(0, 2_000);
  }, [commitFilesPagination.values]);
  const lastCommitFilesPage = commitFilesPagination.values.at(-1);
  const commitFilesHasMore =
    lastCommitFilesPage?.hasMore === true && selectedCommitFiles.length < 2_000;
  const commitFilesCapped =
    lastCommitFilesPage?.capped === true || selectedCommitFiles.length >= 2_000;
  const loadMoreCommitFiles = commitFilesPagination.loadNext;
  const commitDiffQuery = useEnvironmentQuery(
    commitDiffRequest === null
      ? null
      : vcsEnvironment.getCommitDiff({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            hash: commitDiffRequest.hash,
            ...(commitDiffRequest.filePath ? { filePath: commitDiffRequest.filePath } : {}),
          },
        }),
  );
  const {
    currentRef = null,
    expandedRefKeys,
    favoriteBranches,
    favoriteRefs,
    hasMoreRefs,
    isFetchingMoreRefs,
    isRefSnapshotComplete,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs,
    onRetryRefs,
    refreshRefs,
    refPaginationError,
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs: selectAllHistoryRefs,
    selectRef: selectHistoryRef,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleFavorite,
    toggleRefKey,
  } = historyRefs;
  const commitRefKinds = useMemo(() => {
    const kinds = new Map<string, CommitRefKind>();
    for (const ref of localRefs) kinds.set(ref.name, "local");
    for (const ref of remoteRefs) kinds.set(ref.name, "remote");
    for (const ref of tagRefs) kinds.set(ref.name, "tag");
    return kinds;
  }, [localRefs, remoteRefs, tagRefs]);
  const selectRef = useCallback(
    (label: string, revision: string) => {
      selectHistoryRef(label, revision);
      setMobilePane(null);
    },
    [selectHistoryRef],
  );
  const selectAllRefs = useCallback(() => {
    selectAllHistoryRefs();
    setMobilePane(null);
  }, [selectAllHistoryRefs]);
  const refPaneProps = {
    refFilter,
    onRefFilterChange: setRefFilter,
    selectedRevision: selectedRevision ?? null,
    onSelectAll: selectAllRefs,
    currentRef,
    onSelectRef: selectRef,
    normalizedRefFilter,
    localRefTree,
    favoriteRefs,
    favoriteBranches,
    onToggleFavorite: toggleFavorite,
    remoteRefTree,
    tagRefTree,
    expandedRefKeys,
    onToggleRefKey: toggleRefKey,
    hasMoreRefs,
    isFetchingMoreRefs,
    isRefSnapshotComplete,
    onLoadMoreRefs,
    onRetryRefs,
    refPaginationError,
  } satisfies Omit<ComponentProps<typeof GitRefsPane>, "className" | "id" | "onClose">;

  useEffect(() => {
    if (isWideLayout) setMobilePane(null);
  }, [isWideLayout]);

  const headHash = useMemo(() => currentHeadHash(history), [history]);
  const primaryHashes = useMemo(() => firstParentHashes(history, headHash), [headHash, history]);
  const filteredHistory = useMemo(() => {
    const query = activeFilter;
    return history.filter(
      (commit) =>
        query.length === 0 ||
        `${commit.hash} ${commit.subject} ${commit.authorName} ${commit.refs.join(" ")}`
          .toLocaleLowerCase()
          .includes(query),
    );
  }, [activeFilter, history]);
  const { laneCount, rows: graphRows } = useMemo(
    () =>
      layoutGitHistoryGraph(filteredHistory, {
        includeMissingParents: activeFilter.length === 0,
        ...(headHash ? { primaryHash: headHash } : {}),
        primaryHashes,
      }),
    [activeFilter, filteredHistory, headHash, primaryHashes],
  );
  const filteredRows = useMemo(() => {
    return filteredHistory.map((commit, index) => ({ commit, graph: graphRows[index]! }));
  }, [filteredHistory, graphRows]);

  useEffect(() => {
    if (selectedHash !== null && !history.some((commit) => commit.hash === selectedHash)) {
      setSelectedHash(null);
    }
  }, [history, selectedHash]);

  useEffect(() => {
    if (props.active === false) setMobilePane(null);
  }, [props.active]);

  useEffect(() => {
    const previous = previousMobilePane.current;
    previousMobilePane.current = mobilePane;
    if (mobilePane !== null || previous === null) return;
    (previous === "refs" ? branchesButtonRef.current : detailsButtonRef.current)?.focus();
  }, [mobilePane]);

  const refresh = useCallback(() => {
    pagination.refresh();
    refreshRefs();
  }, [pagination.refresh, refreshRefs]);
  const loadNext = pagination.loadNext;
  const retryFailedPage = pagination.retry;

  return (
    <section
      ref={panelRef}
      className="@container/history-list flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Git history"
    >
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2"
        inert={mobilePane !== null ? true : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge
            variant="outline"
            className="min-w-0 max-w-64"
            title={selectedRevision?.label ?? "All refs"}
          >
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedRevision?.label ?? "All refs"}</span>
          </Badge>
          {history.length > 0 ? (
            <span className="hidden text-[0.6875rem] tabular-nums text-muted-foreground min-[440px]:inline">
              {history.length} commits
            </span>
          ) : null}
        </div>
        {!isWideLayout ? (
          <>
            <Button
              ref={branchesButtonRef}
              variant="ghost"
              size="xs"
              onClick={() => openMobilePane("refs")}
              aria-controls="git-history-refs-panel"
              aria-expanded={mobilePane === "refs"}
            >
              <GitBranchIcon className="size-3.5" /> Branches
            </Button>
            <Button
              ref={detailsButtonRef}
              variant="ghost"
              size="xs"
              onClick={() => openMobilePane("details")}
              disabled={selectedHash === null}
              aria-controls="git-history-details-panel"
              aria-expanded={mobilePane === "details"}
            >
              <FileIcon className="size-3.5" /> Details
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
          disabled={isPending}
          aria-label="Refresh Git history"
        >
          <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
        </Button>
      </header>
      {commitDiffRequest ? (
        <CommitDiffView
          hash={commitDiffRequest.hash}
          {...(commitDiffRequest.filePath ? { filePath: commitDiffRequest.filePath } : {})}
          files={selectedCommitFiles}
          filesError={commitFilesPagination.failed !== null}
          filesHasMore={commitFilesHasMore}
          filesLoading={commitFilesPagination.isPending}
          diff={commitDiffQuery.data?.diff ?? null}
          truncated={commitDiffQuery.data?.truncated ?? false}
          isPending={commitDiffQuery.isPending}
          error={commitDiffQuery.error}
          onBack={() => setCommitDiffRequest(null)}
          onSelectFile={(filePath) =>
            setCommitDiffRequest(
              filePath
                ? { hash: commitDiffRequest.hash, filePath }
                : { hash: commitDiffRequest.hash },
            )
          }
          onRetry={commitDiffQuery.refresh}
          onLoadMoreFiles={loadMoreCommitFiles}
          onRetryFiles={commitFilesPagination.retry}
        />
      ) : refSelectionError || isInitialLoad ? (
        <div className="relative flex min-h-0 flex-1">
          {isWideLayout ? (
            <GitRefsPane
              className="!border-r-0"
              style={{
                width: refsPaneWidth,
                minWidth: refsPaneWidth,
                maxWidth: refsPaneWidth,
                flexBasis: refsPaneWidth,
              }}
              {...refPaneProps}
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            {refSelectionError ? (
              <>
                <p className="text-xs text-destructive">{refSelectionError}</p>
                <Button size="sm" variant="outline" onClick={onRetryRefs}>
                  Retry refs
                </Button>
              </>
            ) : (
              <div className="flex items-center text-xs text-muted-foreground">
                <RefreshCwIcon className="mr-2 size-3.5 animate-spin" />
                <span>Loading history…</span>
              </div>
            )}
          </div>
        </div>
      ) : error && history.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : refPaginationError && history.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-destructive">{refPaginationError}</p>
          <Button size="sm" variant="outline" onClick={onRetryRefs}>
            Retry refs
          </Button>
        </div>
      ) : !isRepo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This folder is not a Git repository.
        </div>
      ) : history.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This repository has no commits yet.
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {isWideLayout ? (
            <GitRefsPane
              className="!border-r-0"
              style={{
                width: refsPaneWidth,
                minWidth: refsPaneWidth,
                maxWidth: refsPaneWidth,
                flexBasis: refsPaneWidth,
              }}
              {...refPaneProps}
            />
          ) : null}
          {isWideLayout ? (
            <PaneResizeHandle
              label="Resize branches pane"
              value={refsPaneWidth}
              min={REFS_PANE_MIN_WIDTH}
              max={REFS_PANE_MAX_WIDTH}
              onMove={(delta) =>
                setPaneWidths((widths) =>
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: widths.refsPaneWidth + delta,
                    detailsPaneWidth: widths.detailsPaneWidth,
                  }),
                )
              }
              onReset={() =>
                setPaneWidths((widths) =>
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: 256,
                    detailsPaneWidth: widths.detailsPaneWidth,
                  }),
                )
              }
            />
          ) : null}
          <div
            className="@container min-h-0 min-w-0 flex-1 overflow-hidden"
            inert={mobilePane !== null ? true : undefined}
          >
            <div className="flex h-full min-w-0 flex-col">
              <div className="relative shrink-0 border-b border-border/60 p-2">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  className="h-7 w-full rounded border border-input bg-background/30 pr-7 pl-7 text-[0.6875rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || filter.length === 0) return;
                    event.preventDefault();
                    setFilter("");
                  }}
                  placeholder="Text or hash"
                  aria-label="Filter Git history"
                />
                {filter.length > 0 ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="absolute top-1/2 right-3 size-5 -translate-y-1/2 rounded-sm text-muted-foreground"
                    aria-label="Clear Git history search"
                    onClick={() => {
                      setFilter("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              {error ? (
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[0.6875rem] text-destructive">
                  <span className="truncate">{error}</span>
                  <Button size="xs" variant="ghost" className="shrink-0" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              <div className="flex h-7 shrink-0 items-center border-b border-border/70 bg-muted/20 text-[0.625rem] font-medium text-muted-foreground">
                <div className="shrink-0" style={{ width: graphColumnWidth(laneCount) }} />
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)_minmax(5rem,7rem)_8.5rem_5rem] gap-x-3 pr-3 @max-[720px]:grid-cols-[minmax(10rem,1fr)_5rem]">
                  <span>Subject</span>
                  <span className="@max-[720px]:hidden" />
                  <span className="@max-[720px]:hidden">Author</span>
                  <span className="@max-[720px]:hidden">Date</span>
                  <span>Hash</span>
                </div>
              </div>
              {filteredRows.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
                  <span className={error ? "text-destructive" : undefined}>
                    {error ?? "No loaded commits match this filter."}
                  </span>
                  {error || hasMore ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={error ? retryFailedPage : loadNext}
                      disabled={isFetchingNextPage}
                    >
                      {isFetchingNextPage
                        ? "Searching older commits…"
                        : error
                          ? "Retry older commits"
                          : "Search older commits"}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <LegendList<GitHistoryRow>
                  data={filteredRows}
                  keyExtractor={(row) => row.commit.hash}
                  renderItem={({ item }) => (
                    <CommitRow
                      row={item}
                      laneCount={laneCount}
                      rowHeight={rowHeight}
                      refKinds={commitRefKinds}
                      timestampFormat={timestampFormat}
                      selected={item.commit.hash === selectedHash}
                      onSelect={setSelectedHash}
                    />
                  )}
                  estimatedItemSize={rowHeight}
                  drawDistance={rowHeight * 8}
                  recycleItems={false}
                  className="min-h-0 flex-1 overscroll-y-contain"
                />
              )}
              {filteredRows.length > 0 && (hasMore || isFetchingNextPage) ? (
                <div className="flex shrink-0 justify-center border-t border-border/50 p-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={loadNext}
                    disabled={isFetchingNextPage}
                  >
                    {isFetchingNextPage ? "Loading more…" : "Load more"}
                  </Button>
                </div>
              ) : null}
              {filteredRows.length > 0 && historyCapped ? (
                <div className="shrink-0 border-t border-border/50 px-3 py-2 text-center text-[0.6875rem] text-muted-foreground">
                  <span>History results were capped by the server.</span>
                </div>
              ) : null}
            </div>
          </div>
          {isWideLayout ? (
            <PaneResizeHandle
              label="Resize commit details pane"
              value={detailsPaneWidth}
              min={DETAILS_PANE_MIN_WIDTH}
              max={DETAILS_PANE_MAX_WIDTH}
              onMove={(delta) =>
                setPaneWidths((widths) =>
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: widths.refsPaneWidth,
                    detailsPaneWidth: widths.detailsPaneWidth - delta,
                  }),
                )
              }
              onReset={() =>
                setPaneWidths((widths) =>
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: widths.refsPaneWidth,
                    detailsPaneWidth: 384,
                  }),
                )
              }
            />
          ) : null}
          {isWideLayout ? (
            <CommitDetailsPane
              className="!border-l-0"
              style={{
                width: detailsPaneWidth,
                minWidth: detailsPaneWidth,
                maxWidth: detailsPaneWidth,
                flexBasis: detailsPaneWidth,
              }}
              details={selectedCommitDetails}
              timestampFormat={timestampFormat}
              files={selectedCommitFiles}
              filesCapped={commitFilesCapped}
              filesHasMore={commitFilesHasMore}
              filesError={commitFilesPagination.failed !== null}
              filesLoading={commitFilesPagination.isPending}
              onLoadMoreFiles={loadMoreCommitFiles}
              onRetryFiles={commitFilesPagination.retry}
              isPending={commitDetailsQuery.isPending}
              hasError={commitDetailsQuery.error !== null}
              hasSelection={selectedHash !== null}
              onRetry={commitDetailsQuery.refresh}
              onShowDiff={showCommitDiff}
            />
          ) : null}
        </div>
      )}
      {!isWideLayout && mobilePane === "refs" ? (
        <Sheet open onOpenChange={(open) => !open && setMobilePane(null)}>
          <SheetPopup side="left" showCloseButton={false} className="w-full max-w-none p-0">
            <SheetTitle className="sr-only">Branches and tags</SheetTitle>
            <GitRefsPane
              id="git-history-refs-panel"
              className="!w-full !min-w-0 !max-w-none !flex-1 !border-r-0 !bg-background"
              {...refPaneProps}
              onClose={() => setMobilePane(null)}
            />
          </SheetPopup>
        </Sheet>
      ) : null}
      {!isWideLayout && mobilePane === "details" ? (
        <Sheet open onOpenChange={(open) => !open && setMobilePane(null)}>
          <SheetPopup side="right" showCloseButton className="w-full max-w-none p-0">
            <SheetTitle className="sr-only">Commit details</SheetTitle>
            <CommitDetailsPane
              id="git-history-details-panel"
              className="!w-full !min-w-0 !max-w-none !flex-1 !border-l-0"
              details={selectedCommitDetails}
              timestampFormat={timestampFormat}
              files={selectedCommitFiles}
              filesCapped={commitFilesCapped}
              filesHasMore={commitFilesHasMore}
              filesError={commitFilesPagination.failed !== null}
              filesLoading={commitFilesPagination.isPending}
              onLoadMoreFiles={loadMoreCommitFiles}
              onRetryFiles={commitFilesPagination.retry}
              isPending={commitDetailsQuery.isPending}
              hasError={commitDetailsQuery.error !== null}
              hasSelection={selectedHash !== null}
              onRetry={commitDetailsQuery.refresh}
              onShowDiff={showCommitDiff}
            />
          </SheetPopup>
        </Sheet>
      ) : null}
    </section>
  );
}

export default function GitHistoryPanel(props: GitHistoryPanelProps) {
  return <GitHistoryPanelContent key={`${props.environmentId}:${props.cwd}`} {...props} />;
}
