import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Activity, lazy, Suspense, useRef, useState, type KeyboardEvent } from "react";

import type { RepositoryView } from "~/rightPanelStore";

import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import { Button } from "./ui/button";

const GitHistoryPanel = lazy(() => import("./GitHistoryPanel"));

const views = ["history", "pull-requests"] as const;

export function repositoryViewFromKey(view: RepositoryView, key: string): RepositoryView | null {
  const index = views.indexOf(view);
  if (key === "ArrowRight") return views[(index + 1) % views.length] ?? null;
  if (key === "ArrowLeft") return views[(index + views.length - 1) % views.length] ?? null;
  if (key === "Home") return views[0] ?? null;
  if (key === "End") return views.at(-1) ?? null;
  return null;
}

export default function RepositoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly view: RepositoryView;
  readonly active: boolean;
  readonly gitHistoryAvailable: boolean;
  readonly onViewChange: (view: RepositoryView) => void;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const [historyActivated, setHistoryActivated] = useState(props.view === "history");
  if (props.view === "history" && !historyActivated) setHistoryActivated(true);
  const select = (view: RepositoryView) => props.onViewChange(view);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, view: RepositoryView) => {
    const next = repositoryViewFromKey(view, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
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
            onClick={() => select(view)}
            onKeyDown={(event) => onKeyDown(event, view)}
          >
            {view === "history" ? "History" : "Pull Requests"}
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
            {props.gitHistoryAvailable && props.cwd !== null ? (
              <Suspense fallback={null}>
                <GitHistoryPanel
                  environmentId={props.environmentId}
                  cwd={props.cwd}
                  active={props.active && props.view === "history"}
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
