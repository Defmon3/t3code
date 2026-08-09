import type { GitHistoryCommit } from "@t3tools/contracts";
import { CircleDotIcon, CloudIcon, GitBranchIcon, GitPullRequestIcon, TagIcon } from "lucide-react";
import * as Cause from "effect/Cause";

import { type GitHistoryGraphRow } from "../../lib/gitHistoryGraph";
import { cn } from "../../lib/utils";
import type { CommitRefKind, GitHistoryRow } from "./GitHistoryVisualTypes";

const ROW_HEIGHT = 26;
const LANE_WIDTH = 11;
const GRAPH_HORIZONTAL_PADDING = 6;
const MAX_GRAPH_WIDTH = 104;
const GRAPH_COLORS = ["#4f9cff", "#b26cff", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6"] as const;

export function queryErrorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not load Git history.";
}

export function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const now = new Date();
  const elapsedMs = now.valueOf() - date.valueOf();
  if (elapsedMs >= 0 && elapsedMs < 60 * 60 * 1_000) {
    const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${time}`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

function pullRequestNumberFromSubject(subject: string): string | null {
  return /^Merge pull request #(\d+)\b/i.exec(subject)?.[1] ?? null;
}

function CommitRefDecoration(props: {
  refName: string;
  refKinds: ReadonlyMap<string, CommitRefKind>;
}) {
  const refTarget = props.refName.split(" -> ", 1)[0] ?? props.refName;
  const explicitTag = props.refName.startsWith("tag: ");
  const label = explicitTag ? props.refName.slice(5) : props.refName;
  const kind = props.refName.startsWith("HEAD -> ")
    ? "head"
    : explicitTag
      ? "tag"
      : (props.refKinds.get(refTarget) ?? "local");
  const Icon =
    kind === "head"
      ? CircleDotIcon
      : kind === "remote"
        ? CloudIcon
        : kind === "tag"
          ? TagIcon
          : GitBranchIcon;
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground"
      title={`${kind === "head" ? "HEAD" : kind === "remote" ? "Remote branch" : kind === "tag" ? "Tag" : "Local branch"}: ${label}`}
    >
      <Icon
        className={cn(
          "size-3 shrink-0",
          kind === "head" && "text-sky-400",
          kind === "local" && "text-violet-400",
          kind === "remote" && "text-cyan-400",
          kind === "tag" && "text-amber-400",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function graphColumnWidth(laneCount: number): number {
  return Math.min(
    Math.max(LANE_WIDTH * laneCount + GRAPH_HORIZONTAL_PADDING * 2, 44),
    MAX_GRAPH_WIDTH,
  );
}

export function currentHeadHash(commits: ReadonlyArray<GitHistoryCommit>): string | undefined {
  return (
    commits.find((commit) =>
      commit.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> ")),
    )?.hash ?? commits[0]?.hash
  );
}

export function firstParentHashes(
  commits: ReadonlyArray<GitHistoryCommit>,
  headHash: string | undefined,
): ReadonlySet<string> {
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const hashes = new Set<string>();
  let hash = headHash;
  while (hash && !hashes.has(hash)) {
    hashes.add(hash);
    hash = commitsByHash.get(hash)?.parentHashes[0];
  }
  return hashes;
}

function GraphCell(props: { graph: GitHistoryGraphRow; laneCount: number; selected: boolean }) {
  const width = graphColumnWidth(props.laneCount);
  const centerY = ROW_HEIGHT / 2;
  const laneWidth = Math.min(
    LANE_WIDTH,
    (width - GRAPH_HORIZONTAL_PADDING * 2) / Math.max(props.laneCount, 1),
  );
  const x = (lane: number) => lane * laneWidth + GRAPH_HORIZONTAL_PADDING + laneWidth / 2;
  return (
    <svg
      aria-hidden="true"
      data-git-graph={props.graph.hash}
      className="h-full shrink-0 overflow-visible"
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      width={width}
      height={ROW_HEIGHT}
    >
      {props.graph.hasIncoming ? (
        <line
          x1={x(props.graph.lane)}
          y1="-1"
          x2={x(props.graph.lane)}
          y2={centerY}
          stroke={
            GRAPH_COLORS[
              (props.graph.incomingColorIndex ?? props.graph.colorIndex) % GRAPH_COLORS.length
            ]
          }
          strokeWidth="1.35"
        />
      ) : null}
      {props.graph.edges.map((edge, index) => {
        const fromX = edge.kind === "parent" ? x(props.graph.lane) : x(edge.fromLane);
        const fromY = edge.kind === "parent" ? centerY : 0;
        const toX = x(edge.toLane);
        const path =
          edge.kind === "continuation"
            ? `M ${fromX} -1 L ${toX} ${ROW_HEIGHT + 1}`
            : edge.kind === "incoming"
              ? `M ${fromX} -1 L ${fromX} ${centerY * 0.45} L ${toX} ${centerY}`
              : `M ${fromX} ${fromY} L ${fromX} ${centerY * 1.55} L ${toX} ${ROW_HEIGHT + 1}`;
        return (
          <path
            data-edge-kind={edge.kind}
            key={`${edge.kind}:${edge.fromLane}:${edge.toLane}:${edge.parentHash ?? index}`}
            d={path}
            fill="none"
            stroke={GRAPH_COLORS[edge.colorIndex % GRAPH_COLORS.length]}
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeDasharray={edge.isMissingParent ? "3 2" : undefined}
          />
        );
      })}
      <circle
        data-commit-node={props.graph.hash}
        cx={x(props.graph.lane)}
        cy={centerY}
        r={props.selected ? 4.4 : 3.35}
        fill={GRAPH_COLORS[props.graph.colorIndex % GRAPH_COLORS.length]}
        className="transition-[r]"
      />
    </svg>
  );
}

export function CommitRow(props: {
  row: GitHistoryRow;
  laneCount: number;
  refKinds: ReadonlyMap<string, CommitRefKind>;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  const { commit } = props.row;
  const pullRequestNumber = pullRequestNumberFromSubject(commit.subject);
  const isMergeCommit = commit.parentHashes.length > 1 || /^Merge\b/i.test(commit.subject);
  return (
    <button
      type="button"
      data-commit-hash={commit.hash}
      className={cn(
        "group flex w-full min-w-0 items-stretch border-b border-border/45 text-left outline-none transition-colors hover:bg-accent/45 focus-visible:bg-accent/60",
        props.selected && "bg-primary/15",
      )}
      style={{ height: ROW_HEIGHT }}
      onClick={() => props.onSelect(commit.hash)}
      aria-pressed={props.selected}
      aria-label={`${commit.subject || "No subject"}. ${isMergeCommit ? `${commit.parentHashes.length}-parent merge commit.` : "Commit."} ${commit.refs.length > 0 ? `Refs: ${commit.refs.join(", ")}.` : ""}`}
    >
      <GraphCell graph={props.row.graph} laneCount={props.laneCount} selected={props.selected} />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)_minmax(5rem,7rem)_8.5rem] items-center gap-x-3 pr-3 text-[11px] @max-[720px]:grid-cols-[minmax(10rem,1fr)_8.5rem]">
        <div className="min-w-0">
          <span
            className={cn(
              "block truncate font-medium",
              isMergeCommit ? "text-muted-foreground" : "text-foreground",
            )}
            title={commit.subject}
          >
            {commit.subject || "(no subject)"}
          </span>
        </div>
        <div className="flex min-w-0 justify-end gap-2 overflow-hidden @max-[720px]:hidden">
          {pullRequestNumber ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[10px] text-violet-400"
              title={`Pull request #${pullRequestNumber}`}
            >
              <GitPullRequestIcon className="size-3" />#{pullRequestNumber}
            </span>
          ) : null}
          {commit.refs.slice(0, 3).map((ref) => (
            <CommitRefDecoration key={ref} refName={ref} refKinds={props.refKinds} />
          ))}
          {commit.refs.length > 3 ? (
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              title={commit.refs.slice(3).join("\n")}
            >
              +{commit.refs.length - 3}
            </span>
          ) : null}
        </div>
        <span
          className="truncate text-muted-foreground @max-[720px]:hidden"
          title={commit.authorName}
        >
          {commit.authorName}
        </span>
        <span className="truncate text-muted-foreground">
          {formatCommitDate(commit.authoredAt)}
        </span>
      </div>
    </button>
  );
}
