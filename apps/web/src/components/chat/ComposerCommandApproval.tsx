import { useAtomValue } from "@effect/atom-react";
import {
  approvalExplanationTarget,
  approvalExplanationView,
} from "@t3tools/client-runtime/state/approval-explanations";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { PendingApproval } from "../../session-logic";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

export function ComposerCommandApproval({
  approval,
  pendingCount,
  threadRef,
  disabled,
  isResponding,
  onRespondToApproval,
}: {
  readonly approval: PendingApproval;
  readonly pendingCount: number;
  readonly threadRef: ScopedThreadRef;
  readonly disabled: boolean;
  readonly isResponding: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const result = useAtomValue(
    approvalExplanationAtom(approvalExplanationTarget(threadRef, approval)),
  );
  const explanation = approvalExplanationView(result);
  return (
    <ComposerBanner.Row layout="approval-stacked" data-chat-composer-collapsed-controls="true">
      <ComposerBanner.Content>
        <span className="flex w-full min-w-0 flex-col gap-3">
          <ComposerPendingApprovalPanel
            approval={approval}
            pendingCount={pendingCount}
            commandExpanded={expanded}
            commandDetailId={detailId}
          />
          <span
            className="flex w-full min-w-0 flex-col gap-2 border-t border-border pt-3 text-sm leading-relaxed"
            aria-live="polite"
          >
            <span className="font-medium">AI explanation</span>
            <span className="whitespace-pre-wrap wrap-anywhere">
              {explanation.status === "ready" ? explanation.explanation : explanation.message}
            </span>
            {explanation.status === "ready" && explanation.risk ? (
              <span className="rounded-md border border-warning/40 bg-warning-surface p-2 text-warning-foreground whitespace-pre-wrap wrap-anywhere">
                {explanation.risk}
              </span>
            ) : null}
          </span>
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          disabled={disabled}
          isResponding={isResponding}
          options={approval.options}
          canRespond={approval.responseCapability === "live"}
          onRespondToApproval={onRespondToApproval}
          commandExpansion={{ expanded, detailId, onToggle: () => setExpanded((value) => !value) }}
        />
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
