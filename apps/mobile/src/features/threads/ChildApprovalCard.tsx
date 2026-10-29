import { useAtomValue } from "@effect/atom-react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  childApprovalResponseTarget,
  type ChildPendingApproval,
} from "@t3tools/client-runtime/state/hook-approvals";
import { type ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { appAtomRegistry } from "../../state/atom-registry";
import { childApprovals, hookApprovalEnvironment, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PendingApprovalCard } from "./PendingApprovalCard";

export function ChildApprovalCard({
  threadRef,
  canOperateThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly canOperateThread: boolean;
}) {
  const { entries, failed } = useAtomValue(childApprovals.pending(threadRef));
  const entry = entries[0];
  if (!entry && failed.length === 0) return null;
  return (
    <View className="gap-2 px-4 pb-3">
      {entry ? (
        <ChildApproval key={entry.key} entry={entry} canOperateThread={canOperateThread} />
      ) : null}
      {failed.length > 0 ? (
        <>
          <Text>Could not load subagent approval.</Text>
          <Button
            label="Retry"
            onPress={() => {
              for (const target of failed)
                appAtomRegistry.refresh(
                  childApprovals.details({
                    environmentId: target.threadRef.environmentId,
                    input: { threadId: target.threadRef.threadId, requestId: target.requestId },
                    revision: target.revision,
                  }),
                );
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function ChildApproval({
  entry,
  canOperateThread,
}: {
  readonly entry: ChildPendingApproval;
  readonly canOperateThread: boolean;
}) {
  const native = useAtomCommand(threadEnvironment.respondToApproval);
  const hook = useAtomCommand(hookApprovalEnvironment.respond);
  const [responding, setResponding] = useState(false);
  const [failed, setFailed] = useState(false);
  const respond: ApprovalResponder = async (requestId, decision, feedback, duration) => {
    if (
      !canOperateThread ||
      entry.detailsUnavailable ||
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
      <Text className="font-t3-bold text-sm text-foreground">{entry.title}</Text>
      <PendingApprovalCard
        approval={entry.approval}
        threadRef={entry.threadRef}
        canOperateThread={canOperateThread}
        disabled={entry.detailsUnavailable === true}
        respondingApprovalId={responding ? entry.approval.requestId : null}
        onRespond={respond}
      />
      {failed ? <Text accessibilityRole="alert">Approval response failed. Try again.</Text> : null}
    </>
  );
}
