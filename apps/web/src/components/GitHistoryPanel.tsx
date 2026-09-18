import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GitCommitChangedFile,
  GitHistoryCommit,
  VcsGetHistoryResult,
  VcsHistorySyncInput,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  FileIcon,
  GitBranchIcon,
  HammerIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { toastManager } from "./ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { layoutGitHistoryGraph } from "../lib/gitHistoryGraph";
import { cn } from "../lib/utils";
import { useClientSettings } from "../hooks/useSettings";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery } from "../state/query";
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
import { requiresDefaultBranchConfirmation } from "./GitActionsControl.logic";
import {
  gitHistorySolvePrompt,
  isGitHistorySolveOffer,
  selectedHistoryRef,
} from "./git-history/GitHistorySyncToolbar.logic";
import type {
  CommitRefKind,
  GitHistoryRow,
  RefTreeProps,
} from "./git-history/GitHistoryVisualTypes";
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
const MAX_HISTORY_PAGES = 10;
const INITIAL_CURSORS = [undefined] as const;
const WIDE_HISTORY_LAYOUT_MIN_WIDTH = 1120;
const REFS_PANE_MIN_WIDTH = 176;
const REFS_PANE_MAX_WIDTH = 480;
const DETAILS_PANE_MIN_WIDTH = 256;
const DETAILS_PANE_MAX_WIDTH = 720;

type GitHistorySyncRequest = {
  readonly environmentId: EnvironmentId;
  readonly input: VcsHistorySyncInput;
};

type DefaultBranchPushConfirmation = GitHistorySyncRequest & {
  readonly upstreamName: string;
  readonly targetKey: string;
};

function isHistorySnapshotExpired(cause: Cause.Cause<unknown>): boolean {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  const squashed = Cause.squash(cause);
  return (
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "VcsSnapshotExpiredError") ||
    (typeof squashed === "object" &&
      squashed !== null &&
      "_tag" in squashed &&
      squashed._tag === "VcsSnapshotExpiredError")
  );
}

interface GitHistoryPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  issueUrlPrefix?: string;
  active?: boolean;
  onSolveGitSync?: (prompt: string) => void;
}

export function isWideHistoryLayout(width: number): boolean {
  return width >= WIDE_HISTORY_LAYOUT_MIN_WIDTH;
}

export function appendCommitFilesPage(
  current: ReadonlyArray<GitCommitChangedFile>,
  page: ReadonlyArray<GitCommitChangedFile>,
): ReadonlyArray<GitCommitChangedFile> {
  return [...current, ...page].slice(0, 2_000);
}

export function nextCommitFilesCursor(nextCursor: string | null): string | undefined {
  return nextCursor ?? undefined;
}

export function nextCommitFilesRecoveryGeneration(input: {
  readonly errorCause: Cause.Cause<unknown> | null;
  readonly generation: number;
  readonly recoveryInFlight: boolean;
}): number | null {
  return input.errorCause !== null &&
    isHistorySnapshotExpired(input.errorCause) &&
    !input.recoveryInFlight
    ? input.generation + 1
    : null;
}

export function useWideHistoryLayout(panelRef: RefObject<HTMLElement | null>): boolean {
  const [isWide, setIsWide] = useState(true);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setIsWide(isWideHistoryLayout(entry?.contentRect.width ?? 0));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef]);

  return isWide;
}

