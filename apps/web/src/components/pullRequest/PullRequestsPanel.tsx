import type {
  EnvironmentId,
  IssueLink,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListEntry,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  EyeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  LayersIcon,
  LoaderIcon,
  PenLineIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import type { DraftId } from "~/composerDraftStore";

import { ListGhost } from "../sourceControl/ListGhosts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import {
  filterPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  type EnvironmentPullRequestEntry,
} from "./pullRequestList.logic";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { PullRequestFiltersMenu, type PullRequestFilterOption } from "./PullRequestListFilters";
import { PullRequestRow } from "./PullRequestRow";

const STATE_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: GitPullRequestIcon },
  { value: "closed", label: "Closed", Icon: GitPullRequestClosedIcon },
  { value: "merged", label: "Merged", Icon: GitMergeIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

const INVOLVEMENT_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "reviewing", label: "Reviewing", Icon: EyeIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 30;
const MAX_LIMIT = 500;

export interface PullRequestPanelSelection {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}

interface PullRequestsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly selected: PullRequestPanelSelection | null;
  readonly onSelect: (selection: PullRequestPanelSelection | null) => void;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId;
  readonly onOpenLinkedIssue?: (link: IssueLink) => void;
  readonly onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: PullRequestState;
    isDraft: boolean;
  }) => void;
}

interface PanelPage {
  readonly key: string;
  readonly size: number;
  readonly cursors: PullRequestListCursors | null;
}

export function PullRequestsPanel(props: PullRequestsPanelProps) {
  return <ProjectPullRequests key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function ProjectPullRequests(props: PullRequestsPanelProps) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  }>({ state: "open", involvement: "all", extra: {} });
  const [page, setPage] = useState<PanelPage>({ key: "", size: PAGE_SIZE, cursors: null });
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="relative h-full min-h-0">
      {props.selected ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center border-b border-border/50 px-1.5 py-1">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 text-muted-foreground"
              onClick={() => props.onSelect(null)}
            >
              <ArrowLeftIcon className="size-3.5" />
              All pull requests
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <PullRequestDetailPanel
              key={`${props.selected.repository}#${props.selected.number}`}
              environmentId={props.environmentId}
              reference={props.selected}
              context="page"
              chromeVariant="collapse"
              onActed={() => setRefreshToken((token) => token + 1)}
              {...(props.onStateChange ? { onStateChange: props.onStateChange } : {})}
              {...(props.onOpenLinkedIssue ? { onOpenLinkedIssue: props.onOpenLinkedIssue } : {})}
              {...(props.composerDraftTarget
                ? { composerDraftTarget: props.composerDraftTarget }
                : {})}
            />
          </div>
        </div>
      ) : null}
      <div
        hidden={props.selected !== null}
        aria-hidden={props.selected !== null}
        inert={props.selected !== null ? true : undefined}
        className="h-full min-h-0"
      >
        <PullRequestBrowserList
          environmentId={props.environmentId}
          projectId={props.projectId}
          onSelect={props.onSelect}
          query={query}
          onQuery={setQuery}
          filters={filters}
          onFilters={setFilters}
          page={page}
          onPage={setPage}
          refreshToken={refreshToken}
        />
      </div>
    </div>
  );
}

