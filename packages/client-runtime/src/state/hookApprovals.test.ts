import {
  EnvironmentId,
  HookApprovalRequestId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type PendingApprovalDetails,
  type OrchestrationV2ThreadShell,
  type HookApprovalRequest,
  type HookApprovalDecision,
  type HookApprovalDuration,
  type HookApprovalBypass,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  createPendingHookApprovals,
  createChildApprovalAtoms,
  childApprovalResponseTarget,
  hookApprovalBypassSteps,
  hasHookApprovalsCapability,
  hasHookApprovalGrantsCapability,
  mergePendingHookApprovals,
  findPendingHookApproval,
  hookApprovalDecisionForProviderDecision,
  hookApprovalsForThread,
  hookApprovalResponseTarget,
  scopeHookApprovalRequests,
  sortHookApprovalRequests,
} from "./hookApprovals.ts";
import { derivePendingThreadRequests, sendApprovalFeedback } from "./threadRequests.ts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { approvalExplanationTarget } from "./approvalExplanations.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

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

const bypass: HookApprovalBypass = {
  rule: "Never change another session's settings without approval",
  technique: "Chaining a permitted inspection with a prohibited settings change",
  tier: 2,
  steps: [
    { command: 'Write-Output "a; b"', triggered: false },
    {
      command: 'Set-Content -LiteralPath "C:/workspace/other-session/settings.json" -Value "{}"',
      triggered: true,
    },
  ],
  reasoning: "The second command changes settings belonging to another active session.",
  runtime: "codex",
  model: "gpt-6.1-sol",
  sessionId: "0123456789abcdef0123456789abcdef0123456789abcdef",
  threadTitle: "Investigate another session's settings without changing its configuration",
  threadId: "fedcba9876543210fedcba9876543210fedcba9876543210",
};

