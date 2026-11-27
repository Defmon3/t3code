import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_LABEL,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react";
import { memo } from "react";
import { hookApprovalBypassSteps } from "@t3tools/client-runtime/state/hook-approvals";
import { ShieldIcon, ShieldAlertIcon } from "lucide-react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ApprovalText } from "./ApprovalText";
import { composerFloatingLayerProps } from "./composerEventScope";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";
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
  const m = useMessages();
  const gt = useGT();
  const { bypass, pushHooks } = approval;
  const fallbackLabel = pushHooks
    ? m(PUSH_HOOKS_APPROVAL_LABEL)
    : bypass
      ? gt("BYPASS ATTEMPT")
      : approval.requestKind === "mcp-elicitation"
        ? gt("App access approval")
        : approval.requestKind === "command"
          ? gt("Command approval")
          : approval.requestKind === "file-read"
            ? gt("File read approval")
            : approval.requestKind === "permission"
              ? gt("App permission approval")
              : gt("File change approval");
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? gt("App access request")
      : approval.requestKind === "command"
        ? gt("Command", { $context: "noun, shell command awaiting approval" })
        : approval.requestKind === "file-read"
          ? gt("File to read")
          : approval.requestKind === "permission"
            ? gt("Permission request")
            : gt("File change");

  return (
    <div
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
        {approval.bypass ? (
          <ShieldAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : approval.requestKind === "command" ? (
          <ShieldIcon className="size-4 shrink-0 text-warning" aria-hidden />
        ) : null}
        <span
          className={
            approval.bypass ? "font-semibold text-destructive" : "shrink-0 font-medium text-warning"
          }
        >
          {fallbackLabel}
        </span>
        {approval.appName && !pushHooks ? (
          <span className="min-w-0 truncate">{approval.appName}</span>
        ) : null}
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {m(FULL_ACCESS_OVERRIDE_QUESTION)}
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
            </PopoverPopup>
          </Popover>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      {bypass ? (
        <span className="flex w-full min-w-0 flex-col gap-1 text-sm wrap-anywhere">
          <span className="font-semibold text-destructive">
            {gt("Rule: {rule}", { rule: bypass.rule })}
          </span>
          <span>
            {gt("Technique: {technique} · Tier {tier}", {
              technique: bypass.technique,
              tier: bypass.tier,
            })}
          </span>
          <span className="whitespace-pre-wrap">{bypass.reasoning}</span>
        </span>
      ) : null}
      <div id={commandDetailId} className="w-full min-w-0 text-xs">
        {approval.responseCapability === "not_resumable" ? (
          <span>
            <T>Provider process is gone. Interrupt or restart the run to respond.</T>
          </span>
        ) : pushHooks ? (
          <>
            <span className="block text-foreground">{m(PUSH_HOOKS_APPROVAL_QUESTION)}</span>
            <PushHooksApprovalDetails pushHooks={pushHooks} />
          </>
        ) : bypass ? (
          <div
            aria-label={detailAriaLabel}
            className={cn(
              "overflow-auto rounded-md border border-destructive bg-destructive/10 p-3 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              commandExpanded ? "max-h-96" : "max-h-24",
            )}
            tabIndex={0}
          >
            {hookApprovalBypassSteps(bypass).map((step, index) => (
              <div
                key={step.key}
                className={cn(step.triggered && "bg-destructive/10 font-semibold text-destructive")}
              >
                <span>
                  {step.triggered
                    ? gt("Step {step} · TRIGGERED:", { step: index + 1 })
                    : gt("Step {step}:", { step: index + 1 })}
                </span>
                <ApprovalText text={step.command} />
              </div>
            ))}
          </div>
        ) : (
          <ApprovalText
            text={approval.command ?? approval.detail ?? fallbackLabel}
            label={detailAriaLabel}
            className={
              approval.requestKind === "command"
                ? cn(
                    "rounded-md border border-border bg-background/50 p-3 text-sm leading-relaxed",
                    commandExpanded ? "max-h-96" : "max-h-24",
                  )
                : approval.requestKind === "mcp-elicitation"
                  ? "max-h-20 font-sans wrap-break-word"
                  : "max-h-40"
            }
          />
        )}
      </div>
      {bypass ? (
        <span className="flex w-full min-w-0 flex-col gap-1 text-xs wrap-anywhere">
          <span>
            {gt("Runtime: {runtime} · Model: {model}", {
              runtime: bypass.runtime,
              model: bypass.model,
            })}
          </span>
          {commandExpanded ? (
            <>
              <span>{gt("Session: {value}", { value: bypass.sessionId })}</span>
              <span>{gt("Thread: {value}", { value: bypass.threadTitle })}</span>
              <span>{gt("Thread ID: {value}", { value: bypass.threadId })}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              <T>Expand to see session and thread details.</T>
            </span>
          )}
        </span>
      ) : null}
      {approval.cwd ? (
        <span className="flex w-full min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">
            <T>Working directory</T>
          </span>
          <code className="min-w-0 wrap-anywhere">{approval.cwd}</code>
        </span>
      ) : null}
      {approval.reason && approval.reason !== approval.bypass?.rule ? (
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
    </div>
  );
});
