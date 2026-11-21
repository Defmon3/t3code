import {
  continueIssuePage,
  holdIssuePages,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type IssueListInput,
  IssueTrackerKind,
  ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Activity, lazy, Suspense, useRef, useState, type KeyboardEvent } from "react";

import type { IssueSelection, RepositoryView } from "~/rightPanelStore";
import type { GitHistoryPanelStore } from "./git-history/GitHistoryPanelState";

import { T, useGT } from "gt-react";
import { useDebouncedValue } from "~/state/queries";
import { issueEnvironment, useIssueList } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { REPOSITORY_VIEWS as views, useRightPanelStore } from "~/rightPanelStore";
import { IssueDetailPanel } from "./issue/IssueDetailPanel";
import { IssueRow } from "./issue/IssueRow";
import { Input } from "./ui/input";
import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import { Button } from "./ui/button";

const GitHistoryPanel = lazy(() => import("./GitHistoryPanel"));

export function repositoryViewFromKey(view: RepositoryView, key: string): RepositoryView | null {
  const index = views.indexOf(view);
  if (key === "ArrowRight") return views[(index + 1) % views.length] ?? null;
  if (key === "ArrowLeft") return views[(index + views.length - 1) % views.length] ?? null;
  if (key === "Home") return views[0] ?? null;
  if (key === "End") return views.at(-1) ?? null;
  return null;
}

interface RepositoryPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly selectedIssue: IssueSelection | null;
  readonly view: RepositoryView;
  readonly active: boolean;
  readonly repositoryIdentity?: import("@t3tools/contracts").RepositoryIdentity | null | undefined;
  readonly onSolveGitSync?: ((prompt: string) => void) | undefined;
  readonly gitHistoryAvailable: boolean;
  readonly gitHistoryPanelStore: GitHistoryPanelStore;
  readonly issuesAvailable: boolean;
  readonly onViewChange: (view: RepositoryView) => void;
}

export default function RepositoryPanel(props: RepositoryPanelProps) {
  const gt = useGT();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const [historyActivated, setHistoryActivated] = useState(props.view === "history");
  const [issuesActivated, setIssuesActivated] = useState(props.view === "issues");
  if (props.view === "history" && !historyActivated) setHistoryActivated(true);
  if (props.view === "issues" && !issuesActivated) setIssuesActivated(true);

  const move = (event: KeyboardEvent<HTMLButtonElement>, view: RepositoryView) => {
    const next = repositoryViewFromKey(view, event.key);
    if (!next) return;
    event.preventDefault();
    props.onViewChange(next);
    tabs.current[views.indexOf(next)]?.focus();
  };

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={gt("Git History")}
    >
      <div
        className="flex shrink-0 gap-1 border-b border-border/70 px-3 py-1.5"
        role="tablist"
        aria-label={gt("Git History views")}
      >
        {views.map((view, index) => (
          <Button
            key={view}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            size="xs"
            variant={props.view === view ? "secondary" : "ghost"}
            role="tab"
            id={`repository-tab-${view}`}
            aria-selected={props.view === view}
            aria-controls={`repository-panel-${view}`}
            tabIndex={props.view === view ? 0 : -1}
            onClick={() => props.onViewChange(view)}
            onKeyDown={(event) => move(event, view)}
          >
            {view === "history"
              ? gt("History")
              : view === "issues"
                ? gt("Issues")
                : gt("Pull requests")}
          </Button>
        ))}
      </div>
      {historyActivated ? (
        <Activity mode={props.view === "history" ? "visible" : "hidden"}>
          <div
            id="repository-panel-history"
            role="tabpanel"
            aria-labelledby="repository-tab-history"
            className="min-h-0 flex-1"
          >
            {props.gitHistoryAvailable && props.cwd ? (
              <Suspense fallback={null}>
                <GitHistoryPanel
                  environmentId={props.environmentId}
                  cwd={props.cwd}
                  repositoryIdentity={props.repositoryIdentity}
                  onSolveGitSync={props.onSolveGitSync}
                  active={props.active && props.view === "history"}
                  stateStore={props.gitHistoryPanelStore}
                  stateScopeKey={`${props.threadRef.environmentId}:${props.threadRef.threadId}`}
                />
              </Suspense>
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                <T>Update the environment server to browse Git History.</T>
              </div>
            )}
          </div>
        </Activity>
      ) : null}
      {issuesActivated ? (
        <Activity mode={props.view === "issues" ? "visible" : "hidden"}>
          <div
            id="repository-panel-issues"
            role="tabpanel"
            aria-labelledby="repository-tab-issues"
            className="min-h-0 flex-1"
          >
            {props.issuesAvailable && props.projectId ? (
              <RepositoryIssues
                environmentId={props.environmentId}
                projectId={props.projectId}
                threadRef={props.threadRef}
                selected={props.selectedIssue}
              />
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {props.issuesAvailable
                  ? gt("Open a project thread to browse issues.")
                  : gt("Update the environment server to browse issues.")}
              </div>
            )}
          </div>
        </Activity>
      ) : null}
      <Activity mode={props.view === "pull-requests" ? "visible" : "hidden"}>
        <div
          id="repository-panel-pull-requests"
          role="tabpanel"
          aria-labelledby="repository-tab-pull-requests"
          className="min-h-0 flex-1"
        >
          <ThreadPullRequestsPanel threadRef={props.threadRef} />
        </div>
      </Activity>
    </section>
  );
}

