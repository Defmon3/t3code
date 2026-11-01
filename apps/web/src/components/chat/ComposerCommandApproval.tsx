import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  approvalExplanationTarget,
  approvalExplanationView,
  approvalRejectionDraftKey,
} from "@t3tools/client-runtime/state/approval-explanations";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import { useId, useState } from "react";
import type { PendingApproval } from "../../session-logic";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { ApprovalExplanationPanel } from "./ApprovalExplanationPanel";
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
  readonly onRespondToApproval: ApprovalResponder;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const explanationAtom = approvalExplanationAtom(approvalExplanationTarget(threadRef, approval));
  const result = useAtomValue(explanationAtom);
  const refreshExplanation = useAtomRefresh(explanationAtom);
  const explanation = approvalExplanationView(result);
  return (
    <ComposerBanner.Row layout="approval-stacked" data-chat-composer-collapsed-controls="true">
      <ComposerBanner.Content render={<div />}>
        <div className="flex w-full min-w-0 flex-col gap-3">
          <ComposerPendingApprovalPanel
            approval={approval}
            pendingCount={pendingCount}
            commandExpanded={expanded}
            commandDetailId={detailId}
          />
          <ApprovalExplanationPanel
            explanation={explanation}
            waiting={result.waiting}
            onRetry={refreshExplanation}
          />
        </div>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerPendingApprovalActions
          key={approvalRejectionDraftKey(threadRef, approval)}
          requestId={approval.requestId}
          disabled={disabled}
          isResponding={isResponding}
          options={approval.options}
          canRespond={approval.responseCapability === "live"}
          supportsFeedback={approval.supportsFeedback}
          explanation={explanation}
          supportsTimedApproval={approval.supportsTimedApproval}
          onRespondToApproval={onRespondToApproval}
          commandExpansion={{ expanded, detailId, onToggle: () => setExpanded((value) => !value) }}
        />
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
