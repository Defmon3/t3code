import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { agentActivityText, subagentStatusVisuals } from "./AgentsPanel.logic";

function agent(status: RuntimeSubagent["status"]): RuntimeSubagent {
  return {
    id: "agent-1",
    kind: "subagent",
    title: "Agent",
    role: null,
    model: null,
    effort: null,
    status,
    activationCount: 1,
    usage: null,
    progress: "Analyzing the repository",
    lastToolName: "rg",
    result: "Completed analysis",
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-09T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("agent roster lifecycle presentation", () => {
  it("shows queued and waiting states instead of working", () => {
    expect(subagentStatusVisuals.pending).toMatchObject({
      dotClass: "bg-muted-foreground/50",
      label: "Queued",
    });
    expect(subagentStatusVisuals.waiting).toMatchObject({
      dotClass: "bg-warning",
      label: "Waiting",
    });
  });

  it("does not present historical progress as activity for idle agents", () => {
    expect(agentActivityText(agent("idle"))).toBe("Idle · resumable");
  });

  it("shows the stopped lifecycle label when an interrupted agent has no outcome", () => {
    expect(agentActivityText({ ...agent("interrupted"), result: null })).toBeNull();
  });
});
