import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_LABEL,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  approvalExplanationTarget,
  approvalExplanationView,
} from "@t3tools/client-runtime/state/approval-explanations";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { msg, T, useMessages } from "gt-react";
import { ShieldIcon } from "lucide-react";
import { memo, use, useId, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { ApprovalExplanationPanel } from "./ApprovalExplanationPanel";
import { ApprovalText } from "./ApprovalText";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx, type TimelineRowSharedState } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    icon: "square-pen",
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": { icon: "eye", label: msg("File read approval"), detailLabel: msg("File to read") },
  permission: {
    icon: "wrench",
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
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
  const m = useMessages();
  const explanation = approvalExplanationView(result, m);
  const canRespond = approval.responseCapability === "live";
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  return (
    <WorkLogRow
      role="group"
      aria-label={m(presentation.label)}
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
                <T>Waiting for approval</T>
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
              <T>Provider process is gone. Interrupt or restart the run to respond.</T>
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {m(FULL_ACCESS_OVERRIDE_QUESTION)}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
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
  const m = useMessages();
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  // T3 Code's own question reads as the app asking: a plain sentence, then what it names.
  const { pushHooks } = approval;
  const label = pushHooks ? PUSH_HOOKS_APPROVAL_LABEL : presentation.label;
  const canRespond = approval.responseCapability === "live";
  return (
    <WorkLogRow
      role="group"
      aria-label={m(label)}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={pushHooks ? "terminal" : presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        pushHooks ? (
          <span className="block min-w-0 text-foreground select-text! wrap-anywhere">
            {m(PUSH_HOOKS_APPROVAL_QUESTION)}
          </span>
        ) : (
          <ApprovalText
            text={approval.detail || m(presentation.label)}
            label={m(presentation.detailLabel)}
          />
        )
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {pushHooks ? <PushHooksApprovalDetails pushHooks={pushHooks} /> : null}
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
                <T>Waiting for approval</T>
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
              <T>Provider process is gone. Interrupt or restart the run to respond.</T>
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {m(FULL_ACCESS_OVERRIDE_QUESTION)}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
}
