import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="micro"
        variant="ghost-muted"
        className={`${APPROVAL_ACTION_CLASS_NAME} mr-auto text-muted-foreground`}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel
      </Button>
      <Button
        size="micro"
        variant="destructive-outline"
        className={APPROVAL_ACTION_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="micro"
        variant="outline"
        className={APPROVAL_ACTION_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Allow for session
      </Button>
      <Button
        size="micro"
        variant="default"
        className={APPROVAL_ACTION_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve
      </Button>
    </>
  );
});
