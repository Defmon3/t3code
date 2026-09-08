import {
  type EnvironmentId,
  type HookApprovalDecision,
  type HookApprovalRequest,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface ScopedHookApprovalRequest extends HookApprovalRequest {
  readonly environmentId: EnvironmentId;
}

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

export function hookApprovalResponseErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The approval decision was not sent. Try again.";
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