export default function GitHistoryPanel(props: GitHistoryPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const isWideLayout = useWideHistoryLayout(panelRef);
  const interfaceFontSize = useClientSettings((settings) => settings.fontSizeInterface);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const rowHeight = gitHistoryRowHeight(interfaceFontSize);
  const baseTargetKey = `${props.environmentId}:${props.cwd}`;
  const [refsPaneWidth, setRefsPaneWidth] = useState(256);
  const [detailsPaneWidth, setDetailsPaneWidth] = useState(384);
  const [historyQueryGeneration, setHistoryQueryGeneration] = useState(0);
  const vcsHistoryRevision = useAtomValue(
    vcsEnvironment.historyRevisionAtom({ environmentId: props.environmentId, cwd: props.cwd }),
  );
  const historyRefs = useGitHistoryRefs(props.environmentId, props.cwd, vcsHistoryRevision);
  const { selectedRevision } = historyRefs;
  const isSelectedRevisionPending = selectedRevision === undefined;
  const resolvedSelectedRevision = selectedRevision ?? null;
  const targetKey = `${baseTargetKey}:${isSelectedRevisionPending ? "pending" : (resolvedSelectedRevision?.revision ?? "all")}`;
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
      if (selectedRef === null || selectedRef.isTag || syncPendingAction !== null) return;
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
    [props.cwd, props.environmentId, runSync, selectedRef, syncPendingAction, targetKey],
  );
  const paginationKey = `${targetKey}:${vcsHistoryRevision}`;
  const [pagination, setPagination] = useState<{
    targetKey: string;
    cursors: ReadonlyArray<string | undefined>;
  }>({ targetKey: paginationKey, cursors: INITIAL_CURSORS });
  const cursors = pagination.targetKey === paginationKey ? pagination.cursors : INITIAL_CURSORS;
  const pageAtoms = useMemo(
    () =>
      isSelectedRevisionPending
        ? []
        : cursors.map((cursor) =>
            vcsEnvironment.getHistory({
              environmentId: props.environmentId,
              cacheKey: `${vcsHistoryRevision}:${historyQueryGeneration}`,
              input: {
                cwd: props.cwd,
                ...(resolvedSelectedRevision === null
                  ? {}
                  : { revision: resolvedSelectedRevision.revision }),
                ...(cursor === undefined ? {} : { cursor }),
                limit: HISTORY_PAGE_SIZE,
              },
            }),
          ),
    [
      cursors,
      historyQueryGeneration,
      isSelectedRevisionPending,
      props.cwd,
      props.environmentId,
      resolvedSelectedRevision,
      vcsHistoryRevision,
    ],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-history-pages:${paginationKey}`),
      ),
    [pageAtoms, paginationKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = useMemo(
    () =>
      results.flatMap((result) => {
        const value = Option.getOrNull(AsyncResult.value(result));
        return value === null ? [] : [value];
      }),
    [results],
  );
  const [retainedHistory, setRetainedHistory] = useState<{
    readonly targetKey: string;
    readonly values: ReadonlyArray<VcsGetHistoryResult>;
  } | null>(null);
  useEffect(() => {
    if (values.length > 0) setRetainedHistory({ targetKey, values });
  }, [targetKey, values]);
  const displayedValues =
    values.length > 0
      ? values
      : retainedHistory?.targetKey === targetKey
        ? retainedHistory.values
        : [];
  const failed = results.find((result) => result._tag === "Failure");
  const error = failed?._tag === "Failure" ? queryErrorMessage(failed.cause) : null;
  const recoveredSnapshot = useRef<{
    readonly targetKey: string;
    readonly generation: number;
  } | null>(null);
  useEffect(() => {
    if (recoveredSnapshot.current?.targetKey !== targetKey) recoveredSnapshot.current = null;
    if (
      recoveredSnapshot.current?.generation === historyQueryGeneration &&
      failed === undefined &&
      values.length > 0
    ) {
      recoveredSnapshot.current = null;
      return;
    }
    if (
      failed?._tag === "Failure" &&
      isHistorySnapshotExpired(failed.cause) &&
      recoveredSnapshot.current?.generation !== historyQueryGeneration
    ) {
      recoveredSnapshot.current = { targetKey, generation: historyQueryGeneration + 1 };
      setPagination({ targetKey: paginationKey, cursors: INITIAL_CURSORS });
      setHistoryQueryGeneration((generation) => generation + 1);
    }
  }, [failed, historyQueryGeneration, paginationKey, targetKey, values.length]);
  const isPending = results.some((result) => result.waiting);
  const refSelectionError = selectedRevision === undefined ? historyRefs.refPaginationError : null;
  const isInitialLoad =
    refSelectionError === null &&
    (selectedRevision === undefined || (displayedValues.length === 0 && isPending));
  const history = useMemo(() => {
    const commitsByHash = new Map<string, GitHistoryCommit>();
    for (const value of displayedValues) {
      for (const commit of value.commits) {
        if (!commitsByHash.has(commit.hash)) commitsByHash.set(commit.hash, commit);
      }
    }
    return [...commitsByHash.values()];
  }, [displayedValues]);
  const isRepo = displayedValues[0]?.isRepo ?? true;
  const lastPage = values.at(-1) ?? null;
  const nextCursor = lastPage?.nextCursor ?? null;
  const hasMoreFromServer = lastPage?.hasMore === true && nextCursor !== null;
  const historyLimitReached = cursors.length >= MAX_HISTORY_PAGES;
  const hasMore = hasMoreFromServer && !historyLimitReached;
  const isFetchingNextPage = results.at(-1)?.waiting === true && values.length > 0;
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const deferredFilter = useDeferredValue(normalizedFilter);
  const activeFilter = normalizedFilter.length === 0 ? "" : deferredFilter;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"refs" | "details" | null>(null);
  const previousMobilePane = useRef<typeof mobilePane>(null);
  const branchesButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [commitDiffRequest, setCommitDiffRequest] = useState<{
    hash: string;
    filePath?: string;
  } | null>(null);
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
  const [commitFilesCursor, setCommitFilesCursor] = useState<string | undefined>(undefined);
  const [commitFiles, setCommitFiles] = useState<ReadonlyArray<GitCommitChangedFile>>([]);
  const [commitFilesNextCursor, setCommitFilesNextCursor] = useState<string | null>(null);
  const [commitFilesHasMore, setCommitFilesHasMore] = useState(false);
  const [commitFilesCapped, setCommitFilesCapped] = useState(false);
  const [commitFilesQueryGeneration, setCommitFilesQueryGeneration] = useState(0);
  const receivedCommitFilesPages = useRef(new Set<string>());
  const commitFilesRecoveryInFlight = useRef(false);
  useEffect(() => {
    setCommitFilesCursor(undefined);
    setCommitFiles([]);
    setCommitFilesNextCursor(null);
    setCommitFilesHasMore(false);
    setCommitFilesCapped(false);
    commitFilesRecoveryInFlight.current = false;
    receivedCommitFilesPages.current.clear();
  }, [props.cwd, props.environmentId, selectedHash, vcsHistoryRevision]);
  const commitFilesQuery = useEnvironmentQuery(
    selectedHash === null
      ? null
      : vcsEnvironment.listCommitFiles({
          environmentId: props.environmentId,
          cacheKey: `${vcsHistoryRevision}:${commitFilesQueryGeneration}`,
          input: {
            cwd: props.cwd,
            hash: selectedHash,
            limit: 100,
            ...(commitFilesCursor ? { cursor: commitFilesCursor } : {}),
          },
        }),
  );
  useEffect(() => {
    const page = commitFilesQuery.data;
    if (!page || selectedHash === null) return;
    const pageKey = `${selectedHash}:${commitFilesCursor ?? "first"}:${page.nextCursor ?? "last"}`;
    if (receivedCommitFilesPages.current.has(pageKey)) return;
    receivedCommitFilesPages.current.add(pageKey);
    setCommitFiles((current) => appendCommitFilesPage(current, page.files));
    setCommitFilesHasMore(page.hasMore);
    setCommitFilesCapped(page.capped);
    setCommitFilesNextCursor(page.nextCursor);
    if (commitFilesCursor === undefined) commitFilesRecoveryInFlight.current = false;
  }, [commitFilesCursor, commitFilesQuery.data, selectedHash]);
  useEffect(() => {
    const recoveryGeneration = nextCommitFilesRecoveryGeneration({
      errorCause: commitFilesQuery.error === null ? null : commitFilesQuery.errorCause,
      generation: commitFilesQueryGeneration,
      recoveryInFlight: commitFilesRecoveryInFlight.current,
    });
    if (recoveryGeneration !== null) {
      receivedCommitFilesPages.current.clear();
      setCommitFiles([]);
      setCommitFilesCursor(undefined);
      setCommitFilesNextCursor(null);
      setCommitFilesHasMore(false);
      setCommitFilesCapped(false);
      commitFilesRecoveryInFlight.current = true;
      setCommitFilesQueryGeneration(recoveryGeneration);
    }
  }, [commitFilesQuery.error, commitFilesQuery.errorCause, commitFilesQueryGeneration]);
  const selectedCommitFiles = commitFiles;
  const loadMoreCommitFiles = () => {
    const cursor = nextCommitFilesCursor(commitFilesNextCursor);
    if (cursor) setCommitFilesCursor(cursor);
  };
  const commitDiffQuery = useEnvironmentQuery(
    commitDiffRequest === null
      ? null
      : vcsEnvironment.getCommitDiff({
          environmentId: props.environmentId,
          cacheKey: vcsHistoryRevision,
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
    toggleRefKey,
    toggleFavorite,
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
      setDefaultBranchPushConfirmation(null);
    },
    [selectHistoryRef],
  );
  const selectAllRefs = useCallback(() => {
    selectAllHistoryRefs();
    setMobilePane(null);
    setDefaultBranchPushConfirmation(null);
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
    refFilter,
    onRefFilterChange: setRefFilter,
    selectedRevision: resolvedSelectedRevision,
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
    setFilter("");
    setSelectedHash(null);
    setCommitDiffRequest(null);
    setMobilePane(null);
  }, [targetKey]);

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
    setHistoryQueryGeneration((generation) => generation + 1);
    setPagination({ targetKey: paginationKey, cursors: INITIAL_CURSORS });
    refreshRefs();
  }, [paginationKey, refreshRefs]);
  const loadNext = useCallback(() => {
    if (!hasMore || nextCursor === null) return;
    setPagination((current) => {
      const currentCursors =
        current.targetKey === paginationKey ? current.cursors : INITIAL_CURSORS;
      return currentCursors.includes(nextCursor)
        ? { targetKey: paginationKey, cursors: currentCursors }
        : { targetKey: paginationKey, cursors: [...currentCursors, nextCursor] };
    });
  }, [hasMore, nextCursor, paginationKey]);
  const retryFailedPage = useCallback(() => {
    const failedIndex = results.findIndex((result) => result._tag === "Failure");
    const failedPageAtom = failedIndex === -1 ? undefined : pageAtoms[failedIndex];
    if (failedPageAtom) appAtomRegistry.refresh(failedPageAtom);
  }, [pageAtoms, results]);

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
              onClick={() => setMobilePane((pane) => (pane === "refs" ? null : "refs"))}
              aria-controls="git-history-refs-panel"
              aria-expanded={mobilePane === "refs"}
            >
              <GitBranchIcon className="size-3.5" /> Branches
            </Button>
            <Button
              ref={detailsButtonRef}
              variant="ghost"
              size="xs"
              onClick={() => setMobilePane((pane) => (pane === "details" ? null : "details"))}
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
        />
      ) : isSelectedRevisionPending && refPaginationError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-destructive">{refPaginationError}</p>
          <Button size="sm" variant="outline" onClick={onRetryRefs}>
            Retry
          </Button>
        </div>
      ) : isInitialLoad ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          <RefreshCwIcon className="mr-2 size-3.5 animate-spin" /> Loading history…
        </div>
      ) : error && history.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
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
                setRefsPaneWidth((width) =>
                  Math.min(REFS_PANE_MAX_WIDTH, Math.max(REFS_PANE_MIN_WIDTH, width + delta)),
                )
              }
              onReset={() => setRefsPaneWidth(256)}
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
                      {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
                      selected={item.commit.hash === selectedHash}
                      onSelect={setSelectedHash}
                    />
                  )}
                  estimatedItemSize={rowHeight}
                  drawDistance={rowHeight * 8}
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
              {filteredRows.length > 0 && historyLimitReached && hasMoreFromServer ? (
                <div className="shrink-0 border-t border-border/50 px-3 py-2 text-center text-[0.6875rem] text-muted-foreground">
                  Showing the first {HISTORY_PAGE_SIZE * MAX_HISTORY_PAGES} commits. Choose a branch
                  or refine the search to keep history responsive.
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
                setDetailsPaneWidth((width) =>
                  Math.min(DETAILS_PANE_MAX_WIDTH, Math.max(DETAILS_PANE_MIN_WIDTH, width - delta)),
                )
              }
              onReset={() => setDetailsPaneWidth(384)}
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
              filesError={commitFilesQuery.error !== null}
              filesLoading={commitFilesQuery.isPending}
              onLoadMoreFiles={loadMoreCommitFiles}
              onRetryFiles={() => void commitFilesQuery.refresh()}
              isPending={commitDetailsQuery.isPending}
              hasError={commitDetailsQuery.error !== null}
              hasSelection={selectedHash !== null}
              onRetry={commitDetailsQuery.refresh}
              onShowDiff={(hash, filePath) =>
                setCommitDiffRequest(filePath ? { hash, filePath } : { hash })
              }
            />
          ) : null}
        </div>
      )}
      {!isWideLayout && mobilePane === "refs" ? (
        <Sheet open={mobilePane === "refs"} onOpenChange={(open) => !open && setMobilePane(null)}>
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
        <Sheet
          open={mobilePane === "details"}
          onOpenChange={(open) => !open && setMobilePane(null)}
        >
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
              filesError={commitFilesQuery.error !== null}
              filesLoading={commitFilesQuery.isPending}
              onLoadMoreFiles={loadMoreCommitFiles}
              onRetryFiles={() => void commitFilesQuery.refresh()}
              isPending={commitDetailsQuery.isPending}
              hasError={commitDetailsQuery.error !== null}
              hasSelection={selectedHash !== null}
              onRetry={commitDetailsQuery.refresh}
              onShowDiff={(hash, filePath) =>
                setCommitDiffRequest(filePath ? { hash, filePath } : { hash })
              }
            />
          </SheetPopup>
        </Sheet>
      ) : null}
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
    </section>
  );
}
