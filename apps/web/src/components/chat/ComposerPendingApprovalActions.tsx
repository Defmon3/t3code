import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;
export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
      {options.map((option) => (
        <Button
          key={option.decision}
          size="micro"
          variant={
            option.decision === "decline"
              ? "destructive-outline"
              : option.decision === "accept"
                ? "default"
                : option.decision === "cancel"
                  ? "ghost-muted"
                  : "outline"
          }
          className={`${option.decision === "cancel" ? "mr-auto " : ""}font-normal`}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          <span className="max-w-40 truncate">{option.label}</span>
        </Button>
      ))}
    </div>
  );
});
