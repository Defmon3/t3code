import type { EnvironmentId, IssueLink, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import type { IssuesSurface, RepositoryView } from "~/rightPanelStore";

import GitHistoryPanel from "./GitHistoryPanel";
import type { IssueHandoffTarget } from "./issue/IssueDetailPanel";
import { IssuesPanel } from "./issue/IssuesPanel";
import { PullRequestsPanel, type PullRequestPanelSelection } from "./pullRequest/PullRequestsPanel";
import type { IssueTabStatus, PullRequestTabStatus } from "./RightPanelTabs";
import { Button } from "./ui/button";

interface RepositoryPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly issueUrlPrefix?: string;
  readonly gitHistoryCapabilityState: "unavailable" | "ready";
  readonly issuesCapabilityState: "loading" | "unavailable" | "ready";
  readonly pullRequestsCapabilityState: "loading" | "unavailable" | "ready";
  readonly projectId: ProjectId;
  readonly handoffTarget: IssueHandoffTarget;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly view: RepositoryView;
  readonly onViewChange: (view: RepositoryView) => void;
  readonly onIssueStateChange: (status: IssueTabStatus) => void;
  readonly onPullRequestStateChange: (status: PullRequestTabStatus) => void;
  readonly onOpenLinkedIssue: (link: IssueLink) => void;
}

export default function RepositoryPanel(props: RepositoryPanelProps) {
  const [selectedIssue, setSelectedIssue] = useState<IssuesSurface["selected"]>(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState<PullRequestPanelSelection | null>(
    null,
  );
  const mode = props.view;

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Repository history, issues, and pull requests"
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
          onClick={() => props.onViewChange("history")}
        >
          History
        </Button>
        <Button
          size="xs"
          variant={mode === "issues" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "issues"}
          onClick={() => props.onViewChange("issues")}
        >
          Issues
        </Button>
        <Button
          size="xs"
          variant={mode === "pull-requests" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "pull-requests"}
          onClick={() => props.onViewChange("pull-requests")}
        >
          Pull Requests
        </Button>
      </div>

      {props.gitHistoryCapabilityState === "ready" ? (
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
      ) : mode === "history" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Update the environment server to browse Git History.
        </div>
      ) : null}

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

      {mode === "pull-requests" ? (
        props.pullRequestsCapabilityState === "loading" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Loading pull requests…
          </div>
        ) : props.pullRequestsCapabilityState === "unavailable" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Update the environment server to browse pull requests.
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <PullRequestsPanel
              environmentId={props.environmentId}
              projectId={props.projectId}
              selected={selectedPullRequest}
              onSelect={setSelectedPullRequest}
              composerDraftTarget={props.composerDraftTarget}
              onStateChange={props.onPullRequestStateChange}
              onOpenLinkedIssue={props.onOpenLinkedIssue}
            />
          </div>
        )
      ) : null}
    </section>
  );
}
