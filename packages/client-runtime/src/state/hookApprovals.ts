import {
  RuntimeRequestId,
  EnvironmentId,
  PendingApprovalDetailsInput,
  type ExecutionEnvironmentCapabilities,
  type HookApprovalBypass,
  type HookApprovalDecision,
  type HookApprovalDuration,
  type HookApprovalRequest,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ThreadId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { derivePendingThreadRequests, type ThreadPendingApproval } from "./threadRequests.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const decodePendingApprovalTarget = Schema.decodeUnknownSync(
  Schema.Struct({
    environmentId: EnvironmentId,
    input: PendingApprovalDetailsInput,
  }),
);

export interface ScopedHookApprovalRequest extends HookApprovalRequest {
  readonly environmentId: EnvironmentId;
}

export interface ChildPendingApproval {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly approval: ThreadPendingApproval;
  readonly hookRequest?: ScopedHookApprovalRequest;
  readonly detailsUnavailable?: boolean;
}

function subagentThreadIds(
  threadId: ThreadId | null,
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "deletedAt">>,
) {
  const visible = new Set<ThreadId | null>([threadId]);
  for (const id of visible) {
    if (id === null) continue;
    for (const thread of threads) {
      if (
        thread.deletedAt === null &&
        thread.lineage.relationshipToParent === "subagent" &&
        thread.lineage.parentThreadId === id
      )
        visible.add(thread.id);
    }
  }
  return visible;
}

export function childApprovalResponseTarget(
  entry: ChildPendingApproval,
  decision: ProviderApprovalDecision,
  feedback?: string,
  duration?: HookApprovalDuration,
) {
  if (entry.detailsUnavailable) throw new RangeError("Approval details are unavailable.");
  if (entry.approval.responseCapability !== "live")
    throw new RangeError("This approval can no longer be answered.");
  if (entry.hookRequest) {
    const hookDecision = hookApprovalDecisionForProviderDecision(decision);
    if (hookDecision === null) throw new RangeError("Unsupported custom hook approval decision.");
    return {
      source: "hook" as const,
      target: hookApprovalResponseTarget(entry.hookRequest, hookDecision, feedback, duration),
    };
  }
  if (duration !== undefined)
    throw new RangeError("Timed approvals require a custom hook request.");
  return {
    source: "native" as const,
    target: {
      environmentId: entry.threadRef.environmentId,
      input: {
        threadId: entry.threadRef.threadId,
        requestId: entry.approval.requestId,
        decision,
        ...(feedback === undefined ? {} : { feedback }),
      },
    },
  };
}

export function createChildApprovalAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  input: {
    readonly threadsAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
    readonly hookRequestsAtom: Atom.Atom<ReadonlyArray<ScopedHookApprovalRequest>>;
    readonly capabilitiesAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ExecutionEnvironmentCapabilities | undefined>;
    readonly connectedAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  },
) {
  const readDetails = createEnvironmentRpcCommand(runtime, {
    label: "subagent-pending-approval-details",
    tag: WS_METHODS.approvalsGetPending,
  });
  const detailAtoms = Atom.family((key: string) => {
    const target = decodePendingApprovalTarget(JSON.parse(key));
    return Atom.make((get) =>
      Effect.promise(() => readDetails.run(get.registry, target)).pipe(
        Effect.flatMap((result) =>
          result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause),
        ),
      ),
    ).pipe(Atom.setIdleTTL(0));
  });
  const details = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.approvalsGetPending>;
    readonly revision: string;
  }) => detailAtoms(JSON.stringify(target));
  const pending = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    const cachedNative = new Map<string, ChildPendingApproval>();
    return Atom.make((get) => {
      const entries: ChildPendingApproval[] = [];
      const failed: Array<{
        readonly threadRef: ScopedThreadRef;
        readonly requestId: RuntimeRequestId;
        readonly revision: string;
      }> = [];
      if (!get(input.connectedAtom(ref.environmentId))) {
        cachedNative.clear();
        return { entries, failed };
      }
      const threads = get(input.threadsAtom(ref.environmentId));
      const capabilities = get(input.capabilitiesAtom(ref.environmentId));
      const hooks = hookApprovalsForThread(
        get(input.hookRequestsAtom),
        ref.environmentId,
        ref.threadId,
        threads,
      ).filter((request) => request.threadId !== ref.threadId);
      const hookApprovals = createPendingHookApprovals(
        hooks,
        [],
        hasHookApprovalGrantsCapability(capabilities),
      );
      const descendants = subagentThreadIds(ref.threadId, threads);
      const activeNative = new Set<string>();
      for (const thread of threads) {
        if (thread.id === ref.threadId || !descendants.has(thread.id)) continue;
        const threadRef = { environmentId: ref.environmentId, threadId: thread.id };
        const request = thread.pendingRuntimeRequest;
        const mirrored = hooks.some(
          (hook) => hook.threadId === thread.id && `custom-hook:${hook.requestId}` === request?.id,
        );
        if (
          !capabilities?.pendingApprovalDetails ||
          !request ||
          request.kind === "user_input" ||
          request.kind === "auth_refresh" ||
          request.kind === "dynamic_tool_call" ||
          mirrored
        )
          continue;
        const nativeKey = JSON.stringify([ref.environmentId, thread.id, request.id]);
        activeNative.add(nativeKey);
        const revision = DateTime.formatIso(thread.updatedAt);
        const result = get(
          details({
            environmentId: ref.environmentId,
            input: { threadId: thread.id, requestId: request.id },
            revision,
          }),
        );
        if (AsyncResult.isFailure(result))
          failed.push({ threadRef, requestId: request.id, revision });
        if (!AsyncResult.isSuccess(result)) {
          const cached = cachedNative.get(nativeKey);
          if (cached) {
            const retained = AsyncResult.isFailure(result)
              ? { ...cached, detailsUnavailable: true }
              : cached;
            cachedNative.set(nativeKey, retained);
            entries.push(retained);
          }
          continue;
        }
        if (result.value === null) {
          cachedNative.delete(nativeKey);
          continue;
        }
        const approval = derivePendingThreadRequests({
          runtimeRequests: [result.value.request],
          turnItems: [result.value.item],
        }).approvals[0];
        if (approval) {
          const entry = {
            key: nativeKey,
            threadRef,
            title: thread.title,
            approval: { ...approval, originThreadId: thread.id },
          };
          cachedNative.set(nativeKey, entry);
          entries.push(entry);
        }
      }
      for (const cachedKey of cachedNative.keys())
        if (!activeNative.has(cachedKey)) cachedNative.delete(cachedKey);
      for (const { request, approval } of hookApprovals) {
        entries.push({
          key: JSON.stringify([request.environmentId, request.threadId, request.requestId, "hook"]),
          threadRef: { environmentId: request.environmentId, threadId: request.threadId },
          title: threads.find((thread) => thread.id === request.threadId)!.title,
          approval,
          hookRequest: request,
        });
      }
      entries.sort(
        (left, right) =>
          left.approval.createdAt.localeCompare(right.approval.createdAt) ||
          left.key.localeCompare(right.key),
      );
      return { entries, failed };
    }).pipe(Atom.setIdleTTL(0));
  });
  return { pending: (ref: ScopedThreadRef) => pending(threadKey(ref)), details };
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

