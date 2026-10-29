import { useAtomValue } from "@effect/atom-react";
import {
  hasHookApprovalGrantsCapability,
  hookApprovalGrantsForThread,
} from "@t3tools/client-runtime/state/hook-approvals";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { HookApprovalGrant, ScopedThreadRef } from "@t3tools/contracts";
import { formatDateTimeShort } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { hookApprovalEnvironment } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function HookApprovalGrants({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const supported = hasHookApprovalGrantsCapability(config?.environment.capabilities);
  const query = useEnvironmentQuery(
    supported
      ? hookApprovalEnvironment.grants({ environmentId: threadRef.environmentId, input: {} })
      : null,
  );
  const grants = hookApprovalGrantsForThread(query.data ?? [], threadRef.threadId);
  if (!supported || (!query.error && !query.isPending && grants.length === 0)) return null;
  return (
    <ScrollView className="max-h-48 shrink-0 px-4 pb-3" nestedScrollEnabled>
      <View className="gap-2">
        {query.error ? (
          <View className="gap-2">
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              Could not load custom hook approvals. {query.error}
            </Text>
            <Button
              label="Retry"
              tone="secondary"
              disabled={query.isPending}
              onPress={query.refresh}
            />
          </View>
        ) : null}
        {query.isPending && query.data === null ? (
          <Text className="text-sm text-foreground-secondary">Loading custom hook approvals…</Text>
        ) : null}
        {grants.map((grant) => (
          <HookApprovalGrantRow
            key={JSON.stringify([threadRef.environmentId, grant.grantId])}
            threadRef={threadRef}
            grant={grant}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function HookApprovalGrantRow({
  threadRef,
  grant,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly grant: HookApprovalGrant;
}) {
  const canRevoke = useAtomValue(
    hookApprovalEnvironment.revoke.permissionAtom(threadRef.environmentId),
  );
  const revoke = useAtomCommand(hookApprovalEnvironment.revoke, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function revokeGrant() {
    if (!canRevoke || pending) return;
    setPending(true);
    const result = await revoke({
      environmentId: threadRef.environmentId,
      input: { grantId: grant.grantId },
    });
    setFailed(result._tag === "Failure" && !isAtomCommandInterrupted(result));
    setPending(false);
  }
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text className="min-w-0 flex-1 text-sm text-foreground">
        {grant.expiresAt === null
          ? "Approved for this session"
          : `Approved until ${formatDateTimeShort(DateTime.formatIso(grant.expiresAt))}`}
        {grant.scope ? ` · ${grant.scope.label}` : null}
      </Text>
      {failed ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          Could not revoke approval. Try again.
        </Text>
      ) : null}
      <Button
        label="Revoke"
        tone="secondary"
        disabled={!canRevoke || pending}
        loading={pending}
        accessibilityHint={!canRevoke ? "This connection cannot revoke approvals." : undefined}
        onPress={() => void revokeGrant()}
      />
    </View>
  );
}
