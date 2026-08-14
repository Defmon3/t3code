import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GitHubIssueListInput,
  GitHubIssueListResult,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { githubIssuesEnvironment } from "../../state/githubIssues";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GitHubIssueFilters, type GitHubIssueFiltersValue } from "./GitHubIssueFilters";
import { GitHubIssueRow } from "./GitHubIssueRow";

const PAGE_SIZE = 50;
const FILTER_DEBOUNCE_MS = 250;
const INITIAL_CURSORS = [undefined] as const;
type GitHubIssue = GitHubIssueListResult["items"][number];

interface GitHubIssuesPaneProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly wide: boolean;
}

function issueInput(
  cwd: string,
  state: GitHubIssueListInput["state"],
  query: string,
  filters: GitHubIssueFiltersValue,
  sort: GitHubIssueListInput["sort"],
  cursor: string | undefined,
): GitHubIssueListInput {
  const normalizedQuery = query.trim();
  const normalizedFilters = Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0),
    ),
  ) as GitHubIssueFiltersValue;
  return {
    cwd,
    state,
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(Object.keys(normalizedFilters).length ? { filters: normalizedFilters } : {}),
    sort,
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  };
}

export function GitHubIssuesPane({ environmentId, cwd, wide }: GitHubIssuesPaneProps) {
  const [state, setState] = useState<GitHubIssueListInput["state"]>("open");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<GitHubIssueFiltersValue>({});
  const [filterDraft, setFilterDraft] = useState<GitHubIssueFiltersValue>({});
  const [sort, setSort] = useState<GitHubIssueListInput["sort"]>("newest");
  const filterKey = JSON.stringify({ environmentId, state, query, filters, sort, cwd });
  const [pagination, setPagination] = useState<{
    readonly key: string;
    readonly cursors: ReadonlyArray<string | undefined>;
  }>({
    key: filterKey,
    cursors: INITIAL_CURSORS,
  });
  const cursors = pagination.key === filterKey ? pagination.cursors : INITIAL_CURSORS;
  const pageAtoms = useMemo(
    () =>
      cursors.map((cursor) =>
        githubIssuesEnvironment.list({
          environmentId,
          input: issueInput(cwd, state, query, filters, sort, cursor),
        }),
      ),
    [cursors, cwd, environmentId, filters, query, sort, state],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:github-issues-pages:${filterKey}`),
      ),
    [filterKey, pageAtoms],
  );
  const results = useAtomValue(pagesAtom);
  const values: GitHubIssueListResult[] = [];
  for (const result of results) {
    if (result._tag === "Failure") break;
    const value = Option.getOrNull(AsyncResult.value(result));
    if (value !== null) values.push(value);
  }
  const firstPage = values[0] ?? null;
  const lastPage = values.at(-1) ?? null;
  const failureIndex = results.findIndex((result) => result._tag === "Failure");
  const failure = failureIndex === -1 ? null : results[failureIndex]!;
  const error =
    failure?._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(failure.cause);
          return cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Could not load GitHub issues. Try again.";
        })()
      : null;
  const isPending = results.some((result) => result.waiting);
  const isInitialLoad = values.length === 0 && isPending;
  const isRefreshing = values.length > 0 && isPending && cursors.length === 1;
  const issues = useMemo(() => {
    const byNumber = new Map<number, GitHubIssue>();
    for (const page of values)
      for (const item of page.items)
        if (!byNumber.has(item.number)) byNumber.set(item.number, item);
    return [...byNumber.values()];
  }, [values]);
  const invalidate = useAtomCommand(githubIssuesEnvironment.invalidate, { reportFailure: false });
  const [isInvalidating, setIsInvalidating] = useState(false);
  const invalidatingRef = useRef(false);
  const refreshTarget = { environmentId, cwd, state, query, filters, sort, filterKey };
  const latestRefreshTargetRef = useRef(refreshTarget);
  latestRefreshTargetRef.current = refreshTarget;
  const [openError, setOpenError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(queryInput), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [queryInput]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setFilters(filterDraft), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [filterDraft]);
  useEffect(() => {
    setPagination({ key: filterKey, cursors: INITIAL_CURSORS });
  }, [filterKey]);

  const refresh = useCallback(async () => {
    if (invalidatingRef.current) return;
    invalidatingRef.current = true;
    setIsInvalidating(true);
    setRefreshError(null);
    try {
      const result = await invalidate({ environmentId, input: { cwd } });
      const latest = latestRefreshTargetRef.current;
      if (latest.environmentId !== environmentId || latest.cwd !== cwd) return;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          setRefreshError("Refresh was interrupted. Try again.");
        } else {
          setRefreshError("Could not refresh GitHub issues. Try again.");
        }
        return;
      }
      setPagination({ key: latest.filterKey, cursors: INITIAL_CURSORS });
      appAtomRegistry.refresh(
        githubIssuesEnvironment.list({
          environmentId: latest.environmentId,
          input: issueInput(
            latest.cwd,
            latest.state,
            latest.query,
            latest.filters,
            latest.sort,
            undefined,
          ),
        }),
      );
    } finally {
      invalidatingRef.current = false;
      setIsInvalidating(false);
    }
  }, [cwd, environmentId, invalidate]);
  const loadMore = () => {
    const cursor = lastPage?.nextCursor;
    if (!lastPage?.hasMore || !cursor) return;
    setPagination((current) => {
      const currentCursors = current.key === filterKey ? current.cursors : INITIAL_CURSORS;
      return currentCursors.includes(cursor)
        ? current
        : { key: filterKey, cursors: [...currentCursors, cursor] };
    });
  };
  const retry = () => {
    const atom = failureIndex === -1 ? undefined : pageAtoms[failureIndex];
    if (atom) appAtomRegistry.refresh(atom);
  };
  const openExternal = async (url: string) => {
    setOpenError(null);
    try {
      const api = readLocalApi();
      if (!api) throw new Error("External links are unavailable in this client.");
      await api.shell.openExternal(url);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : "Could not open GitHub.");
    }
  };
  const count = state === "open" ? firstPage?.openCount : firstPage?.closedCount;
  const newIssueUrl = firstPage?.repository.canCreateIssue
    ? firstPage.repository.newIssueUrl
    : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="GitHub issues">
      <header className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        <div className="mr-auto min-w-0">
          <div className="text-sm font-medium">All issues</div>
          <div className="truncate text-xs text-muted-foreground">
            {firstPage?.repository.nameWithOwner ?? "GitHub repository"}
          </div>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void refresh()}
          disabled={isInvalidating || isPending}
          aria-label="Refresh GitHub issues"
        >
          <RefreshCwIcon className="size-3.5" /> Refresh
        </Button>
        {newIssueUrl ? (
          <Button
            size="xs"
            className="border-[#1f883d] bg-[#1f883d] text-white shadow-none hover:border-[#1a7f37] hover:bg-[#1a7f37] active:border-[#176f2c] active:bg-[#176f2c] focus-visible:ring-[#1f883d]/45 dark:border-[#238636] dark:bg-[#238636] dark:hover:border-[#2ea043] dark:hover:bg-[#2ea043] dark:active:border-[#1f883d] dark:active:bg-[#1f883d]"
            onClick={() => void openExternal(newIssueUrl)}
          >
            New issue
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
        <label className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
          <Input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            className="pl-8"
            maxLength={256}
            placeholder="Search GitHub issues"
            aria-label="Search GitHub issues"
          />
        </label>
        <div className="flex gap-1 border-b border-border">
          {(["open", "closed"] as const).map((next) => (
            <Button
              key={next}
              size="xs"
              variant={state === next ? "secondary" : "ghost"}
              onClick={() => setState(next)}
            >
              {next === "open" ? "Open" : "Closed"}
              {state === next && count !== undefined ? ` ${count}` : ""}
            </Button>
          ))}
        </div>
        <GitHubIssueFilters
          value={filterDraft}
          sort={sort}
          wide={wide}
          onChange={setFilterDraft}
          onSortChange={setSort}
        />
        {openError ? (
          <div className="rounded border border-destructive/30 bg-destructive/8 px-2 py-1 text-xs text-destructive-foreground">
            {openError}
          </div>
        ) : null}
        {refreshError ? (
          <div className="rounded border border-destructive/30 bg-destructive/8 px-2 py-1 text-xs text-destructive-foreground">
            {refreshError}
          </div>
        ) : null}
        {firstPage?.searchCapReached ? (
          <div className="rounded border border-warning/30 bg-warning/8 px-2 py-1 text-xs text-warning-foreground">
            GitHub search shows only the {sort} 1,000 matching issues.
          </div>
        ) : null}
        {isInitialLoad ? (
          <div className="p-4 text-sm text-muted-foreground">Loading GitHub issues…</div>
        ) : null}
        {!isInitialLoad && error && values.length === 0 ? (
          <div className="p-4 text-sm text-destructive-foreground">
            {error}{" "}
            <Button size="xs" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {!isInitialLoad && !error && issues.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No {state} issues match these filters.
          </div>
        ) : null}
        {issues.length > 0 ? (
          <div className="min-h-0 flex-1">
            <LegendList<GitHubIssue>
              className="h-full"
              data={issues}
              keyExtractor={(issue) => String(issue.number)}
              recycleItems
              estimatedItemSize={56}
              renderItem={({ item }) => (
                <GitHubIssueRow issue={item} wide={wide} onOpen={(url) => void openExternal(url)} />
              )}
            />
          </div>
        ) : null}
        {isRefreshing ? (
          <div className="text-xs text-muted-foreground">Refreshing issues…</div>
        ) : null}
        {error && values.length > 0 ? (
          <div className="text-xs text-destructive-foreground">
            {error}{" "}
            <Button size="xs" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {lastPage?.hasMore && error === null ? (
          <Button size="sm" variant="outline" onClick={loadMore} disabled={isPending}>
            Load more
          </Button>
        ) : null}
      </div>
    </section>
  );
}
