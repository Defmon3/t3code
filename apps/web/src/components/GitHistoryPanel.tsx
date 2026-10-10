import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "./ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { requiresDefaultBranchConfirmation } from "./GitActionsControl.logic";
import {
  gitHistorySolvePrompt,
  isGitHistorySolveOffer,
  selectedHistoryRef,
} from "./git-history/GitHistorySyncToolbar.logic";
import type { RefTreeProps } from "./git-history/GitHistoryVisualTypes";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GitCommitChangedFile,
  GitHistoryCommit,
  VcsHistorySyncInput,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  HammerIcon,
  FileIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useStore } from "zustand";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
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
import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentQuery } from "../state/query";
import { isVcsSnapshotExpiredCause } from "../state/queries";
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
import {
  createGitHistoryPanelStore,
  type GitHistoryPanelStore,
} from "./git-history/GitHistoryPanelState";
import { GitRefsPane } from "./git-history/GitHistoryRefsPane";
import type { CommitRefKind, GitHistoryRow } from "./git-history/GitHistoryVisualTypes";
import { useGitHistoryRefs } from "./git-history/useGitHistoryRefs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

const HISTORY_PAGE_SIZE = 100;
const WIDE_HISTORY_LAYOUT_MIN_WIDTH = 1120;
const REFS_PANE_MIN_WIDTH = 176;
const REFS_PANE_MAX_WIDTH = 480;
const DETAILS_PANE_MIN_WIDTH = 256;
const DETAILS_PANE_MAX_WIDTH = 720;
const HISTORY_CONTENT_MIN_WIDTH = 320;
const PANE_RESIZE_HANDLE_TOTAL_WIDTH = 16;

type GitHistorySyncRequest = {
  readonly environmentId: EnvironmentId;
  readonly input: VcsHistorySyncInput;
};

type DefaultBranchPushConfirmation = GitHistorySyncRequest & {
  readonly upstreamName: string;
  readonly targetKey: string;
};

