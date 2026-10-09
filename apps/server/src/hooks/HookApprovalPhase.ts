import {
  CommandId,
  EventId,
  RuntimeRequestId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { HookApprovalPending } from "./HookApprovalRegistry.ts";

export function synchronizeHookApprovalPhase(
  previous: ReadonlyArray<HookApprovalPending>,
  current: ReadonlyArray<HookApprovalPending>,
  dependencies: {
    readonly write: EventSink.EventSinkV2["Service"]["write"];
    readonly dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"];
    readonly derive: IdAllocator.IdAllocatorV2["Service"]["derive"];
  },
) {
  return Effect.gen(function* () {
    const added = current.filter(
      (pending) => !previous.some((entry) => entry.request.requestId === pending.request.requestId),
    );
    const removed = previous.filter(
      (pending) => !current.some((entry) => entry.request.requestId === pending.request.requestId),
    );
    const now = yield* DateTime.now;
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const [pending, status] of [
      ...added.map((pending) => [pending, "pending"] as const),
      ...removed.map((pending) => [pending, "resolved"] as const),
    ]) {
      if (pending.runtimeSessionId === undefined)
        return yield* Effect.die(
          new Error("Hook approval phase requires a provider runtime session."),
        );
      const request = pending.request;
      const requestId = RuntimeRequestId.make(`custom-hook:${request.requestId}`);
      const nodeId = dependencies.derive.approvalNode({ requestId });
      const base = { threadId: request.threadId, nodeId, occurredAt: now };
      events.push(
        {
          ...base,
          id: EventId.make(`${requestId}:${status}:node`),
          type: "node.updated",
          payload: {
            id: nodeId,
            threadId: request.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "approval_request",
            status: status === "pending" ? "waiting" : "completed",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: request.createdAt,
            completedAt: status === "pending" ? null : now,
          },
        },
        {
          ...base,
          id: EventId.make(`${requestId}:${status}:request`),
          type: "runtime-request.updated",
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status,
            responseCapability: { type: "live", providerSessionId: pending.runtimeSessionId },
            createdAt: request.createdAt,
            resolvedAt: status === "pending" ? null : now,
          },
        },
      );
    }
    if (events.length > 0) yield* dependencies.write({ events });
    for (const pending of added) {
      yield* dependencies.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make(`custom-hook:${pending.request.requestId}:unsnooze`),
        threadId: pending.request.threadId,
        reason: "user",
      });
    }
  });
}
