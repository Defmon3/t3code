import {
  EnvironmentId,
  HookApprovalRequestId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type HookApprovalRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import {
  createPendingHookApprovals,
  hasHookApprovalsCapability,
  mergePendingHookApprovals,
  findPendingHookApproval,
  hookApprovalDecisionForProviderDecision,
  hookApprovalsForThread,
  hookApprovalResponseTarget,
  scopeHookApprovalRequests,
  sortHookApprovalRequests,
} from "./hookApprovals.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function request(requestId: string, createdAt: string): HookApprovalRequest {
  return {
    requestId: HookApprovalRequestId.make(requestId),
    threadId: ThreadId.make(`thread-${requestId}`),
    command: `command ${requestId}`,
    reason: `reason ${requestId}`,
    cwd: `C:/workspace/${requestId}`,
    createdAt: DateTime.makeUnsafe(createdAt),
  };
}

describe("hook approvals", () => {
  it("replaces a mirrored generic request with one rich card and the hook response target", () => {
    const hookRequest = scopeHookApprovalRequests(environmentA, [
      request("mirrored", "2026-09-07T12:00:00.000Z"),
    ])[0]!;
    const native = derivePendingThreadRequests({
      turnItems: [],
      runtimeRequests: [
        {
          id: RuntimeRequestId.make("custom-hook:mirrored"),
          nodeId: NodeId.make("hook-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("hook-session"),
          },
          createdAt: hookRequest.createdAt,
          resolvedAt: null,
        },
      ],
    });
    const hooks = createPendingHookApprovals(
      [hookRequest],
      native.approvals.map((approval) => approval.requestId),
    );

    const visible = mergePendingHookApprovals(native.approvals, hooks);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.detail).toContain("reason mirrored");
    expect(visible[0]?.detail).toContain("command mirrored");
    expect(
      hookApprovalResponseTarget(
        findPendingHookApproval(hooks, visible[0]!.requestId)!.request,
        "allow",
      ).input,
    ).toEqual({ requestId: "mirrored", decision: "allow" });
  });
  it("subscribes only to explicitly supported environments", () => {
    expect(hasHookApprovalsCapability(undefined)).toBe(false);
    expect(hasHookApprovalsCapability({})).toBe(false);
    expect(hasHookApprovalsCapability({ hookApprovals: false })).toBe(false);
    expect(hasHookApprovalsCapability({ hookApprovals: true })).toBe(true);
  });
  it("orders snapshots from two environments and removes a resolved request", () => {
    const firstSnapshot = sortHookApprovalRequests([
      ...scopeHookApprovalRequests(environmentA, [request("later", "2026-09-07T12:00:01.000Z")]),
      ...scopeHookApprovalRequests(environmentB, [request("first", "2026-09-07T12:00:00.000Z")]),
    ]);
    const afterResolution = sortHookApprovalRequests([
      ...scopeHookApprovalRequests(environmentA, [request("later", "2026-09-07T12:00:01.000Z")]),
      ...scopeHookApprovalRequests(environmentB, []),
    ]);

    expect(firstSnapshot.map((item) => [item.environmentId, item.requestId])).toEqual([
      [environmentB, "first"],
      [environmentA, "later"],
    ]);
    expect(afterResolution.map((item) => item.requestId)).toEqual(["later"]);
  });

  it("routes a decision to the environment that emitted the request", () => {
    const [pending] = scopeHookApprovalRequests(environmentB, [
      request("remote", "2026-09-07T12:00:00.000Z"),
    ]);

    expect(hookApprovalResponseTarget(pending!, "allow-session")).toEqual({
      environmentId: environmentB,
      input: { requestId: "remote", decision: "allow-session" },
    });
  });

  it("maps hook approvals to collision-safe composer approvals", () => {
    const [hookRequest] = scopeHookApprovalRequests(environmentA, [
      {
        ...request("hook-request", "2026-09-07T12:00:00.000Z"),
        scope: { key: "git", label: "Git commits" },
      },
    ]);
    const first = createPendingHookApprovals([hookRequest!], []);
    const second = createPendingHookApprovals([hookRequest!], [first[0]!.approval.requestId]);

    expect(first[0]!.approval).toMatchObject({
      requestKind: "command",
      appName: "Custom hook",
      responseCapability: "live",
      detail:
        "reason hook-request\n\nCommand:\ncommand hook-request\n\nWorking directory:\nC:/workspace/hook-request\n\nSession scope:\nGit commits",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "accept", label: "Allow" },
      ],
    });
    expect(second[0]!.approval.requestId).not.toBe(first[0]!.approval.requestId);
    expect(findPendingHookApproval(first, first[0]!.approval.requestId)?.request).toBe(hookRequest);
  });

  it("omits session allowance without a scope and rejects unsupported decisions", () => {
    const [hookRequest] = scopeHookApprovalRequests(environmentA, [
      { ...request("without-scope", "2026-09-07T12:00:00.000Z"), scope: undefined },
    ]);
    const [pending] = createPendingHookApprovals([hookRequest!], []);

    expect(pending!.approval.options?.map((option) => option.decision)).toEqual([
      "decline",
      "accept",
    ]);
    expect(hookApprovalDecisionForProviderDecision("accept")).toBe("allow");
    expect(hookApprovalDecisionForProviderDecision("acceptForSession")).toBe("allow-session");
    expect(hookApprovalDecisionForProviderDecision("decline")).toBe("deny");
    expect(hookApprovalDecisionForProviderDecision("cancel")).toBeNull();
  });

  it("keeps hook approvals in their environment and thread", () => {
    const requests = [
      ...scopeHookApprovalRequests(environmentA, [request("first", "2026-09-07T12:00:00.000Z")]),
      ...scopeHookApprovalRequests(environmentB, [request("second", "2026-09-07T12:00:01.000Z")]),
    ];

    expect(hookApprovalsForThread(requests, environmentA, ThreadId.make("thread-first"))).toEqual([
      requests[0],
    ]);
    expect(hookApprovalsForThread(requests, environmentA, ThreadId.make("thread-second"))).toEqual(
      [],
    );
  });
});