interface GitHistoryPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  active?: boolean;
  repositoryIdentity?: import("@t3tools/contracts").RepositoryIdentity | null | undefined;
  onSolveGitSync?: ((prompt: string) => void) | undefined;
  stateStore?: GitHistoryPanelStore;
  stateScopeKey?: string;
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
  const [fallbackStateStore] = useState(createGitHistoryPanelStore);
  const stateStore = props.stateStore ?? fallbackStateStore;
  const interfaceFontSize = useClientSettings((settings) => settings.fontSizeInterface);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const rowHeight = gitHistoryRowHeight(interfaceFontSize);
  const baseTargetKey = `${props.environmentId}:${props.cwd}`;
  const connection = useEnvironmentQuery(environmentCatalog.stateAtom(props.environmentId)).data;
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
  const stateScopeKey = `${props.stateScopeKey ?? ""}:${baseTargetKey}:${connectionGeneration}`;
  const historyState = useStore(stateStore);
  const stateMatchesScope = historyState.scopeKey === stateScopeKey;
  useLayoutEffect(() => {
    stateStore.getState().setScope(stateScopeKey);
  }, [stateScopeKey, stateStore]);
  const historyRefs = useGitHistoryRefs(
    props.environmentId,
    props.cwd,
    vcsHistoryRevision,
    stateScopeKey,
    stateMatchesScope
      ? {
          selectedRevision: historyState.selectedRevision,
          onSelectedRevisionChange: stateStore.getState().setSelectedRevision,
        }
      : undefined,
  );
  const { selectedRevision } = historyRefs;
  const refSelectionError = historyRefs.initialLocalRefError;
  const targetKey = `${stateScopeKey}:${selectedRevision?.revision ?? "all"}`;
  const canSync = useAtomValue(vcsEnvironment.historySync.permissionAtom(props.environmentId));
  const syncHistory = useAtomCommand(vcsEnvironment.historySync, { reportFailure: false });
  const [syncPendingAction, setSyncPendingAction] = useState<"fetch" | "pull" | "push" | null>(
    null,
  );
  const [defaultBranchPushConfirmation, setDefaultBranchPushConfirmation] =
    useState<DefaultBranchPushConfirmation | null>(null);
  const [solvePrompt, setSolvePrompt] = useState<string | null>(null);
  const selectedRef = useMemo(
    () =>
      selectedHistoryRef(selectedRevision, [
        ...historyRefs.localRefs,
        ...historyRefs.remoteRefs,
        ...historyRefs.tagRefs,
      ]),
    [historyRefs.localRefs, historyRefs.remoteRefs, historyRefs.tagRefs, selectedRevision],
  );
  const isDefaultBranchPushConfirmationCurrent =
    defaultBranchPushConfirmation !== null &&
    defaultBranchPushConfirmation.targetKey === targetKey &&
    defaultBranchPushConfirmation.upstreamName === selectedRef?.upstreamName;
  useEffect(() => {
    if (defaultBranchPushConfirmation !== null && !isDefaultBranchPushConfirmationCurrent) {
      setDefaultBranchPushConfirmation(null);
    }
  }, [defaultBranchPushConfirmation, isDefaultBranchPushConfirmationCurrent]);
  const runSync = useCallback(
    async (request: GitHistorySyncRequest) => {
      setSyncPendingAction(request.input.action);
      const result = await syncHistory({
        environmentId: request.environmentId,
        input: request.input,
      });
      setSyncPendingAction(null);
      if (AsyncResult.isSuccess(result)) {
        toastManager.add({ type: "success", title: `Git ${request.input.action} completed` });
        return;
      }
      const error = String(Cause.squash(result.cause));
      if (
        (request.input.action === "pull" || request.input.action === "push") &&
        isGitHistorySolveOffer(error)
      ) {
        setSolvePrompt(
          gitHistorySolvePrompt({
            cwd: request.input.cwd,
            action: request.input.action,
            refName: request.input.refName,
            upstreamName: selectedRef?.upstreamName ?? "unknown",
            error,
          }),
        );
        return;
      }
      toastManager.add({
        type: "error",
        title: `Git ${request.input.action} failed`,
        description: error,
      });
    },
    [selectedRef?.upstreamName, syncHistory],
  );
  const onSync = useCallback(
    (action: "fetch" | "pull" | "push") => {
      if (!canSync || selectedRef === null || selectedRef.isTag || syncPendingAction !== null)
        return;
      const request = {
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          action,
          namespace: selectedRef.isRemote ? "remote" : "local",
          refName: selectedRef.name,
        },
      } satisfies GitHistorySyncRequest;
      if (
        action === "push" &&
        requiresDefaultBranchConfirmation(action, selectedRef.isDefault) &&
        selectedRef.upstreamName !== undefined
      ) {
        setDefaultBranchPushConfirmation({
          ...request,
          upstreamName: selectedRef.upstreamName,
          targetKey,
        });
        return;
      }
      void runSync(request);
    },
    [canSync, props.cwd, props.environmentId, runSync, selectedRef, syncPendingAction, targetKey],
  );
  const stateMatchesTarget = stateMatchesScope && historyState.targetKey === targetKey;
  useLayoutEffect(() => {
    stateStore.getState().setTarget(targetKey);
  }, [stateScopeKey, stateStore, targetKey]);
  const makeHistoryPageAtom = useMemo(() => {
    if (selectedRevision === undefined || refSelectionError !== null) return null;
    return (cursor: string | undefined, generation: number) =>
      vcsEnvironment.getHistory({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          queryGeneration: generation + vcsHistoryRevision,
          ...(selectedRevision === null ? {} : { revision: selectedRevision.revision }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: HISTORY_PAGE_SIZE,
        },
      });
  }, [props.cwd, props.environmentId, refSelectionError, selectedRevision, vcsHistoryRevision]);
  const pagination = usePaginatedSnapshotPages({
    targetKey:
      selectedRevision === undefined || refSelectionError !== null
        ? null
        : `${targetKey}:${vcsHistoryRevision}`,
    label: "web:vcs-history-pages",
    makePageAtom: makeHistoryPageAtom,
    getNextCursor: (page) => (page.hasMore ? page.nextCursor : null),
    isExpiredError: isVcsSnapshotExpiredCause,
    ...(stateMatchesTarget ? { initialPagination: historyState.historyPagination } : {}),
    onPaginationChange: stateStore.getState().setHistoryPagination,
  });
  const { results, values: queriedValues } = pagination;
  const retainedHistory = useRef<{ targetKey: string; values: typeof queriedValues } | null>(null);
  const waitingForHistory = results.some((result) => result.waiting);
  if (queriedValues.length > 0) retainedHistory.current = { targetKey, values: queriedValues };
  const values =
    queriedValues.length === 0 &&
    waitingForHistory &&
    retainedHistory.current?.targetKey === targetKey
      ? retainedHistory.current.values
      : queriedValues;
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
  const hasMore = hasMoreFromServer;
  const isFetchingNextPage = pagination.isFetchingNextPage;
  const filter = stateMatchesTarget ? historyState.filter : "";
  const setFilter = stateStore.getState().setFilter;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const deferredFilter = useDeferredValue(normalizedFilter);
  const activeFilter = normalizedFilter.length === 0 ? "" : deferredFilter;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedHash = stateMatchesTarget ? historyState.selectedHash : null;
  const setSelectedHash = (next: SetStateAction<string | null>) => {
    stateStore
      .getState()
      .setSelectedHash(typeof next === "function" ? next(historyState.selectedHash) : next);
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
  const commitDiffRequest = stateMatchesTarget ? historyState.diffRequest : null;
  const setCommitDiffRequest = (request: typeof commitDiffRequest) => {
    stateStore.getState().setDiffRequest(request);
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
          input: { cwd: props.cwd, hash: selectedHash },
        }),
  );
  const selectedCommitDetails = commitDetailsQuery.data?.commit ?? null;
  const makeCommitFilesPageAtom = useMemo(() => {
    if (selectedHash === null) return null;
    return (cursor: string | undefined, generation: number) =>
      vcsEnvironment.listCommitFiles({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          queryGeneration: generation + vcsHistoryRevision,
          hash: selectedHash,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
  }, [props.cwd, props.environmentId, selectedHash, vcsHistoryRevision]);
  const commitFilesTargetKey =
    selectedHash === null ? null : `${stateScopeKey}:${vcsHistoryRevision}:${selectedHash}`;
  const stateMatchesCommitFiles =
    stateMatchesTarget && historyState.commitFilesTargetKey === commitFilesTargetKey;
  useLayoutEffect(() => {
    stateStore.getState().setCommitFilesTarget(commitFilesTargetKey);
  }, [commitFilesTargetKey, stateStore]);
  const commitFilesPagination = usePaginatedSnapshotPages({
    targetKey: commitFilesTargetKey,
    label: "web:vcs-commit-files-pages",
    makePageAtom: makeCommitFilesPageAtom,
    getNextCursor: (page) => (page.hasMore ? page.nextCursor : null),
    maxPages: 20,
    isExpiredError: isVcsSnapshotExpiredCause,
    ...(stateMatchesCommitFiles ? { initialPagination: historyState.commitFilesPagination } : {}),
    onPaginationChange: stateStore.getState().setCommitFilesPagination,
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
  const sharedRefTreeProps = {
    filterActive: normalizedRefFilter.length > 0,
    expanded: expandedRefKeys,
    selectedRevision: selectedRevision?.revision ?? null,
    favoriteBranches,
    onToggle: toggleRefKey,
    onSelect: selectRef,
    onToggleFavorite: toggleFavorite,
  } satisfies Omit<RefTreeProps, "nodes" | "namespace" | "section">;
  const refPaneProps = {
    canSync,
    refFilter,
    onRefFilterChange: setRefFilter,
    selectedRevision: selectedRevision ?? null,
    onSelectAll: selectAllRefs,
    currentRef,
    onSelectRef: selectRef,
    normalizedRefFilter,
    localRefTree,
    favoriteRefs,
    remoteRefTree,
    tagRefTree,
    expandedRefKeys,
    onToggleRefKey: toggleRefKey,
    sharedRefTreeProps,
    hasMoreRefs,
    isFetchingMoreRefs,
    isRefSnapshotComplete,
    onLoadMoreRefs,
    onRetryRefs,
    refPaginationError,
    selectedRef,
    onSync: (action: "fetch" | "pull" | "push") => void onSync(action),
    syncPendingAction,
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
    if (
      !isPending &&
      selectedHash !== null &&
      !history.some((commit) => commit.hash === selectedHash)
    ) {
      setSelectedHash(null);
    }
  }, [history, isPending, selectedHash]);

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
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
          <Badge
            variant="outline"
            className="w-full min-w-0 max-w-64"
            title={selectedRevision?.label ?? "All refs"}
          >
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedRevision?.label ?? "All refs"}</span>
          </Badge>
          {history.length > 0 ? (
            <span className="hidden text-2xs tabular-nums text-muted-foreground min-[440px]:inline">
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
              className="shrink-0"
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
              className="shrink-0"
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
          className="shrink-0"
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
                  className="h-7 w-full rounded border border-input bg-background/30 pr-7 pl-7 text-2xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
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
                    variant="ghost-muted"
                    className="absolute top-1/2 right-3 -translate-y-1/2"
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
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-2xs text-destructive">
                  <span className="truncate">{error}</span>
                  <Button size="xs" variant="ghost" className="shrink-0" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              <div className="flex h-7 shrink-0 items-center border-b border-border/70 bg-muted/20 text-3xs font-medium text-muted-foreground">
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
                      repositoryIdentity={props.repositoryIdentity}
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
          <SheetPopup side="left" showCloseButton={false} className="w-full max-w-none">
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
          <SheetPopup side="right" showCloseButton className="w-full max-w-none">
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
      <AlertDialog
        open={isDefaultBranchPushConfirmationCurrent}
        onOpenChange={(open) => {
          if (!open) setDefaultBranchPushConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Push to default branch?</AlertDialogTitle>
            <AlertDialogDescription>
              Push {defaultBranchPushConfirmation?.input.refName} to{" "}
              {defaultBranchPushConfirmation?.upstreamName}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (
                  defaultBranchPushConfirmation !== null &&
                  defaultBranchPushConfirmation.targetKey === targetKey &&
                  defaultBranchPushConfirmation.upstreamName === selectedRef?.upstreamName
                ) {
                  void runSync(defaultBranchPushConfirmation);
                }
                setDefaultBranchPushConfirmation(null);
              }}
            >
              Push
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={solvePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setSolvePrompt(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Git sync needs resolution</AlertDialogTitle>
            <AlertDialogDescription>
              Open a draft task for an agent to resolve this Git conflict.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (solvePrompt) props.onSolveGitSync?.(solvePrompt);
                setSolvePrompt(null);
              }}
            >
              <HammerIcon className="size-3.5" />
              Solve
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

export default function GitHistoryPanel(props: GitHistoryPanelProps) {
  return <GitHistoryPanelContent key={`${props.environmentId}:${props.cwd}`} {...props} />;
}
