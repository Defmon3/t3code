import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { memo } from "react";
import { ShieldIcon } from "lucide-react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
  commandExpanded?: boolean;
  commandDetailId?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
  commandExpanded = false,
  commandDetailId,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span
        className={cn(
          "flex w-full min-w-0 flex-wrap items-center gap-2 text-muted-foreground",
          approval.requestKind === "command" ? "text-xs" : "text-2xs",
        )}
      >
        {approval.requestKind === "command" ? (
          <ShieldIcon className="size-4 shrink-0 text-warning" aria-hidden />
        ) : null}
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride)}
            </PopoverPopup>
          </Popover>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <Detail
        id={commandDetailId}
        aria-label={detailAriaLabel}
        className={cn(
          "block w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          approval.requestKind === "command"
            ? cn(
                "whitespace-pre-wrap rounded-md border border-border bg-background/50 p-3 font-mono text-sm leading-relaxed wrap-anywhere",
                commandExpanded ? "max-h-96" : "max-h-24",
              )
            : approval.requestKind === "mcp-elicitation"
              ? "max-h-20 whitespace-pre-wrap font-sans wrap-break-word"
              : "max-h-40 whitespace-pre-wrap font-mono wrap-anywhere",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone. Interrupt or restart the run to respond."
          : (approval.command ?? approval.detail ?? fallbackLabel)}
      </Detail>
      {approval.cwd ? (
        <span className="flex w-full min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">Working directory</span>
          <code className="min-w-0 wrap-anywhere">{approval.cwd}</code>
        </span>
      ) : null}
      {approval.reason ? (
        <span
          className={cn(
            "w-full min-w-0 whitespace-pre-wrap text-muted-foreground wrap-break-word",
            approval.requestKind === "command" ? "text-xs" : "text-2xs",
          )}
        >
          {approval.reason}
        </span>
      ) : null}
      {approval.sessionApprovalScope ? (
        <span className="w-full min-w-0 text-xs text-muted-foreground wrap-anywhere">
          {approval.sessionApprovalScope}
        </span>
      ) : null}
    </span>
  );
});
