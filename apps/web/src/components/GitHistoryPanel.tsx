import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitHistoryCommit } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
} from "lucide-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { layoutGitHistoryGraph, type GitHistoryGraphRow } from "../lib/gitHistoryGraph";
import { cn } from "../lib/utils";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "./ui/button";

const HISTORY_PAGE_SIZE = 100;
const ROW_HEIGHT = 54;
const LANE_WIDTH = 14;
const GRAPH_COLORS = ["#4f9cff", "#b26cff", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6"] as const;
const INITIAL_CURSORS = [undefined] as const;

interface GitHistoryPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
}

interface GitHistoryRow {
  commit: GitHistoryCommit;
  graph: GitHistoryGraphRow;
}

function queryErrorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not load Git history.";
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

function GraphCell(props: { graph: GitHistoryGraphRow; laneCount: number }) {
  const width = Math.max(LANE_WIDTH * props.laneCount, LANE_WIDTH * 2);
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

  return (
    <svg
      aria-hidden="true"
      className="h-full shrink-0 overflow-visible"
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      width={width}
      height={ROW_HEIGHT}
    >
      {props.graph.edges.map((edge, index) => (
        <line
          key={`${edge.kind}:${edge.fromLane}:${edge.toLane}:${edge.parentHash ?? index}`}
          x1={x(edge.fromLane)}
          y1="0"
          x2={x(edge.toLane)}
          y2={ROW_HEIGHT}
          stroke={GRAPH_COLORS[edge.colorIndex % GRAPH_COLORS.length]}
          strokeWidth="1.75"
          strokeDasharray={edge.isMissingParent ? "3 2" : undefined}
        />
      ))}
      <circle
        cx={x(props.graph.lane)}
        cy="8"
        r="4"
        fill="var(--background)"
        stroke={GRAPH_COLORS[props.graph.colorIndex % GRAPH_COLORS.length]}
        strokeWidth="2"
      />
    </svg>
  );
}

