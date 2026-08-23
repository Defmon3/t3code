import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";
  const detailLabel =
    approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "File to read"
        : "File change";
  const isHookApproval = approval.source === "hook";
  const isEngineApproval = approval.source === "engine";
  const hasSourceContext = isHookApproval || isEngineApproval;
  const sourceLabel = isHookApproval
    ? "Project hook"
    : isEngineApproval
      ? "Engine permission"
      : null;

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">
          {hasSourceContext
            ? (approval.title ?? (isHookApproval ? "Hook approval requested" : approvalSummary))
            : approvalSummary}
        </span>
        {sourceLabel ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning text-xs">
            {sourceLabel}
          </span>
        ) : null}
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {hasSourceContext && approval.reason ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground">Reason</p>
          <p
            className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed"
            data-approval-reason="complete"
          >
            {approval.reason}
          </p>
        </div>
      ) : null}
      {hasSourceContext && approval.description && approval.description !== approval.reason ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground">Details</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {approval.description}
          </p>
        </div>
      ) : null}
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
