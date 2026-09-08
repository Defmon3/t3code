import { useAtomValue } from "@effect/atom-react";
import {
  hookApprovalResponseTarget,
  hookApprovalResponseErrorMessage,
  type ScopedHookApprovalRequest,
} from "@t3tools/client-runtime/state/hook-approvals";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { useEnvironments } from "../state/environments";
import { hookApprovalEnvironment, pendingHookApprovalRequestsAtom } from "../state/hookApprovals";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

export function HookApprovalDialogHost() {
  const requests = useAtomValue(pendingHookApprovalRequestsAtom);
  const { environments } = useEnvironments();
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const respond = useAtomCommand(hookApprovalEnvironment.respond, { reportFailure: false });
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
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
      setRespondingRequestId(activeRequest.requestId);
      const result = await respond(hookApprovalResponseTarget(activeRequest, decision));
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Approval response failed",
          description: hookApprovalResponseErrorMessage(squashAtomCommandFailure(result)),
        });
      }
      setRespondingRequestId(null);
    },
    [respond, respondingRequestId],
  );
  const responding = request !== null && respondingRequestId === request.requestId;

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && request !== null) void respondToRequest(request, "deny");
      }}
    >
      {request === null ? null : (
        <AlertDialogPopup
          className="flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col"
          bottomStickOnMobile={false}
        >
          <AlertDialogHeader className="min-h-0 overflow-y-auto">
            <AlertDialogTitle>Approval required</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {request.reason}
            </AlertDialogDescription>
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Command</dt>
                <dd className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-foreground whitespace-pre-wrap">
                  {request.command}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Environment</dt>
                <dd>{environmentLabel}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Thread</dt>
                <dd>{threadLabel}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Working directory</dt>
                <dd className="break-all font-mono">{request.cwd}</dd>
              </div>
              {request.scope ? (
                <div>
                  <dt className="text-muted-foreground">Session scope</dt>
                  <dd>{request.scope.label}</dd>
                </div>
              ) : null}
            </dl>
            {requests.length > 1 ? (
              <AlertDialogDescription>{`1/${requests.length} approvals waiting`}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              disabled={responding}
              variant="destructive"
              onClick={() => void respondToRequest(request, "deny")}
            >
              Deny
            </Button>
            <Button
              disabled={responding || request.scope === undefined}
              title={
                request.scope === undefined
                  ? "This hook does not offer a session scope."
                  : undefined
              }
              variant="outline"
              onClick={() => void respondToRequest(request, "allow-session")}
            >
              Allow for this session
            </Button>
            <Button disabled={responding} onClick={() => void respondToRequest(request, "allow")}>
              Allow
            </Button>
          </AlertDialogFooter>
          {request.scope === undefined ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              Allow for this session is unavailable because this hook did not provide a session
              scope.
            </p>
          ) : null}
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}
