import { useAtomValue } from "@effect/atom-react";
import {
  hookApprovalResponseTarget,
  hookApprovalResponseErrorMessage,
  type ScopedHookApprovalRequest,
} from "@t3tools/client-runtime/state/hook-approvals";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { useEnvironments } from "../state/environments";
import { hookApprovalEnvironment, pendingHookApprovalRequestsAtom } from "../state/hookApprovals";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { AppText } from "./AppText";

export function HookApprovalDialogHost() {
  const { height } = useWindowDimensions();
  const requests = useAtomValue(pendingHookApprovalRequestsAtom);
  const { environments } = useEnvironments();
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const respond = useAtomCommand(hookApprovalEnvironment.respond, { reportFailure: false });
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = requests[0] ?? null;
  const environmentLabel =
    request === null
      ? null
      : (environments.find((environment) => environment.environmentId === request.environmentId)
          ?.label ?? request.environmentId);
  const threadLabel =
    request === null
      ? null
      : (threads.find(
          (thread) =>
            thread.environmentId === request.environmentId && thread.id === request.threadId,
        )?.title ?? request.threadId);
  const respondToRequest = useCallback(
    async (
      activeRequest: ScopedHookApprovalRequest,
      decision: "allow" | "allow-session" | "deny",
    ) => {
      if (respondingRequestId !== null) return;
      setError(null);
      setRespondingRequestId(activeRequest.requestId);
      const result = await respond(hookApprovalResponseTarget(activeRequest, decision));
      if (result._tag === "Failure") {
        setError(hookApprovalResponseErrorMessage(squashAtomCommandFailure(result)));
      }
      setRespondingRequestId(null);
    },
    [respond, respondingRequestId],
  );
  const responding = request !== null && respondingRequestId === request.requestId;

  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        if (request !== null) void respondToRequest(request, "deny");
      }}
    >
      {request === null ? null : (
        <View className="flex-1 items-center justify-center bg-backdrop px-6">
          <View className="w-full rounded-[24px] bg-card" style={{ maxHeight: height - 48 }}>
            <ScrollView className="min-h-0 shrink" contentContainerClassName="gap-3 px-6 pt-5">
              <AppText className="text-lg font-t3-medium">Approval required</AppText>
              <AppText className="text-sm text-foreground-secondary">{request.reason}</AppText>
              <AppText className="text-xs text-foreground-secondary">Command</AppText>
              <AppText className="rounded-md bg-subtle p-3 font-mono text-sm">
                {request.command}
              </AppText>
              <AppText className="text-sm">Environment: {environmentLabel}</AppText>
              <AppText className="text-sm">Thread: {threadLabel}</AppText>
              <AppText className="text-sm">Working directory: {request.cwd}</AppText>
              {request.scope ? (
                <AppText className="text-sm">Session scope: {request.scope.label}</AppText>
              ) : null}
              {requests.length > 1 ? (
                <AppText className="text-sm text-foreground-secondary">{`1/${requests.length} approvals waiting`}</AppText>
              ) : null}
              {error ? <AppText className="text-sm text-danger-foreground">{error}</AppText> : null}
              {request.scope === undefined ? (
                <AppText className="text-sm text-foreground-secondary">
                  Allow for this session is unavailable because this hook did not provide a session
                  scope.
                </AppText>
              ) : null}
            </ScrollView>
            <View className="gap-2 px-6 pb-5 pt-3">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: responding }}
                className="min-h-11 items-center justify-center rounded-full bg-primary px-4 disabled:opacity-50"
                disabled={responding}
                onPress={() => void respondToRequest(request, "allow")}
              >
                <AppText className="font-t3-medium text-primary-foreground">Allow</AppText>
              </Pressable>
              <Pressable
                accessibilityHint={
                  request.scope === undefined
                    ? "This hook does not offer a session scope."
                    : undefined
                }
                accessibilityRole="button"
                accessibilityState={{ disabled: responding || request.scope === undefined }}
                className="min-h-11 items-center justify-center rounded-full bg-subtle-strong px-4 disabled:opacity-50"
                disabled={responding || request.scope === undefined}
                onPress={() => void respondToRequest(request, "allow-session")}
              >
                <AppText className="font-t3-medium">Allow for this session</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: responding }}
                className="min-h-11 items-center justify-center rounded-full bg-danger px-4 disabled:opacity-50"
                disabled={responding}
                onPress={() => void respondToRequest(request, "deny")}
              >
                <AppText className="font-t3-medium text-danger-foreground">Deny</AppText>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}
