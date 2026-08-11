import type { VcsRef } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import type { GitRefTreeNode } from "../../lib/gitRefTree";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import type { RefTreeProps } from "./GitHistoryVisualTypes";

function RefTree(props: RefTreeProps) {
  const depth = props.depth ?? 0;
  return props.nodes.map((node) => {
    if (node.kind === "folder") {
      const key = `${props.section}:${node.path}`;
      const isExpanded = props.filterActive || props.expanded.has(key);
      return (
        <div key={key}>
          <button
            type="button"
            className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] text-foreground/80 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
            onClick={() => props.onToggle(key)}
            aria-expanded={isExpanded}
            title={node.path}
          >
            {isExpanded ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded ? <RefTree {...props} nodes={node.children} depth={depth + 1} /> : null}
        </div>
      );
    }
    const revision = `refs/${props.namespace}/${node.ref.name}`;
    const selected = props.selectedRevision === revision;
    const aheadCount = node.ref.aheadCount ?? 0;
    const behindCount = node.ref.behindCount ?? 0;
    return (
      <button
        type="button"
        key={revision}
        className={cn(
          "flex h-6 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] text-foreground/80 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          selected && "bg-primary/12 font-medium text-primary",
        )}
        style={{ paddingLeft: `${depth * 14 + 20}px` }}
        title={node.ref.name}
        onClick={() => props.onSelect(node.ref.name, revision)}
        aria-pressed={selected}
      >
        {node.ref.isDefault ? (
          <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" />
        ) : props.namespace === "tags" ? (
          <TagIcon className="size-3 shrink-0 text-amber-400" />
        ) : (
          <GitBranchIcon className={cn("size-3 shrink-0", node.ref.current && "text-primary")} />
        )}
        <span className="truncate">{node.name}</span>
        {aheadCount > 0 || behindCount > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[9px]">
            {aheadCount > 0 ? (
              <span
                className="flex items-center text-emerald-400"
                title={`${aheadCount} commits ahead of ${node.ref.upstreamName ?? "the configured upstream"}`}
              >
                <ArrowUpIcon className="size-2.5" />
                {aheadCount > 99 ? "99+" : aheadCount}
              </span>
            ) : null}
            {behindCount > 0 ? (
              <span
                className="flex items-center text-sky-400"
                title={`${behindCount} commits behind ${node.ref.upstreamName ?? "the configured upstream"}`}
              >
                <ArrowDownIcon className="size-2.5" />
                {behindCount > 99 ? "99+" : behindCount}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    );
  });
}

function countRefTreeRefs(nodes: ReadonlyArray<GitRefTreeNode>): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === "ref" ? 1 : countRefTreeRefs(node.children)),
    0,
  );
}

function RefSection(props: {
  label: string;
  section: string;
  nodes: ReadonlyArray<GitRefTreeNode>;
  namespace: RefTreeProps["namespace"];
  open: boolean;
  treeProps: Omit<RefTreeProps, "nodes" | "namespace" | "section">;
  onToggle: () => void;
}) {
  const refCount = countRefTreeRefs(props.nodes);
  return (
    <div>
      <button
        type="button"
        className="flex h-7 w-full items-center gap-1 px-1 text-left text-[10px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={props.onToggle}
        aria-expanded={props.open}
      >
        {props.open ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        {props.label}
        <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">
          {refCount}
        </span>
      </button>
      {props.open ? (
        <RefTree
          {...props.treeProps}
          nodes={props.nodes}
          namespace={props.namespace}
          section={props.section}
        />
      ) : null}
    </div>
  );
}

export function GitRefsPane(props: {
  className?: string;
  style?: CSSProperties;
  id?: string;
  refFilter: string;
  onRefFilterChange: (value: string) => void;
  selectedRevision: { label: string; revision: string } | null;
  onSelectAll: () => void;
  currentRef: VcsRef | null;
  onSelectRef: (label: string, revision: string) => void;
  normalizedRefFilter: string;
  localRefTree: ReadonlyArray<GitRefTreeNode>;
  remoteRefTree: ReadonlyArray<GitRefTreeNode>;
  tagRefTree: ReadonlyArray<GitRefTreeNode>;
  expandedRefKeys: ReadonlySet<string>;
  onToggleRefKey: (key: string) => void;
  sharedRefTreeProps: Omit<RefTreeProps, "nodes" | "namespace" | "section">;
  hasMoreRefs: boolean;
  isFetchingMoreRefs: boolean;
  onLoadMoreRefs: () => void;
  refPaginationError: string | null;
  onRetryRefs: () => void;
  onClose?: () => void;
}) {
  return (
    <aside
      id={props.id}
      style={props.style}
      className={cn(
        "flex w-[24%] min-w-48 max-w-72 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/15",
        props.className,
      )}
      aria-label="Branches and tags"
    >
      {props.onClose ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-3">
          <span className="text-xs font-medium">Branches and tags</span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={props.onClose}
            aria-label="Close branches and tags"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div className="relative shrink-0 border-b border-border/50 p-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus={props.onClose ? true : undefined}
          className="h-7 w-full rounded border border-input bg-background/30 pr-2 pl-7 text-[11px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          value={props.refFilter}
          onChange={(event) => props.onRefFilterChange(event.target.value)}
          placeholder="Branch or tag"
          aria-label="Filter branches and tags"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        <button
          type="button"
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            props.selectedRevision === null && "bg-primary/12 font-medium text-primary",
          )}
          onClick={props.onSelectAll}
          aria-pressed={props.selectedRevision === null}
        >
          <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
          <span className="truncate">All refs</span>
        </button>
        <button
          type="button"
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] text-foreground/90 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          disabled={props.currentRef === null}
          onClick={() => {
            if (props.currentRef)
              props.onSelectRef(props.currentRef.name, `refs/heads/${props.currentRef.name}`);
          }}
        >
          <GitBranchIcon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">HEAD (Current Branch)</span>
        </button>
        <RefSection
          label="Local"
          section="local"
          nodes={props.localRefTree}
          namespace="heads"
          open={props.normalizedRefFilter.length > 0 || props.expandedRefKeys.has("section:local")}
          treeProps={props.sharedRefTreeProps}
          onToggle={() => props.onToggleRefKey("section:local")}
        />
        <RefSection
          label="Remote"
          section="remote"
          nodes={props.remoteRefTree}
          namespace="remotes"
          open={props.normalizedRefFilter.length > 0 || props.expandedRefKeys.has("section:remote")}
          treeProps={props.sharedRefTreeProps}
          onToggle={() => props.onToggleRefKey("section:remote")}
        />
        <RefSection
          label="Tags"
          section="tags"
          nodes={props.tagRefTree}
          namespace="tags"
          open={props.normalizedRefFilter.length > 0 || props.expandedRefKeys.has("section:tags")}
          treeProps={props.sharedRefTreeProps}
          onToggle={() => props.onToggleRefKey("section:tags")}
        />
        {props.normalizedRefFilter.length > 0 &&
        props.localRefTree.length + props.remoteRefTree.length + props.tagRefTree.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            No matching branches or tags.
          </p>
        ) : null}
        {props.refPaginationError ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            <span className="min-w-0 truncate" title={props.refPaginationError}>
              {props.refPaginationError}
            </span>
            <Button size="xs" variant="ghost" className="shrink-0" onClick={props.onRetryRefs}>
              Retry refs
            </Button>
          </div>
        ) : null}
        {props.hasMoreRefs ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-2 w-full"
            onClick={props.onLoadMoreRefs}
            disabled={props.isFetchingMoreRefs}
          >
            {props.isFetchingMoreRefs ? "Loading more refs…" : "Load more refs"}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
