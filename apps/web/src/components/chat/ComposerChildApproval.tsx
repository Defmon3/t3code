import { useAtomValue } from "@effect/atom-react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  childApprovalResponseTarget,
  type ChildPendingApproval,
} from "@t3tools/client-runtime/state/hook-approvals";
import { type ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { ShieldIcon } from "lucide-react";
import { childApprovals } from "../../state/childApprovals";
import { hookApprovalEnvironment } from "../../state/hookApprovals";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerCommandApproval } from "./ComposerCommandApproval";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

export function ComposerChildApproval({
  threadRef,
  disabled,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly disabled: boolean;
}) {
  const { entries, failed } = useAtomValue(childApprovals.pending(threadRef));
  const entry = entries[0];
  if (!entry && failed.length === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        variant={entry?.approval.bypass ? "error" : "warning"}
        density="spacious"
      >
        {entry ? (
          <ChildApproval
            key={entry.key}
            entry={entry}
            pendingCount={entries.length}
            disabled={disabled}
          />
        ) : null}
        {failed.length > 0 ? (
          <ComposerBanner.Row>
            <ComposerBanner.Content>Could not load subagent approval.</ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  for (const target of failed)
                    appAtomRegistry.refresh(
                      childApprovals.details({
                        environmentId: target.threadRef.environmentId,
                        input: { threadId: target.threadRef.threadId, requestId: target.requestId },
                        revision: target.revision,
                      }),
                    );
                }}
              >
                Retry
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function ChildApproval({
  entry,
  pendingCount,
  disabled: connectionDisabled,
}: {
  readonly entry: ChildPendingApproval;
  readonly pendingCount: number;
  readonly disabled: boolean;
}) {
  const disabled = connectionDisabled || entry.detailsUnavailable === true;
  const native = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const hook = useAtomCommand(hookApprovalEnvironment.respond);
  const [responding, setResponding] = useState(false);
  const [failed, setFailed] = useState(false);
  const respond: ApprovalResponder = async (requestId, decision, feedback, duration) => {
    if (
      disabled ||
      responding ||
      requestId !== entry.approval.requestId ||
      entry.approval.responseCapability !== "live"
    )
      return;
    setResponding(true);
    try {
      const response = childApprovalResponseTarget(entry, decision, feedback, duration);
      const result =
        response.source === "hook" ? await hook(response.target) : await native(response.target);
      setFailed(result._tag === "Failure");
      return result;
    } finally {
      setResponding(false);
    }
  };
  return (
    <>
      <ComposerBanner.Row>
        <ComposerBanner.Content>{entry.title}</ComposerBanner.Content>
      </ComposerBanner.Row>
      {entry.approval.requestKind === "command" ? (
        <ComposerCommandApproval
          approval={entry.approval}
          pendingCount={pendingCount}
          threadRef={entry.threadRef}
          disabled={disabled}
          isResponding={responding}
          onRespondToApproval={respond}
        />
      ) : (
        <ComposerBanner.Row layout="approval">
          <ComposerBanner.Icon>
            <ShieldIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <ComposerPendingApprovalPanel approval={entry.approval} pendingCount={pendingCount} />
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerPendingApprovalActions
              requestId={entry.approval.requestId}
              disabled={disabled}
              isResponding={responding}
              canRespond={entry.approval.responseCapability === "live"}
              options={entry.approval.options}
              supportsFeedback={entry.approval.supportsFeedback}
              supportsTimedApproval={entry.approval.supportsTimedApproval}
              onRespondToApproval={respond}
            />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      )}
      {failed ? (
        <ComposerBanner.Row>
          <ComposerBanner.Content>
            <span role="alert">Approval response failed. Try again.</span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      ) : null}
    </>
  );
}