function PullRequestBrowserList({
  environmentId,
  projectId,
  onSelect,
  query,
  onQuery,
  filters,
  onFilters,
  page,
  onPage,
  refreshToken,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onSelect: (selection: PullRequestPanelSelection) => void;
  query: string;
  onQuery: (query: string) => void;
  filters: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  };
  onFilters: (filters: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  }) => void;
  page: PanelPage;
  onPage: (page: PanelPage) => void;
  refreshToken: number;
}) {
  const typed = query.trim().slice(0, 200);
  const sent = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);
  const filterKey = `${filters.state}:${filters.involvement}:${JSON.stringify(filters.extra)}:${sent}`;
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;

  useEffect(() => {
    onPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
  }, [filterKey, onPage]);

  const listQuery = useEnvironmentQuery(
    pullRequestEnvironment.list({
      environmentId,
      input: {
        state: filters.state,
        involvement: filters.involvement,
        projectId,
        limit: pageSize,
        ...(Object.keys(filters.extra).length > 0 ? { filters: filters.extra } : {}),
        ...(sent ? { query: sent } : {}),
        ...(sentCursors === null ? {} : { cursors: sentCursors }),
      },
    }),
  );
  useEffect(() => {
    if (refreshToken > 0) listQuery.refresh();
  }, [listQuery.refresh, refreshToken]);
  const answered = listQuery.data;
  const [ordered, setOrdered] = useState<{
    readonly key: string;
    readonly entries: ReadonlyArray<PullRequestListEntry>;
    readonly truncated: boolean;
  } | null>(null);

  useEffect(() => {
    if (answered === null) return;
    setOrdered((previous) => {
      if (previous === null || previous.key !== filterKey || sentCursors === null) {
        return { key: filterKey, entries: answered.entries, truncated: answered.truncated };
      }
      const held = new Set(previous.entries.map(pullRequestEntryKey));
      return {
        key: filterKey,
        entries: [
          ...previous.entries,
          ...answered.entries.filter((entry) => !held.has(pullRequestEntryKey(entry))),
        ],
        truncated: answered.truncated,
      };
    });
  }, [answered, filterKey, sentCursors]);

  const entries = useMemo(() => {
    const held = ordered?.key === filterKey ? ordered.entries : (answered?.entries ?? []);
    const narrowed = filterPullRequestsByInvolvement(
      held,
      answered?.viewers ?? {},
      filters.involvement,
    ).filter(
      (entry) =>
        (typed.length === 0 ||
          answered?.providers.some((provider) => provider.searchesOnHost) === true ||
          matchesPullRequestQuery(entry, typed)) &&
        matchesPullRequestFilters(
          entry,
          filters.extra,
          pullRequestEntryViewer(entry, answered?.viewers ?? {}),
        ),
    );
    return narrowed.map((entry): EnvironmentPullRequestEntry => ({ ...entry, environmentId }));
  }, [answered, environmentId, filterKey, filters.extra, filters.involvement, ordered, typed]);

  const truncated = ordered?.key === filterKey ? ordered.truncated : (answered?.truncated ?? false);
  const nextCursors = answered?.nextCursors ?? {};
  const canContinue = Object.keys(nextCursors).length > 0;
  const loadingMore = listQuery.isPending && entries.length > 0;
  const loadMore = useCallback(() => {
    onPage(
      canContinue
        ? { key: filterKey, size: pageSize, cursors: nextCursors }
        : { key: filterKey, size: Math.min(pageSize + PAGE_SIZE, MAX_LIMIT), cursors: null },
    );
  }, [canContinue, filterKey, nextCursors, onPage, pageSize]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      entries.length === 0 ||
      !truncated ||
      listQuery.isPending ||
      listQuery.error !== null ||
      (!canContinue && pageSize >= MAX_LIMIT)
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    canContinue,
    entries.length,
    listQuery.error,
    listQuery.isPending,
    loadMore,
    pageSize,
    truncated,
  ]);

  const select = useCallback(
    (entry: EnvironmentPullRequestEntry) =>
      onSelect({ projectId, repository: entry.repository, number: entry.number }),
    [onSelect, projectId],
  );
  const narrowed =
    filters.state !== "open" ||
    filters.involvement !== "all" ||
    Object.keys(filters.extra).length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Input
          value={query}
          aria-label="Search pull requests"
          placeholder="Search pull requests"
          onChange={(event) => onQuery(event.target.value)}
        />
        <PullRequestFiltersMenu
          state={filters.state}
          stateOptions={STATE_OPTIONS}
          onState={(state) => onFilters({ ...filters, state })}
          involvement={filters.involvement}
          involvementOptions={INVOLVEMENT_OPTIONS}
          onInvolvement={(involvement) => onFilters({ ...filters, involvement })}
          filters={filters.extra}
          onFilters={(extra) => onFilters({ ...filters, extra })}
          host={undefined}
          hostOptions={[]}
          onHost={() => undefined}
          server={undefined}
          serverOptions={[]}
          onServer={() => undefined}
          projects={[]}
          projectId={undefined}
          projectEnvironmentId={undefined}
          unavailable={new Map()}
          onProject={() => undefined}
          showProjectScope={false}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-1 pb-2">
          {entries.length === 0 && listQuery.isPending ? (
            <ListGhost rows={7} label="Loading pull requests" />
          ) : listQuery.error !== null && listQuery.data === null ? (
            <p className="px-2 text-sm text-muted-foreground">{listQuery.error}</p>
          ) : entries.length === 0 ? (
            <div className="space-y-2 px-2">
              <p className="text-sm text-muted-foreground">
                {typed.length > 0
                  ? "No pull request here matches that."
                  : narrowed
                    ? "No pull request here matches these filters."
                    : "This repository has no pull requests to open."}
              </p>
              {truncated && (canContinue || pageSize < MAX_LIMIT) ? (
                <Button variant="outline" size="xs" onClick={loadMore}>
                  Load more
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              {entries.map((entry) => (
                <PullRequestRow
                  key={pullRequestEntryKey(entry)}
                  entry={entry}
                  selected={false}
                  showProjectTitle={false}
                  showProvider={false}
                  onSelect={select}
                />
              ))}
              {truncated ? (
                <div
                  ref={sentinelRef}
                  className="flex justify-center py-2 text-xs text-muted-foreground"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-2">
                      <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
                      Loading more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