describe("hook approvals", () => {
  it("refreshes split child approval context on shell events and keeps duplicate native ids scoped", () => {
    const parentRef = { environmentId: environmentA, threadId: v2ThreadShell.id };
    const requestId = RuntimeRequestId.make("same-native-request");
    const firstId = ThreadId.make("native-child-first");
    const secondId = ThreadId.make("native-child-second");
    const initialRevision = DateTime.formatIso(v2Now);
    const nextTime = DateTime.add(v2Now, { seconds: 1 });
    const refreshingTime = DateTime.add(nextTime, { seconds: 1 });
    const failedTime = DateTime.add(refreshingTime, { seconds: 1 });
    const child = (id: ThreadId): OrchestrationV2ThreadShell => ({
      ...v2ThreadShell,
      id,
      status: "waiting",
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: parentRef.threadId,
        relationshipToParent: "subagent",
      },
      pendingRuntimeRequest: { id: requestId, kind: "command", createdAt: v2Now },
    });
    const details = (threadId: ThreadId): NonNullable<PendingApprovalDetails> => ({
      request: {
        id: requestId,
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("approval-session"),
        },
        createdAt: v2Now,
        resolvedAt: null,
      },
      item: {
        id: TurnItemId.make(`approval-item-${threadId}`),
        threadId,
        runId: null,
        nodeId: NodeId.make("approval-node"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "running",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "Read repository status",
        command: "git status",
      },
    });
    const threads = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([
      child(firstId),
      child(secondId),
    ]);
    const connected = Atom.make(true);
    const capabilities = Atom.make({ repositoryIdentity: false, pendingApprovalDetails: true });
    const runtime = Atom.runtime(
      Layer.effect(EnvironmentRegistry, Effect.die("Unexpected approval transport")),
    );
    const approvals = createChildApprovalAtoms(runtime, {
      threadsAtom: () => threads,
      hookRequestsAtom: Atom.make([]),
      capabilitiesAtom: () => capabilities,
      connectedAtom: () => connected,
    });
    const target = (threadId: ThreadId, revision: string) => ({
      environmentId: environmentA,
      input: { threadId, requestId },
      revision,
    });
    const registry = AtomRegistry.make({
      initialValues: [
        [approvals.details(target(firstId, initialRevision)), AsyncResult.success(null)],
        [
          approvals.details(target(secondId, initialRevision)),
          AsyncResult.success(details(secondId)),
        ],
        [
          approvals.details(target(firstId, DateTime.formatIso(nextTime))),
          AsyncResult.success(details(firstId)),
        ],
        [
          approvals.details(target(firstId, DateTime.formatIso(refreshingTime))),
          AsyncResult.initial(),
        ],
        [
          approvals.details(target(firstId, DateTime.formatIso(failedTime))),
          AsyncResult.failure(Cause.die("Details could not be loaded")),
        ],
      ],
    });
    const pending = approvals.pending(parentRef);
    const unmount = registry.mount(pending);
    try {
      expect(registry.get(pending).entries.map((entry) => entry.threadRef.threadId)).toEqual([
        secondId,
      ]);

      registry.set(threads, [{ ...child(firstId), updatedAt: nextTime }, child(secondId)]);
      const visible = registry.get(pending).entries;

      expect(visible).toHaveLength(2);
      expect(new Set(visible.map((entry) => entry.key)).size).toBe(2);
      expect(
        visible.map(
          (entry) => childApprovalResponseTarget(entry, "decline", "Use staging").target.input,
        ),
      ).toEqual([
        { threadId: firstId, requestId, decision: "decline", feedback: "Use staging" },
        { threadId: secondId, requestId, decision: "decline", feedback: "Use staging" },
      ]);
      registry.set(threads, [{ ...child(firstId), updatedAt: refreshingTime }, child(secondId)]);
      expect(registry.get(pending).entries[0]).toBe(visible[0]);
      registry.set(threads, [{ ...child(firstId), updatedAt: failedTime }, child(secondId)]);
      const unavailable = registry.get(pending).entries[0]!;
      expect(unavailable.detailsUnavailable).toBe(true);
      expect(unavailable.approval.responseCapability).toBe("live");
      expect(() => childApprovalResponseTarget(unavailable, "accept")).toThrow(
        "Approval details are unavailable.",
      );
      registry.set(capabilities, { repositoryIdentity: false, pendingApprovalDetails: false });
      expect(registry.get(pending).entries).toEqual([]);
      registry.set(threads, [{ ...child(secondId), pendingRuntimeRequest: null }]);
      expect(registry.get(pending).entries).toEqual([]);
      registry.set(connected, false);
      registry.set(threads, [child(firstId)]);
      expect(registry.get(pending).entries).toEqual([]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("shows nested subagent approvals in the parent queue and explains the originating request", () => {
    const parent = v2ThreadShell.id;
    const child = ThreadId.make("approval-child");
    const nested = ThreadId.make("approval-nested");
    const unrelated = ThreadId.make("approval-unrelated");
    const childShell = (id: ThreadId, parentThreadId: ThreadId) => ({
      ...v2ThreadShell,
      id,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId,
        relationshipToParent: "subagent" as const,
      },
    });
    const shells = [childShell(nested, child), childShell(child, parent)];
    const createdAt = DateTime.formatIso(v2Now);
    const requests = scopeHookApprovalRequests(environmentA, [
      { ...request("parent", createdAt), threadId: parent },
      { ...request("child", createdAt), threadId: child },
      { ...request("nested", createdAt), threadId: nested },
      { ...request("unrelated", createdAt), threadId: unrelated },
    ]);

    const visible = hookApprovalsForThread(requests, environmentA, parent, shells);
    const approvals = createPendingHookApprovals(visible, [], true);

    expect(visible.map((pending) => pending.threadId)).toEqual([parent, child, nested]);
    expect(
      approvalExplanationTarget(
        { environmentId: environmentA, threadId: parent },
        approvals[2]!.approval,
      ).input,
    ).toMatchObject({ threadId: nested, source: "hook", requestId: "nested" });
    expect(
      hookApprovalResponseTarget(approvals[2]!.request, "allow-session", undefined, "15-minutes"),
    ).toMatchObject({
      environmentId: environmentA,
      input: { requestId: "nested", duration: "15-minutes" },
    });
    expect(hookApprovalsForThread(requests, environmentB, parent, shells)).toEqual([]);
    expect(
      hookApprovalsForThread(requests, environmentA, parent, []).map((pending) => pending.threadId),
    ).toEqual([parent]);
    expect(hookApprovalsForThread([], environmentA, parent, shells)).toEqual([]);
    expect(
      hookApprovalsForThread(requests, environmentA, parent, [
        childShell(nested, child),
        { ...childShell(child, parent), deletedAt: v2Now },
      ]).map((pending) => pending.threadId),
    ).toEqual([parent]);
  });

  it("keeps repeated bypass command steps distinct", () => {
    const steps = hookApprovalBypassSteps({
      ...bypass,
      steps: [
        { command: "git status;", triggered: false },
        { command: "git status;", triggered: true },
        { command: "git status;", triggered: false },
      ],
    });

    expect(new Set(steps.map((step) => step.key)).size).toBe(3);
    expect(steps.map((step) => step.triggered)).toEqual([false, true, false]);
  });

  it.each([false, true])(
    "preserves bypass steps and offers only one-shot decisions with timed capability %s",
    (supportsTimedApproval) => {
      const [pending] = createPendingHookApprovals(
        scopeHookApprovalRequests(environmentA, [
          { ...request("bypass", "2026-09-07T12:00:00.000Z"), bypass },
        ]),
        [],
        supportsTimedApproval,
      );

      expect(pending?.approval.bypass).toEqual(bypass);
      expect(pending?.approval.options).toEqual([
        { decision: "decline", label: "Reject" },
        { decision: "accept", label: "Approve once" },
      ]);
      expect(pending?.approval.supportsTimedApproval).toBe(false);
      expect(pending?.approval.sessionApprovalScope).toBeUndefined();
      expect(pending?.approval.detail).toContain(bypass.rule);
      expect(pending?.approval.detail).toContain(bypass.reasoning);
      expect(pending?.approval.detail).not.toContain("Session approval");
    },
  );

  it.each([
    ["allow-session", undefined],
    ["allow-session", "session"],
    ["allow", "15-minutes"],
    ["deny", "1-hour"],
  ] satisfies ReadonlyArray<readonly [HookApprovalDecision, HookApprovalDuration | undefined]>)(
    "rejects remembered bypass decisions: %s %s",
    (decision, duration) => {
      const [pending] = scopeHookApprovalRequests(environmentA, [
        { ...request("bypass", "2026-09-07T12:00:00.000Z"), bypass },
      ]);

      expect(() => hookApprovalResponseTarget(pending!, decision, undefined, duration)).toThrow(
        "Bypass attempts allow only a one-shot approval or rejection.",
      );
    },
  );

  it.each(["allow", "deny"] satisfies HookApprovalDecision[])(
    "routes a one-shot bypass %s to its originating environment",
    (decision) => {
      const [pending] = scopeHookApprovalRequests(environmentB, [
        { ...request("bypass", "2026-09-07T12:00:00.000Z"), bypass },
      ]);

      expect(hookApprovalResponseTarget(pending!, decision)).toEqual({
        environmentId: environmentB,
        input: { requestId: "bypass", decision },
      });
    },
  );

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

  it("preserves the shown scope for timed approval", () => {
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
    expect(pending?.approval.sessionApprovalScope).toBe("Scope: Git commits");
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
