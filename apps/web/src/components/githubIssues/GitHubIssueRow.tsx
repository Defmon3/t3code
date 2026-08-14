import type { GitHubIssueListResult } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import { memo, useSyncExternalStore } from "react";

import { Badge } from "../ui/badge";

type GitHubIssue = GitHubIssueListResult["items"][number];

const MAX_VISIBLE_ASSIGNEES = 2;
const MAX_VISIBLE_LABELS = 3;
const relativeTimeListeners = new Set<() => void>();
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined;

interface GitHubIssueRowProps {
  readonly issue: GitHubIssue;
  readonly wide: boolean;
  readonly onOpen: (url: string) => void;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Unknown time";

  const delta = Date.now() - timestamp;
  const minutes = Math.floor(Math.abs(delta) / 60_000);
  if (minutes === 0) return "just now";
  const prefix = delta < 0 ? "in " : "";
  const suffix = delta < 0 ? "" : " ago";

  if (minutes < 60) return `${prefix}${minutes}m${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${prefix}${hours}h${suffix}`;
  return `${prefix}${Math.floor(hours / 24)}d${suffix}`;
}

function relativeTimeSnapshot(): number {
  return Math.floor(Date.now() / 60_000);
}

function subscribeToRelativeTime(listener: () => void): () => void {
  relativeTimeListeners.add(listener);
  if (relativeTimeTimer === undefined) {
    relativeTimeTimer = setInterval(() => {
      for (const notify of relativeTimeListeners) notify();
    }, 60_000);
  }

  return () => {
    relativeTimeListeners.delete(listener);
    if (relativeTimeListeners.size === 0 && relativeTimeTimer !== undefined) {
      clearInterval(relativeTimeTimer);
      relativeTimeTimer = undefined;
    }
  };
}

function useRelativeTimeRefresh() {
  useSyncExternalStore(subscribeToRelativeTime, relativeTimeSnapshot, () => 0);
}

const githubIssueTypeColors: Readonly<Record<string, string>> = {
  BLUE: "0969da",
  GRAY: "57606a",
  GREEN: "1a7f37",
  ORANGE: "bc4c00",
  PINK: "bf3989",
  PURPLE: "8250df",
  RED: "cf222e",
  YELLOW: "9a6700",
};

function githubColorStyle(
  color: string,
):
  | { readonly backgroundColor: string; readonly borderColor: string; readonly color: string }
  | undefined {
  const normalized =
    githubIssueTypeColors[color.trim().toUpperCase()] ?? color.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return undefined;

  const hex = `#${normalized.toLowerCase()}`;

  return {
    backgroundColor: `${hex}1f`,
    borderColor: hex,
    color: `light-dark(color-mix(in srgb, ${hex} 72%, black), color-mix(in srgb, ${hex} 72%, white))`,
  };
}

function GitHubIssueTag({ name, color }: { readonly name: string; readonly color: string }) {
  const style = githubColorStyle(color);

  return (
    <Badge
      className="h-5 min-h-5 rounded-full border px-1.5 text-xs leading-none sm:h-5 sm:min-h-5 sm:text-xs"
      size="sm"
      variant="outline"
      style={style}
    >
      {name}
    </Badge>
  );
}

export const GitHubIssueRow = memo(function GitHubIssueRow({
  issue,
  wide,
  onOpen,
}: GitHubIssueRowProps) {
  useRelativeTimeRefresh();
  const createdAt = relativeTime(issue.createdAt);
  const visibleAssignees = issue.assignees.slice(0, MAX_VISIBLE_ASSIGNEES);
  const hiddenAssigneeCount = issue.assignees.length - visibleAssignees.length;
  const visibleLabels = issue.labels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = issue.labels.length - visibleLabels.length;
  const metadata = [
    { key: "author", text: issue.author ? `@${issue.author.login}` : "Unknown author" },
    { key: "created-at", text: createdAt },
    ...visibleAssignees.map((assignee, index) => ({
      key: `assignee-${assignee.login}-${index}`,
      text: `@${assignee.login}`,
    })),
    ...(hiddenAssigneeCount > 0
      ? [{ key: "assignees-overflow", text: `+${hiddenAssigneeCount} assignees` }]
      : []),
    ...(issue.milestone ? [{ key: "milestone", text: issue.milestone.title }] : []),
  ];
  const ariaMetadata = [
    `number ${issue.number}`,
    ...(issue.issueType ? [`type ${issue.issueType.name}`] : []),
    ...issue.labels.map((label) => `label ${label.name}`),
    issue.author ? `author ${issue.author.login}` : "unknown author",
    `created ${createdAt}`,
    ...issue.assignees.map((assignee) => `assignee ${assignee.login}`),
    ...(issue.milestone ? [`milestone ${issue.milestone.title}`] : []),
  ];
  return (
    <button
      type="button"
      className="flex w-full min-w-0 flex-col gap-1 border-b border-border/70 px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(issue.url)}
      aria-label={`${issue.state} issue ${issue.title}, ${ariaMetadata.join(", ")}, ${issue.commentCount} comments`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={issue.state === "open" ? "text-success" : "text-muted-foreground"}
          aria-hidden="true"
        >
          {issue.state === "open" ? "●" : "○"}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
            {issue.title}
          </span>
          {visibleLabels.map((label) => (
            <GitHubIssueTag key={label.name} name={label.name} color={label.color} />
          ))}
          {hiddenLabelCount > 0 ? (
            <span aria-label={`${hiddenLabelCount} more labels`}>+{hiddenLabelCount}</span>
          ) : null}
        </div>
        {wide ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <MessageSquareIcon className="size-3" />
            {issue.commentCount}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-5 text-xs text-muted-foreground">
        {issue.issueType ? (
          <GitHubIssueTag name={issue.issueType.name} color={issue.issueType.color} />
        ) : null}
        <span className="tabular-nums">#{issue.number}</span>
        {metadata.map((item) => (
          <span key={item.key}>{item.text}</span>
        ))}
        {!wide ? (
          <span className="flex items-center gap-1">
            <MessageSquareIcon className="size-3" />
            {issue.commentCount}
          </span>
        ) : null}
      </div>
    </button>
  );
});
