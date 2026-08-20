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

  if (isHookApproval) {
    const title = approval.title ?? "Hook approval requested";
    return (
      <div aria-label={title} className={cn("min-w-0 flex-1 space-y-2", className)} role="group">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium text-xs text-foreground">{title}</span>
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning text-[10px]">
            Project hook
          </span>
          {pendingCount > 1 ? (
            <span className="text-[10px] text-muted-foreground tabular-nums">1/{pendingCount}</span>
          ) : null}
        </div>
        {approval.reason ? (
          <p
            className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85"
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
        <code
          aria-label={detailAriaLabel}
          className="block max-h-20 min-w-0 overflow-auto whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || fallbackLabel}
        </code>
      </div>
    );
  }

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
});