export const hookApprovalDurations = {
  "15-minutes": {
    duration: "15-minutes",
    label: "15 minutes",
    approvalLabel: "Approve for 15 min",
  },
  "1-hour": { duration: "1-hour", label: "1 hour", approvalLabel: "Approve for 1 hour" },
  session: {
    duration: "session",
    label: "This session",
    approvalLabel: "Approve for this session",
  },
} satisfies Record<
  HookApprovalDuration,
  { duration: HookApprovalDuration; label: string; approvalLabel: string }
>;

const hookApprovalOptions = [
  { decision: "decline", label: "Reject" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "accept", label: "Approve once" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

const bypassApprovalOptions = hookApprovalOptions.filter(
  (option) => option.decision !== "acceptForSession",
);

export function hookApprovalBypassSteps(bypass: HookApprovalBypass) {
  const occurrences = new Map<string, number>();
  return bypass.steps.map((step) => {
    const occurrence = occurrences.get(step.command) ?? 0;
    occurrences.set(step.command, occurrence + 1);
    return { ...step, key: `${occurrence}:${step.command}` };
  });
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

export function hookApprovalsForThread(
  requests: ReadonlyArray<ScopedHookApprovalRequest>,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "deletedAt">> = [],
): ReadonlyArray<ScopedHookApprovalRequest> {
  const visible = subagentThreadIds(threadId, threads);
  return requests.filter(
    (request) => request.environmentId === environmentId && visible.has(request.threadId),
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
        originThreadId: request.threadId,
        requestKind: "command",
        createdAt: DateTime.formatIso(request.createdAt),
        appName: "Custom hook",
        command: request.command,
        cwd: request.cwd,
        hookRequestId: request.requestId,
        reason: request.reason,
        ...(request.bypass
          ? { bypass: request.bypass }
          : {
              sessionApprovalScope: request.scope
                ? `${scopeLabel}: ${request.scope.label}`
                : unscopedDescription,
            }),
        responseCapability: "live",
        supportsFeedback: true,
        supportsTimedApproval: supportsTimedApproval && request.bypass === undefined,
        detail: [
          request.reason,
          `Command:\n${request.command}`,
          `Working directory:\n${request.cwd}`,
          ...(request.bypass
            ? [
                `Bypass attempt: ${request.bypass.rule}`,
                `Technique: ${request.bypass.technique} (tier ${request.bypass.tier})`,
                request.bypass.reasoning,
              ]
            : [request.scope ? `${scopeLabel}:\n${request.scope.label}` : unscopedDescription]),
        ].join("\n\n"),
        options: request.bypass ? bypassApprovalOptions : hookApprovalOptions,
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
  if (request.bypass && (decision === "allow-session" || duration !== undefined)) {
    throw new RangeError("Bypass attempts allow only a one-shot approval or rejection.");
  }
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