function RepositoryIssues({
  environmentId,
  projectId,
  threadRef,
  selected,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
  selected: IssueSelection | null;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 300);
  const select = (issue: IssueSelection | null) =>
    useRightPanelStore.getState().selectRepositoryIssue(threadRef, issue);

  return (
    <>
      <Activity mode={selected === null ? "visible" : "hidden"}>
        <div className="flex h-full min-h-0 flex-col gap-2 p-2">
          <Input
            aria-label={gt("Search issues")}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
          <RepositoryIssueList
            key={`${environmentId}:${projectId}:${search}`}
            environmentId={environmentId}
            input={{
              projectId,
              state: search ? "all" : "open",
              ...(search ? { query: search } : {}),
            }}
            onSelect={select}
          />
        </div>
      </Activity>
      {selected !== null ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="p-2">
            <Button size="xs" variant="ghost" onClick={() => select(null)}>
              {gt("Back to issues")}
            </Button>
          </div>
          <IssueDetailPanel
            key={`${selected.tracker}:${selected.host}:${selected.scope}:${selected.key}`}
            environmentId={environmentId}
            reference={{
              projectId: ProjectId.make(selected.projectId),
              tracker: IssueTrackerKind.make(selected.tracker),
              ...(selected.host ? { host: selected.host } : {}),
              scope: selected.scope,
              key: selected.key,
            }}
            threadRef={threadRef}
            onSelectPullRequest={({ host, projectId, repository, number }) =>
              useRightPanelStore.getState().openPullRequest(threadRef, {
                projectId,
                repository,
                number,
                ...(host === undefined ? {} : { host }),
              })
            }
          />
        </div>
      ) : null}
    </>
  );
}

function RepositoryIssueList({
  environmentId,
  input,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
  readonly onSelect: (issue: IssueSelection) => void;
}) {
  const gt = useGT();
  const list = useIssueList([{ environmentId, input }]);
  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const page = holdIssuePages(list.answers, pages).get(environmentId);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const canLoadMore = page !== undefined && Object.keys(page.nextCursors).length > 0;
  const loadMore = async () => {
    if (!page || !canLoadMore || loadingMore) return;
    setLoadingMore(true);
    const cursors = page.nextCursors;
    const result = await loadPage({ environmentId, input: { ...input, cursors } });
    setLoadingMore(false);
    const next =
      result._tag === "Success"
        ? result.value
        : { failure: String(squashAtomCommandFailure(result)) };
    setPages(new Map([[environmentId, continueIssuePage(page, next, cursors)]]));
  };
  const errors = [
    ...(page?.errors.map((error) => error.message) ?? []),
    ...(list.error ? [list.error] : []),
    ...(page?.moreFailure ? [page.moreFailure] : []),
  ];
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {errors.length > 0 ? (
        <div role="alert" className="space-y-1 text-sm">
          {[...new Set(errors)].map((error) => (
            <p key={error}>{error}</p>
          ))}
          <Button size="xs" variant="ghost" onClick={list.retry}>
            {gt("Retry")}
          </Button>
        </div>
      ) : null}
      {list.isPending && !page?.entries.length ? <p role="status">{gt("Loading issues")}</p> : null}
      {!list.isPending && errors.length === 0 && !page?.entries.length ? (
        <p>{gt("No issues found")}</p>
      ) : null}
      {page?.entries.map((entry) => (
        <IssueRow
          key={issueEntryKey(entry)}
          entry={{ ...entry, environmentId }}
          selected={false}
          showScope
          showTracker
          onSelect={onSelect}
        />
      ))}
      {canLoadMore ? (
        <Button size="xs" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? gt("Loading issues") : gt("Load more")}
        </Button>
      ) : null}
    </div>
  );
}
