import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { Activity, lazy, Suspense, useRef, useState, type KeyboardEvent } from "react";

import type { IssueSelection, RepositoryView } from "~/rightPanelStore";
import type { GitHistoryPanelStore } from "./git-history/GitHistoryPanelState";

import type { IssueHandoffTarget } from "./issue/IssueDetailPanel";
import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import type { IssueTabStatus } from "./RightPanelTabs";
import { Button } from "./ui/button";

const GitHistoryPanel = lazy(() => import("./GitHistoryPanel"));
const IssuesPanel = lazy(() =>
  import("./issue/IssuesPanel").then(({ IssuesPanel }) => ({ default: IssuesPanel })),
);

const views = ["history", "issues", "pull-requests"] as const;

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
  readonly issueContext: { projectId: ProjectId; handoffTarget: IssueHandoffTarget } | null;
  readonly selectedIssue: IssueSelection | null;
  readonly view: RepositoryView;
  readonly active: boolean;
  readonly gitHistoryAvailable: boolean;
  readonly gitHistoryPanelStore: GitHistoryPanelStore;
  readonly issuesAvailable: boolean;
  readonly onViewChange: (view: RepositoryView) => void;
  readonly onSelectIssue: (selected: IssueSelection | null) => void;
  readonly onIssueStateChange: (status: IssueTabStatus) => void;
  readonly onOpenLinkedPullRequest: (link: {
    repository: string;
    number: number;
    url: string;
  }) => void;
}

export default function RepositoryPanel(props: RepositoryPanelProps) {
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
      aria-label="Repository"
    >
      <div
        className="flex shrink-0 gap-1 border-b border-border/70 px-3 py-1.5"
        role="tablist"
        aria-label="Repository views"
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
            {view === "history" ? "History" : view === "issues" ? "Issues" : "Pull Requests"}
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
                  active={props.active && props.view === "history"}
                  stateStore={props.gitHistoryPanelStore}
                  stateScopeKey={`${props.threadRef.environmentId}:${props.threadRef.threadId}`}
                />
              </Suspense>
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Update the environment server to browse Git History.
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
            {props.issuesAvailable && props.issueContext ? (
              <Suspense fallback={null}>
                <IssuesPanel
                  environmentId={props.environmentId}
                  projectId={props.issueContext.projectId}
                  selected={props.selectedIssue}
                  onSelect={props.onSelectIssue}
                  handoffTarget={props.issueContext.handoffTarget}
                  onStateChange={props.onIssueStateChange}
                  onOpenLinkedPullRequest={props.onOpenLinkedPullRequest}
                />
              </Suspense>
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {props.issuesAvailable
                  ? "Open a project thread to browse issues."
                  : "Update the environment server to browse issues."}
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
