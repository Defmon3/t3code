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
  const hookTitle = approval.title ?? "Hook approval requested";
  const hasDistinctHookDescription =
    isHookApproval && approval.description && approval.description !== approval.reason;

  return (
    <div
      aria-label={isHookApproval ? hookTitle : fallbackLabel}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      role="group"
    >
      <div className="min-w-0 flex-1">
        {isHookApproval ? (
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] font-medium text-foreground/85">{hookTitle}</span>
            <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
              Project hook
            </span>
          </div>
        ) : null}
        {isHookApproval && approval.reason ? (
          <p
            className="mb-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/85"
            data-approval-reason="complete"
          >
            {approval.reason}
          </p>
        ) : null}
        {hasDistinctHookDescription ? (
          <p className="mb-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
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
      {pendingCount > 1 ? (
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
          1/{pendingCount}
        </span>
      ) : null}
    </div>
  );
});
