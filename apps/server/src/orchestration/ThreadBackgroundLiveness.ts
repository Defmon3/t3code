/**
 * ThreadBackgroundLivenessService - in-memory per-thread background work
 * details and the liveness summary derived from them.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working".
 *
 * @module ThreadBackgroundLivenessService
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES, type BackgroundWorkItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

// Classification sets are the shared contracts copies (MONITOR_TASK_TYPES:
// watch loops — monitor tasks plus background shells, which in practice are
// PR babysitting/log tails since pacing sleeps complete inside the turn;
// INERT_TASK_TYPES: plan-mode bookkeeping) so this registry, ingestion's
// agentKind stamp, and the client fold can never drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly title?: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
    readonly getThreadBackgroundWork: (threadId: string) => ReadonlyArray<BackgroundWorkItem>;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, Map<string, BackgroundWorkItem>>();

  // Classification is refreshed when a transition supplies taskType. A
  // status-only update preserves the known category, while a task first seen
  // without type defaults to agent. Map replacement prevents stale duplicate
  // categories from pinning the thread's status.
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.delete(taskId);
    if (state.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent (review finding).
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Status-free progress and metadata updates are not restarts. A delayed
      // row after idle must not put the task back in the live set (#7128).
      if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
        const existing = stateByThreadId.get(input.threadId);
        const stillLive = existing?.has(input.taskId) ?? false;
        if (!stillLive) {
          return;
        }
      }

      const existing = stateByThreadId.get(input.threadId)?.get(input.taskId);
      const state = stateByThreadId.get(input.threadId) ?? new Map<string, BackgroundWorkItem>();
      const category =
        taskType !== undefined
          ? MONITOR_TASK_TYPES.has(taskType)
            ? "monitor"
            : "agent"
          : (existing?.category ?? "agent");
      state.set(input.taskId, {
        taskId: input.taskId,
        category,
        ...(input.title
          ? { title: input.title }
          : existing?.title
            ? { title: existing.title }
            : {}),
        status:
          input.status === "pending" || input.status === "waiting" || input.status === "running"
            ? input.status
            : (existing?.status ?? "running"),
        ...(taskType ? { taskType } : existing?.taskType ? { taskType: existing.taskType } : {}),
      });
      stateByThreadId.set(input.threadId, state);
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      for (const item of state.values()) {
        if (item.category === "agent") {
          return "working";
        }
      }
      if (state.size > 0) {
        return "monitoring";
      }
      return null;
    },

    getThreadBackgroundWork: (threadId) =>
      Array.from(stateByThreadId.get(threadId)?.values() ?? [], (item) => ({ ...item })),
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
