import { useAtomValue } from "@effect/atom-react";
import {
  approvalExplanationTarget,
  approvalExplanationView,
  approvalJudgementLabels,
} from "@t3tools/client-runtime/state/approval-explanations";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { PendingApproval } from "../../session-logic";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { Badge } from "../ui/badge";
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
      <ComposerBanner.Content render={<div />}>
        <div className="flex w-full min-w-0 flex-col gap-3">
          <ComposerPendingApprovalPanel
            approval={approval}
            pendingCount={pendingCount}
            commandExpanded={expanded}
            commandDetailId={detailId}
          />
          <div
            className="flex w-full min-w-0 flex-col gap-2 border-t border-border pt-3 text-sm leading-relaxed"
            aria-live="polite"
          >
            <span className="font-medium">AI explanation</span>
            {explanation.status === "ready" ? (
              <>
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge
                    size="lg"
                    variant={
                      explanation.judgement.verdict === "safe"
                        ? "success"
                        : explanation.judgement.verdict === "unsafe"
                          ? "error"
                          : "warning"
                    }
                  >
                    AI judgement: {approvalJudgementLabels[explanation.judgement.verdict]}
                  </Badge>
                  <span className="min-w-0 flex-1 basis-48 whitespace-pre-wrap wrap-anywhere">
                    {explanation.judgement.reason}
                  </span>
                </span>
                <ul className="list-disc space-y-1 ps-5">
                  {explanation.operations.map((operation) => (
                    <li key={JSON.stringify(operation)} className="wrap-anywhere">
                      <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
                        <span className="font-medium">{operation.action}:</span>
                        <span className="min-w-0 flex-1 basis-48 font-mono whitespace-pre-wrap wrap-anywhere">
                          {operation.detail}
                        </span>
                        {operation.note ? (
                          <span className="whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                            {operation.note}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <span className="whitespace-pre-wrap wrap-anywhere">{explanation.message}</span>
            )}
          </div>
        </div>
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
