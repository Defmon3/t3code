import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  approvalExplanationTarget,
  approvalExplanationView,
} from "@t3tools/client-runtime/state/approval-explanations";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ShieldIcon } from "lucide-react";
import { memo, use, useId, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { ApprovalExplanationPanel } from "./ApprovalExplanationPanel";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx, type TimelineRowSharedState } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const context = use(TimelineRowCtx);
  if (
    approval.requestKind === "command" &&
    context.threadRef !== null &&
    context.onRespondToApproval !== undefined
  ) {
    return (
      <TimelineCommandApprovalRow
        approval={approval}
        context={context}
        threadRef={context.threadRef}
      />
    );
  }
  return <TimelineBasicApprovalRow approval={approval} context={context} />;
});

function TimelineCommandApprovalRow({
  approval,
  context,
  threadRef,
}: {
  readonly approval: PendingApproval;
  readonly context: TimelineRowSharedState;
  readonly threadRef: ScopedThreadRef;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const explanationAtom = approvalExplanationAtom(approvalExplanationTarget(threadRef, approval));
  const result = useAtomValue(explanationAtom);
  const refreshExplanation = useAtomRefresh(explanationAtom);
  const explanation = approvalExplanationView(result);
  const canRespond = approval.responseCapability === "live";
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={context.pendingApprovals.size}
          commandExpanded={expanded}
          commandDetailId={detailId}
        />
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-2 pb-1 text-xs">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {context.onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!context.canOperateThread}
                    isResponding={context.respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    supportsFeedback={approval.supportsFeedback}
                    explanation={explanation}
                    onRespondToApproval={context.onRespondToApproval}
                    commandExpansion={{
                      expanded,
                      detailId,
                      onToggle: () => setExpanded((value) => !value),
                    }}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
        <ApprovalExplanationPanel
          explanation={explanation}
          waiting={result.waiting}
          onRetry={refreshExplanation}
        />
      </div>
    </WorkLogRow>
  );
}

function TimelineBasicApprovalRow({
  approval,
  context,
}: {
  readonly approval: PendingApproval;
  readonly context: TimelineRowSharedState;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = context;
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <code
          aria-label={presentation.detailLabel}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || presentation.label}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
}
