import {
  ApprovalRequestId,
  type EnvironmentId,
  type HookApprovalDecision,
  type HookApprovalRequest,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { PendingApproval } from "../pendingRequests.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface ScopedHookApprovalRequest extends HookApprovalRequest {
  readonly environmentId: EnvironmentId;
}

export interface PendingHookApproval {
  readonly approval: PendingApproval;
  readonly request: ScopedHookApprovalRequest;
}

const hookApprovalOptions = [
  { decision: "decline", label: "Deny" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "accept", label: "Allow" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export function scopeHookApprovalRequests(
  environmentId: EnvironmentId,
  requests: ReadonlyArray<HookApprovalRequest>,
): ReadonlyArray<ScopedHookApprovalRequest> {
  return requests.map((request) => ({ ...request, environmentId }));
}

export function sortHookApprovalRequests(
  requests: ReadonlyArray<ScopedHookApprovalRequest>,
): ReadonlyArray<ScopedHookApprovalRequest> {
  return [...requests].sort(
    (left, right) =>
      DateTime.formatIso(left.createdAt).localeCompare(DateTime.formatIso(right.createdAt)) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.requestId.localeCompare(right.requestId),
  );
}

export function hookApprovalsForThread(
  requests: ReadonlyArray<ScopedHookApprovalRequest>,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<ScopedHookApprovalRequest> {
  return requests.filter(
    (request) => request.environmentId === environmentId && request.threadId === threadId,
  );
}

function hookApprovalPendingRequestId(
  request: ScopedHookApprovalRequest,
  collisionIndex: number,
): ApprovalRequestId {
  return ApprovalRequestId.make(
    `custom-hook:${collisionIndex}:${JSON.stringify([request.environmentId, request.threadId, request.requestId])}`,
  );
}

export function createPendingHookApprovals(
  requests: ReadonlyArray<ScopedHookApprovalRequest>,
  occupiedRequestIds: ReadonlyArray<ApprovalRequestId>,
): ReadonlyArray<PendingHookApproval> {
  const occupied = new Set(occupiedRequestIds);

  return requests.map((request) => {
    let collisionIndex = 0;
    let requestId = hookApprovalPendingRequestId(request, collisionIndex);
    while (occupied.has(requestId)) {
      collisionIndex += 1;
      requestId = hookApprovalPendingRequestId(request, collisionIndex);
    }
    occupied.add(requestId);

    return {
      request,
      approval: {
        requestId,
        requestKind: "command",
        createdAt: DateTime.formatIso(request.createdAt),
        appName: "Custom hook",
        detail: [
          request.reason,
          `Command:\n${request.command}`,
          `Working directory:\n${request.cwd}`,
          ...(request.scope ? [`Session scope:\n${request.scope.label}`] : []),
        ].join("\n\n"),
        options:
          request.scope === undefined
            ? hookApprovalOptions.filter((option) => option.decision !== "acceptForSession")
            : hookApprovalOptions,
      },
    };
  });
}

export function findPendingHookApproval(
  approvals: ReadonlyArray<PendingHookApproval>,
  requestId: ApprovalRequestId,
): PendingHookApproval | null {
  return approvals.find((approval) => approval.approval.requestId === requestId) ?? null;
}

export function hookApprovalDecisionForProviderDecision(
  decision: ProviderApprovalDecision,
): HookApprovalDecision | null {
  switch (decision) {
    case "accept":
      return "allow";
    case "acceptForSession":
      return "allow-session";
    case "decline":
      return "deny";
    default:
      return null;
  }
}

export function hookApprovalResponseTarget(
  request: ScopedHookApprovalRequest,
  decision: HookApprovalDecision,
): {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.hookApprovalsRespond>;
} {
  return {
    environmentId: request.environmentId,
    input: { requestId: request.requestId, decision },
  };
}

export function createHookApprovalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    requests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hook-approvals:requests",
      tag: WS_METHODS.hookApprovalsSubscribe,
      idleTtlMs: 0,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hook-approvals:respond",
      tag: WS_METHODS.hookApprovalsRespond,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.requestId]),
      },
    }),
  };
}
