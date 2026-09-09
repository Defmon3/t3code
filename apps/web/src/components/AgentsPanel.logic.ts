import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";

export const subagentStatusVisuals: Record<
  RuntimeSubagent["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-muted-foreground/50", label: "Queued" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-warning", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

export function agentActivityText(agent: RuntimeSubagent): string | null {
  switch (agent.status) {
    case "pending":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle · resumable";
    case "running":
      return (
        agent.progress ??
        (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
        agent.result ??
        agent.error
      );
    default:
      return agent.error ?? agent.result;
  }
}
