import {
  EnvironmentId,
  HookApprovalRequestId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type HookApprovalRequest,
  type HookApprovalDecision,
  type HookApprovalDuration,
  type HookApprovalGrant,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createPendingHookApprovals,
  hasHookApprovalsCapability,
  hasHookApprovalGrantsCapability,
  hookApprovalGrantsForThread,
  mergePendingHookApprovals,
  findPendingHookApproval,
  hookApprovalDecisionForProviderDecision,
  hookApprovalsForThread,
  hookApprovalResponseTarget,
  scopeHookApprovalRequests,
  sortHookApprovalRequests,
} from "./hookApprovals.ts";
import { derivePendingThreadRequests, sendApprovalFeedback } from "./threadRequests.ts";
import { AsyncResult } from "effect/reactivity";

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
  it("requires explicit grant support before offering timed approval", () => {
    const requests = scopeHookApprovalRequests(environmentA, [
      request("timed", "2026-09-07T12:00:00.000Z"),
    ]);

    expect(hasHookApprovalGrantsCapability(undefined)).toBe(false);
    expect(hasHookApprovalGrantsCapability({})).toBe(false);
    expect(hasHookApprovalGrantsCapability({ hookApprovalGrants: false })).toBe(false);
    expect(hasHookApprovalGrantsCapability({ hookApprovalGrants: true })).toBe(true);
    expect(createPendingHookApprovals(requests, [])[0]?.approval.supportsTimedApproval).toBe(false);
    expect(createPendingHookApprovals(requests, [], true)[0]?.approval).toMatchObject({
      supportsTimedApproval: true,
      sessionApprovalScope: "This thread only.",
    });
    expect(createPendingHookApprovals(requests, [], true)[0]?.approval.detail).not.toContain(
      "expires when",
    );
  });

  it.each(["15-minutes", "1-hour", "session"] satisfies HookApprovalDuration[])(
    "sends %s with the remembered approval to its originating environment",
    (duration) => {
      const [pending] = scopeHookApprovalRequests(environmentB, [
        request("timed", "2026-09-07T12:00:00.000Z"),
      ]);

      expect(hookApprovalResponseTarget(pending!, "allow-session", undefined, duration)).toEqual({
        environmentId: environmentB,
        input: { requestId: "timed", decision: "allow-session", duration },
      });
      expect(hookApprovalResponseTarget(pending!, "allow", undefined, duration).input).toEqual({
        requestId: "timed",
        decision: "allow",
      });
    },
  );

  it("preserves the shown scope and keeps active grants in the selected thread", () => {
    const [pending] = createPendingHookApprovals(
      scopeHookApprovalRequests(environmentA, [
        {
          ...request("scoped", "2026-09-07T12:00:00.000Z"),
          scope: { key: "git", label: "Git commits" },
        },
      ]),
      [],
      true,
    );
    const grants: ReadonlyArray<HookApprovalGrant> = [
      {
        grantId: "grant-scoped",
        threadId: pending!.request.threadId,
        scope: { key: "git", label: "Git commits" },
        expiresAt: null,
      },
      {
        grantId: "grant-other",
        threadId: ThreadId.make("other"),
        expiresAt: DateTime.makeUnsafe("2026-09-07T12:15:00.000Z"),
      },
    ];

    expect(pending?.approval.sessionApprovalScope).toBe("Scope: Git commits");
    expect(hookApprovalGrantsForThread(grants, pending!.request.threadId)).toEqual([grants[0]]);
    expect(hookApprovalGrantsForThread(grants, null)).toEqual([]);
    expect(hookApprovalGrantsForThread([], pending!.request.threadId)).toEqual([]);
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

  it.each([
    ["deny", "  Use the staging host instead.  ", "Use the staging host instead."],
    ["deny", "   ", undefined],
    ["deny", undefined, undefined],
    ["allow", "Use the staging host instead.", undefined],
    ["allow-session", "Use the staging host instead.", undefined],
  ] satisfies ReadonlyArray<
    readonly [HookApprovalDecision, string | undefined, string | undefined]
  >)(
    "includes feedback only for a rejection with a reason: %s %s",
    (decision, feedback, expected) => {
      const [pending] = scopeHookApprovalRequests(environmentB, [
        request("remote", "2026-09-07T12:00:00.000Z"),
      ]);

      expect(hookApprovalResponseTarget(pending!, decision, feedback)).toEqual({
        environmentId: environmentB,
        input: {
          requestId: "remote",
          decision,
          ...(expected === undefined ? {} : { feedback: expected }),
        },
      });
    },
  );

  it("sends a hook rejection reason to its originating environment and request", async () => {
    const [pending] = createPendingHookApprovals(
      scopeHookApprovalRequests(environmentB, [request("remote", "2026-09-07T12:00:00.000Z")]),
      [],
    );
    let response: ReturnType<typeof hookApprovalResponseTarget> | undefined;

    const sent = await sendApprovalFeedback(
      pending!.approval,
      "  Use staging.  ",
      async (id, decision, feedback) => {
        const hook = findPendingHookApproval([pending!], id)!;
        response = hookApprovalResponseTarget(
          hook.request,
          hookApprovalDecisionForProviderDecision(decision)!,
          feedback,
        );
        return AsyncResult.success(undefined);
      },
    );

    expect(sent).toBe(true);
    expect(response).toEqual({
      environmentId: environmentB,
      input: { requestId: "remote", decision: "deny", feedback: "Use staging." },
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
      command: "command hook-request",
      cwd: "C:/workspace/hook-request",
      hookRequestId: "hook-request",
      reason: "reason hook-request",
      sessionApprovalScope: "Session scope: Git commits",
      responseCapability: "live",
      supportsFeedback: true,
      detail:
        "reason hook-request\n\nCommand:\ncommand hook-request\n\nWorking directory:\nC:/workspace/hook-request\n\nSession scope:\nGit commits",
      options: [
        { decision: "decline", label: "Reject" },
        { decision: "acceptForSession", label: "Approve for this session" },
        { decision: "accept", label: "Approve once" },
      ],
    });
    expect(second[0]!.approval.requestId).not.toBe(first[0]!.approval.requestId);
    expect(findPendingHookApproval(first, first[0]!.approval.requestId)?.request).toBe(hookRequest);
  });

  it("offers session approval without a scope and explains its lifetime", () => {
    const [hookRequest] = scopeHookApprovalRequests(environmentA, [
      { ...request("without-scope", "2026-09-07T12:00:00.000Z"), scope: undefined },
    ]);
    const [pending] = createPendingHookApprovals([hookRequest!], []);

    expect(pending!.approval.options).toEqual([
      { decision: "decline", label: "Reject" },
      { decision: "acceptForSession", label: "Approve for this session" },
      { decision: "accept", label: "Approve once" },
    ]);
    expect(pending!.approval.detail).toContain(
      "Session approval applies to unscoped custom hook requests in this provider session and expires when the provider session ends.",
    );
    expect(pending!.approval.sessionApprovalScope).toBe(
      "Session approval applies to unscoped custom hook requests in this provider session and expires when the provider session ends.",
    );
    const sessionOption = pending!.approval.options!.find(
      (option) => option.decision === "acceptForSession",
    )!;
    expect(
      hookApprovalResponseTarget(
        pending!.request,
        hookApprovalDecisionForProviderDecision(sessionOption.decision)!,
      ),
    ).toEqual({
      environmentId: environmentA,
      input: { requestId: "without-scope", decision: "allow-session" },
    });
  });

  it("maps supported decisions and rejects unsupported decisions", () => {
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
