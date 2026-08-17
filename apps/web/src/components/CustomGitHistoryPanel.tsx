import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import GitHistoryPanel, { useWideHistoryLayout } from "./GitHistoryPanel";
import { GitHubIssuesPane } from "./githubIssues/GitHubIssuesPane";
import { Button } from "./ui/button";

interface CustomGitHistoryPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly issueUrlPrefix?: string;
  readonly githubIssuesCapabilityKnown: boolean;
  readonly githubIssuesAvailable: boolean;
}

export function githubIssuesAvailability(
  capabilityKnown: boolean,
  available: boolean,
): "checking" | "unavailable" | "available" {
  if (!capabilityKnown) return "checking";
  return available ? "available" : "unavailable";
}

export default function CustomGitHistoryPanel(props: CustomGitHistoryPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const isWideLayout = useWideHistoryLayout(panelRef);
  const [mode, setMode] = useState<"tree" | "issues">("tree");
  const [issuesVisited, setIssuesVisited] = useState(false);
  const issuesAvailability = githubIssuesAvailability(
    props.githubIssuesCapabilityKnown,
    props.githubIssuesAvailable,
  );

  const selectMode = (next: "tree" | "issues") => {
    if (next === "issues") setIssuesVisited(true);
    setMode(next);
  };

  return (
    <section
      ref={panelRef}
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
          variant={mode === "tree" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "tree"}
          onClick={() => selectMode("tree")}
        >
          Tree
        </Button>
        <Button
          size="xs"
          variant={mode === "issues" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "issues"}
          onClick={() => selectMode("issues")}
        >
          Issues
        </Button>
      </div>
      <div
        hidden={mode !== "tree"}
        aria-hidden={mode !== "tree"}
        inert={mode !== "tree" ? true : undefined}
        className="min-h-0 flex-1"
      >
        <GitHistoryPanel
          environmentId={props.environmentId}
          cwd={props.cwd}
          active={mode === "tree"}
          {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
        />
      </div>
      {mode === "issues" ? (
        issuesAvailability === "checking" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Checking whether this environment supports GitHub Issues…
          </div>
        ) : issuesAvailability === "unavailable" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Update the environment server to browse GitHub Issues here.
          </div>
        ) : issuesVisited ? (
          <GitHubIssuesPane
            environmentId={props.environmentId}
            cwd={props.cwd}
            wide={isWideLayout}
          />
        ) : null
      ) : null}
    </section>
  );
}
