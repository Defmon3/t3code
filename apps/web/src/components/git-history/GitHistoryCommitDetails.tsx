import type { GitCommitChangedFile, GitCommitDetails } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { cn } from "../../lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { formatCommitDate } from "./GitHistoryCommitList";

const FILE_STATUS_COLORS = {
  A: "text-emerald-500",
  M: "text-amber-500",
  D: "text-red-500",
  T: "text-sky-500",
  U: "text-red-500",
  X: "text-muted-foreground",
  B: "text-muted-foreground",
} as const;

function countTreeFiles(node: TurnDiffTreeNode): number {
  return node.kind === "file"
    ? 1
    : node.children.reduce((count, child) => count + countTreeFiles(child), 0);
}

function CommitFilesTree(props: {
  files: ReadonlyArray<GitCommitChangedFile>;
  onShowDiff: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const nodes = useMemo(
    () =>
      buildTurnDiffTree(
        props.files.map((file) => ({
          path: file.path,
          kind: file.status,
          additions: 0,
          deletions: 0,
        })),
      ),
    [props.files],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const statusByPath = useMemo(
    () => new Map(props.files.map((file) => [file.path.replaceAll("\\", "/"), file.status])),
    [props.files],
  );
  const renderNode = (node: TurnDiffTreeNode, depth: number): ReactNode => {
    const paddingLeft = depth * 14 + 4;
    if (node.kind === "directory") {
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={`directory:${node.path}`}>
          <button
            type="button"
            className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ paddingLeft }}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? (
              <ChevronRightIcon className="size-3 shrink-0" />
            ) : (
              <ChevronDownIcon className="size-3 shrink-0" />
            )}
            {isCollapsed ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
            <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
              {countTreeFiles(node)} files
            </span>
          </button>
          {!isCollapsed ? node.children.map((child) => renderNode(child, depth + 1)) : null}
        </div>
      );
    }
    const status = statusByPath.get(node.path);
    return (
      <button
        type="button"
        key={`file:${node.path}`}
        className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded pr-1 text-left text-[11px] hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        style={{ paddingLeft: paddingLeft + 17 }}
        onClick={() => props.onShowDiff(node.path)}
        title={`Show diff for ${node.path}`}
      >
        <span
          className={cn(
            "w-3 shrink-0 font-mono font-semibold",
            status ? FILE_STATUS_COLORS[status] : "text-muted-foreground",
          )}
        >
          {status ?? "?"}
        </span>
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{node.name}</span>
      </button>
    );
  };
  return <div>{nodes.map((node) => renderNode(node, 0))}</div>;
}

export function CommitDetailsPane(props: {
  className?: string;
  style?: CSSProperties;
  id?: string;
  details: GitCommitDetails | null;
  isPending: boolean;
  hasError: boolean;
  hasSelection: boolean;
  onRetry: () => void;
  onShowDiff: (hash: string, filePath?: string) => void;
}) {
  if (!props.hasSelection)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 items-center justify-center border-l border-border/60 px-6 text-center text-xs text-muted-foreground",
          props.className,
        )}
      >
        Select a commit to inspect its files and metadata.
      </aside>
    );
  if (props.hasError)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 flex-col items-center justify-center gap-3 border-l border-border/60 px-6 text-center text-xs text-destructive",
          props.className,
        )}
      >
        Could not load commit details.
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </aside>
    );
  if (props.isPending || props.details === null)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 items-center justify-center border-l border-border/60 text-xs text-muted-foreground",
          props.className,
        )}
      >
        <RefreshCwIcon className="mr-2 size-3.5 animate-spin" /> Loading commit…
      </aside>
    );
  const details = props.details;
  return (
    <aside
      id={props.id}
      style={props.style}
      className={cn(
        "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 flex-col border-l border-border/60 bg-muted/5",
        props.className,
      )}
    >
      <div className="shrink-0 border-b border-border/60 p-3 text-[11px]">
        <h2 className="text-sm font-semibold leading-5 text-foreground">{details.subject}</h2>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span>{details.authorName}</span>
          <span>{formatCommitDate(details.authoredAt)}</span>
          <span className="font-mono" title={details.hash}>
            {details.hash.slice(0, 8)}
          </span>
        </div>
        {details.refs.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {details.refs.map((ref) => (
              <span key={ref} className="text-[10px] text-primary">
                {ref}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-b border-border/60">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 py-2 text-[11px] font-medium">
          <span>
            {details.changedFiles.length} changed{" "}
            {details.changedFiles.length === 1 ? "file" : "files"}
          </span>
          <Button size="xs" variant="outline" onClick={() => props.onShowDiff(details.hash)}>
            <FileDiffIcon className="size-3" /> View all changes
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <CommitFilesTree
            files={details.changedFiles}
            onShowDiff={(path) => props.onShowDiff(details.hash, path)}
          />
        </div>
      </div>
      <div className="max-h-[34%] shrink-0 overflow-y-auto p-3 text-[11px]">
        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
          <dt>Commit</dt>
          <dd className="truncate font-mono text-foreground" title={details.hash}>
            {details.hash}
          </dd>
          <dt>Email</dt>
          <dd className="truncate text-foreground">{details.authorEmail}</dd>
          <dt>Date</dt>
          <dd className="text-foreground">{formatCommitDate(details.authoredAt)}</dd>
          <dt>Parents</dt>
          <dd className="truncate font-mono text-foreground">
            {details.parentHashes.map((hash) => hash.slice(0, 8)).join(", ") || "None"}
          </dd>
        </dl>
        {details.body.trim().length > 0 ? (
          <p className="mt-4 whitespace-pre-wrap border-t border-border/50 pt-3 leading-5 text-foreground/85">
            {details.body.trim()}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
