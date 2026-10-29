import {
  RuntimeRequestId,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type HookApprovalDecision,
  type HookApprovalDuration,
  type HookApprovalGrant,
  type HookApprovalRequest,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ThreadPendingApproval } from "./threadRequests.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface ScopedHookApprovalRequest extends HookApprovalRequest {
  readonly environmentId: EnvironmentId;
}

export interface PendingHookApproval {
  readonly approval: ThreadPendingApproval;
  readonly request: ScopedHookApprovalRequest;
}

export function hasHookApprovalsCapability(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "hookApprovals"> | null | undefined,
): boolean {
  return capabilities?.hookApprovals === true;
}

export function hasHookApprovalGrantsCapability(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "hookApprovalGrants"> | null | undefined,
): boolean {
  return capabilities?.hookApprovalGrants === true;
}

export function hookApprovalGrantsForThread(
  grants: ReadonlyArray<HookApprovalGrant>,
  threadId: ThreadId | null,
): ReadonlyArray<HookApprovalGrant> {
  return grants.filter((grant) => grant.threadId === threadId);
}

export const hookApprovalDurations = [
  { duration: "15-minutes", label: "15 minutes" },
  { duration: "1-hour", label: "1 hour" },
  { duration: "session", label: "This session" },
] satisfies ReadonlyArray<{
  duration: HookApprovalDuration;
  label: string;
}>;

const hookApprovalOptions = [
  { decision: "decline", label: "Reject" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "accept", label: "Approve once" },
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
): RuntimeRequestId {
  return RuntimeRequestId.make(
    `custom-hook:${collisionIndex}:${JSON.stringify([request.environmentId, request.threadId, request.requestId])}`,
  );
}

export function createPendingHookApprovals(
  requests: ReadonlyArray<ScopedHookApprovalRequest>,
  occupiedRequestIds: ReadonlyArray<RuntimeRequestId>,
  supportsTimedApproval = false,
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
    const scopeLabel = supportsTimedApproval ? "Scope" : "Session scope";
    const unscopedDescription = supportsTimedApproval
      ? "This thread only."
      : "Session approval applies to unscoped custom hook requests in this provider session and expires when the provider session ends.";

    return {
      request,
      approval: {
        requestId,
        requestKind: "command",
        createdAt: DateTime.formatIso(request.createdAt),
        appName: "Custom hook",
        command: request.command,
        cwd: request.cwd,
        hookRequestId: request.requestId,
        reason: request.reason,
        sessionApprovalScope: request.scope
          ? `${scopeLabel}: ${request.scope.label}`
          : unscopedDescription,
        responseCapability: "live",
        supportsFeedback: true,
        supportsTimedApproval,
        detail: [
          request.reason,
          `Command:\n${request.command}`,
          `Working directory:\n${request.cwd}`,
          request.scope ? `${scopeLabel}:\n${request.scope.label}` : unscopedDescription,
        ].join("\n\n"),
        options: hookApprovalOptions,
      },
    };
  });
}

export function findPendingHookApproval(
  approvals: ReadonlyArray<PendingHookApproval>,
  requestId: RuntimeRequestId,
): PendingHookApproval | null {
  return approvals.find((approval) => approval.approval.requestId === requestId) ?? null;
}

export function mergePendingHookApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
  hooks: ReadonlyArray<PendingHookApproval>,
): ReadonlyArray<ThreadPendingApproval> {
  const mirroredIds = new Set(hooks.map(({ request }) => `custom-hook:${request.requestId}`));
  return [
    ...approvals.filter((approval) => !mirroredIds.has(approval.requestId)),
    ...hooks.map(({ approval }) => approval),
  ];
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
  feedback?: string,
  duration?: HookApprovalDuration,
): {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.hookApprovalsRespond>;
} {
  return {
    environmentId: request.environmentId,
    input: {
      requestId: request.requestId,
      decision,
      ...(decision === "allow-session" && duration !== undefined ? { duration } : {}),
      ...(decision === "deny" && feedback?.trim() ? { feedback: feedback.trim() } : {}),
    },
  };
}

export function createHookApprovalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    grants: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hook-approvals:grants",
      tag: WS_METHODS.hookApprovalsSubscribeGrants,
      idleTtlMs: 0,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hook-approvals:revoke",
      tag: WS_METHODS.hookApprovalsRevokeGrant,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.grantId]),
      },
    }),
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
