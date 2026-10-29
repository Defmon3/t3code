import { useAtomValue } from "@effect/atom-react";
import {
  hasHookApprovalGrantsCapability,
  hookApprovalGrantsForThread,
} from "@t3tools/client-runtime/state/hook-approvals";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { HookApprovalGrant, ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { hookApprovalEnvironment } from "../../state/hookApprovals";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

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
    <ComposerBanner.Attachment>
      <ComposerBanner.Root>
        <ComposerBanner.Scroll>
          <ComposerBanner.Children>
            {query.error ? (
              <ComposerBanner.Row layout="wrap-actions">
                <ComposerBanner.Content role="alert">
                  Could not load custom hook approvals. {query.error}
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={query.refresh}
                    disabled={query.isPending}
                  >
                    Retry
                  </Button>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ) : null}
            {query.isPending && query.data === null ? (
              <ComposerBanner.Row>
                <ComposerBanner.Content>Loading custom hook approvals…</ComposerBanner.Content>
              </ComposerBanner.Row>
            ) : null}
            {grants.map((grant) => (
              <HookApprovalGrantRow
                key={JSON.stringify([threadRef.environmentId, grant.grantId])}
                threadRef={threadRef}
                grant={grant}
              />
            ))}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function HookApprovalGrantRow({
  threadRef,
  grant,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly grant: HookApprovalGrant;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
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
    <ComposerBanner.Row layout="wrap-actions">
      <ComposerBanner.Content render={<div />}>
        <span className="min-w-0 whitespace-normal wrap-anywhere">
          {grant.expiresAt === null
            ? "Approved for this session"
            : `Approved until ${formatUpcomingTimestamp(DateTime.formatIso(grant.expiresAt), timestampFormat)}`}
          {grant.scope ? ` · ${grant.scope.label}` : null}
          {failed ? (
            <span role="alert" className="block text-destructive">
              Could not revoke approval. Try again.
            </span>
          ) : null}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <Button
          size="xs"
          variant="outline"
          disabled={!canRevoke || pending}
          aria-description={!canRevoke ? "This connection cannot revoke approvals." : undefined}
          onClick={() => void revokeGrant()}
        >
          {pending ? "Revoking…" : "Revoke"}
        </Button>
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
