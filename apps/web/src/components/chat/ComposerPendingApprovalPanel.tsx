import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "command"
      ? "Command approval"
      : approval.requestKind === "file-read"
        ? "File read approval"
        : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "File to read"
        : "File change";
  const isHookApproval = approval.source === "hook";
  const isEngineApproval = approval.source === "engine";
  const hasSourceContext = isHookApproval || isEngineApproval;

  if (!hasSourceContext) {
    return (
      <div
        aria-label={fallbackLabel}
        className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
        role="group"
      >
        <code
          aria-label={detailAriaLabel}
          className="block max-h-20 min-w-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || fallbackLabel}
        </code>
        {pendingCount > 1 ? (
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
    );
  }

  const title =
    approval.title ?? (isHookApproval ? "Hook approval requested" : "Approval required");
  const sourceLabel = isHookApproval ? "Project hook" : "Engine permission";

  return (
    <div aria-label={title} className={cn("min-w-0 flex-1 space-y-2.5", className)} role="group">
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        <span className="min-w-0 font-medium text-sm text-foreground">{title}</span>
        {pendingCount > 1 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            1 of {pendingCount}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 rounded-full border border-warning/25 bg-warning/8 px-2 py-0.5 text-[10px] font-medium text-warning">
          {sourceLabel}
        </span>
      </div>
      {approval.reason ? (
        <p
          className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground"
          data-approval-reason="complete"
        >
          {approval.reason}
        </p>
      ) : null}
      {approval.description && approval.description !== approval.reason ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {approval.description}
        </p>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-lg border border-border/55 bg-background/50">
        <div className="border-b border-border/45 px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
          Requested action
        </div>
        <code
          aria-label="Requested action"
          className="block max-h-28 min-w-0 overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/85 [overflow-wrap:anywhere] [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || fallbackLabel}
        </code>
      </div>
    </div>
  );
});
