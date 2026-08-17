import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import type { IssuesSurface } from "~/rightPanelStore";

import GitHistoryPanel from "./GitHistoryPanel";
import type { IssueHandoffTarget } from "./issue/IssueDetailPanel";
import { IssuesPanel } from "./issue/IssuesPanel";
import type { IssueTabStatus } from "./RightPanelTabs";
import { Button } from "./ui/button";

interface GitHistoryWithIssuesPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly issueUrlPrefix?: string;
  readonly issuesCapabilityState: "loading" | "unavailable" | "ready";
  readonly projectId: ProjectId;
  readonly handoffTarget: IssueHandoffTarget;
  readonly onIssueStateChange: (status: IssueTabStatus) => void;
}

export default function GitHistoryWithIssuesPanel(props: GitHistoryWithIssuesPanelProps) {
  const [mode, setMode] = useState<"history" | "issues">("history");
  const [selectedIssue, setSelectedIssue] = useState<IssuesSurface["selected"]>(null);

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Repository history and issues"
    >
      <div
        className="flex shrink-0 items-center gap-1 border-b border-border/70 px-3 py-1.5"
        role="tablist"
        aria-label="Repository views"
      >
        <Button
          size="xs"
          variant={mode === "history" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "history"}
          onClick={() => setMode("history")}
        >
          History
        </Button>
        <Button
          size="xs"
          variant={mode === "issues" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "issues"}
          onClick={() => setMode("issues")}
        >
          Issues
        </Button>
      </div>

      <div
        hidden={mode !== "history"}
        aria-hidden={mode !== "history"}
        inert={mode !== "history" ? true : undefined}
        className="min-h-0 flex-1"
      >
        <GitHistoryPanel
          environmentId={props.environmentId}
          cwd={props.cwd}
          active={mode === "history"}
          {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
        />
      </div>

      {mode === "issues" ? (
        props.issuesCapabilityState === "loading" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Loading issues…
          </div>
        ) : props.issuesCapabilityState === "unavailable" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Update the environment server to browse issues.
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <IssuesPanel
              environmentId={props.environmentId}
              projectId={props.projectId}
              selected={selectedIssue}
              onSelect={setSelectedIssue}
              handoffTarget={props.handoffTarget}
              onStateChange={props.onIssueStateChange}
            />
          </div>
        )
      ) : null}
    </section>
  );
}