function CommitRow(props: {
  row: GitHistoryRow;
  laneCount: number;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  const { commit } = props.row;
  const shortHash = commit.hash.slice(0, 8);

  return (
    <button
      type="button"
      className={cn(
        "group flex h-[54px] w-full min-w-0 items-stretch border-b border-border/45 text-left outline-none transition-colors hover:bg-accent/45 focus-visible:bg-accent/60",
        props.selected && "bg-accent/70",
      )}
      onClick={() => props.onSelect(commit.hash)}
      aria-pressed={props.selected}
    >
      <GraphCell graph={props.row.graph} laneCount={props.laneCount} />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_7.5rem] gap-x-3 py-1.5 pr-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium leading-5 text-foreground">
            {commit.subject || "(no subject)"}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className="shrink-0 font-mono text-[10px] text-primary/85">{shortHash}</span>
            <span className="truncate">{commit.authorName}</span>
          </div>
        </div>
        <div className="min-w-0 text-right text-[10px] leading-4 text-muted-foreground">
          <div className="truncate">{formatCommitDate(commit.authoredAt)}</div>
          {commit.refs.length > 0 ? (
            <div className="mt-0.5 flex justify-end gap-1 overflow-hidden">
              {commit.refs.slice(0, 2).map((ref) => (
                <span
                  key={ref}
                  className="truncate rounded-sm border border-primary/20 bg-primary/8 px-1 font-mono text-[9px] text-primary/90"
                >
                  {ref}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export default function GitHistoryPanel(props: GitHistoryPanelProps) {
  const targetKey = `${props.environmentId}:${props.cwd}`;
  const refsQuery = useEnvironmentQuery(
    vcsEnvironment.listRefs({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, limit: 200, includeMatchingRemoteRefs: true },
    }),
  );
  const [pagination, setPagination] = useState<{
    targetKey: string;
    cursors: ReadonlyArray<number | undefined>;
  }>({ targetKey, cursors: INITIAL_CURSORS });
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_CURSORS;
  const pageAtoms = useMemo(
    () =>
      cursors.map((cursor) =>
        vcsEnvironment.getHistory({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            ...(cursor === undefined ? {} : { cursor }),
            limit: HISTORY_PAGE_SIZE,
          },
        }),
      ),
    [cursors, props.cwd, props.environmentId],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-history-pages:${targetKey}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const failed = results.find((result) => result._tag === "Failure");
  const error = failed?._tag === "Failure" ? queryErrorMessage(failed.cause) : null;
  const isPending = results.some((result) => result.waiting);
  const isInitialLoad = values.length === 0 && isPending;
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
  const hasMore = lastPage?.hasMore === true && nextCursor !== null;
  const isFetchingNextPage = results.at(-1)?.waiting === true && values.length > 0;
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter.trim().toLocaleLowerCase());
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const localRefs = refsQuery.data?.refs.filter((ref) => !ref.isRemote) ?? [];
  const remoteRefs = refsQuery.data?.refs.filter((ref) => ref.isRemote) ?? [];
  const tags = useMemo(
    () =>
      [...new Set(history.flatMap((commit) => commit.refs))]
        .filter((ref) => ref.startsWith("tag: "))
        .map((ref) => ref.slice(5)),
    [history],
  );

  useEffect(() => {
    setPagination({ targetKey, cursors: INITIAL_CURSORS });
    setFilter("");
    setSelectedHash(null);
  }, [targetKey]);

  const { laneCount, rows: graphRows } = useMemo(() => layoutGitHistoryGraph(history), [history]);
  const graphByHash = useMemo(() => new Map(graphRows.map((row) => [row.hash, row])), [graphRows]);
  const filteredRows = useMemo(() => {
    const query = deferredFilter;
    return history.flatMap((commit) => {
      if (
        query.length > 0 &&
        !`${commit.hash} ${commit.subject} ${commit.authorName} ${commit.refs.join(" ")}`
          .toLocaleLowerCase()
          .includes(query)
      ) {
        return [];
      }
      const graph = graphByHash.get(commit.hash);
      return graph ? [{ commit, graph }] : [];
    });
  }, [deferredFilter, graphByHash, history]);

  useEffect(() => {
    if (selectedHash !== null && !history.some((commit) => commit.hash === selectedHash)) {
      setSelectedHash(null);
    }
  }, [history, selectedHash]);

  const refresh = useCallback(() => {
    setPagination({ targetKey, cursors: INITIAL_CURSORS });
    const firstPage = pageAtoms[0];
    if (firstPage) appAtomRegistry.refresh(firstPage);
  }, [pageAtoms, targetKey]);
  const loadNext = useCallback(() => {
    if (!hasMore || nextCursor === null) return;
    setPagination((current) => {
      const currentCursors = current.targetKey === targetKey ? current.cursors : INITIAL_CURSORS;
      return currentCursors.includes(nextCursor)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, nextCursor] };
    });
  }, [hasMore, nextCursor, targetKey]);

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Git history"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitCommitHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">Git History</span>
          {history.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">{history.length} commits</span>
          ) : null}
        </div>
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
      <div className="relative shrink-0 border-b border-border/60 px-3 py-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          className="h-7 w-full rounded-md border border-input bg-transparent pr-2 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter commits by message, hash, author, or ref"
          aria-label="Filter Git history"
        />
      </div>
      {isInitialLoad ? (
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
      ) : filteredRows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          No commits match this filter.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-48 shrink-0 overflow-y-auto border-r border-border/60 bg-muted/15 px-2 py-2 lg:block">
            <div className="mb-1 px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Local
            </div>
            {localRefs.map((ref) => (
              <div
                key={`local:${ref.name}`}
                className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] text-foreground/85"
                title={ref.name}
              >
                <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{ref.name}</span>
                {ref.current ? <span className="ml-auto text-primary">●</span> : null}
              </div>
            ))}
            {remoteRefs.length > 0 ? (
              <>
                <div className="mt-3 mb-1 px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  Remote
                </div>
                {remoteRefs.map((ref) => (
                  <div
                    key={`remote:${ref.name}`}
                    className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] text-foreground/75"
                    title={ref.name}
                  >
                    <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{ref.name}</span>
                  </div>
                ))}
              </>
            ) : null}
            {tags.length > 0 ? (
              <>
                <div className="mt-3 mb-1 px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  Tags
                </div>
                {tags.map((tag) => (
                  <div
                    key={`tag:${tag}`}
                    className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] text-foreground/75"
                    title={tag}
                  >
                    <TagIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{tag}</span>
                  </div>
                ))}
              </>
            ) : null}
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error ? (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive">
                <span className="truncate">{error}</span>
                <Button size="xs" variant="ghost" className="shrink-0" onClick={refresh}>
                  Retry
                </Button>
              </div>
            ) : null}
            <LegendList<GitHistoryRow>
              data={filteredRows}
              keyExtractor={(row) => row.commit.hash}
              renderItem={({ item }) => (
                <CommitRow
                  row={item}
                  laneCount={laneCount}
                  selected={item.commit.hash === selectedHash}
                  onSelect={setSelectedHash}
                />
              )}
              estimatedItemSize={ROW_HEIGHT}
              drawDistance={ROW_HEIGHT * 8}
              className="min-h-0 flex-1 overflow-x-auto overscroll-y-contain"
            />
            {hasMore || isFetchingNextPage ? (
              <div className="flex shrink-0 justify-center border-t border-border/50 p-2">
                <Button size="xs" variant="ghost" onClick={loadNext} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? "Loading more…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
