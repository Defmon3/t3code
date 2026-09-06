import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatDayAwareTimestamp } from "~/timestampFormat";

import { AgentsPanel } from "./AgentsPanel";

const SPAWNED_AT = "2026-09-06T07:15:00.000Z";
const UPDATED_AT = "2026-09-06T08:45:00.000Z";

const agent: RuntimeSubagent = {
  id: "agent-1",
  kind: "subagent",
  title: "test-agent",
  role: null,
  model: "gpt-5.6-terra",
  effort: "medium",
  status: "completed",
  activationCount: 1,
  usage: { totalTokens: 1_234 },
  progress: null,
  lastToolName: null,
  result: "Finished the task",
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
  firstSeenAt: SPAWNED_AT,
  startedAt: SPAWNED_AT,
  completedAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
};

const model: AgentPanelModel = {
  workflows: [],
  directAgents: [agent],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 1,
  totalTokens: 1_234,
  hasAgents: true,
  liveCount: 0,
};

describe("AgentsPanel", () => {
  it("shows spawn and last-update timestamps while hiding only the scrollbar chrome", () => {
    const markup = renderToStaticMarkup(<AgentsPanel model={model} timestampFormat="24-hour" />);

    expect(markup).toContain(`spawned ${formatDayAwareTimestamp(SPAWNED_AT, "24-hour")}`);
    expect(markup).toContain(`updated ${formatDayAwareTimestamp(UPDATED_AT, "24-hour")}`);
    expect(markup).toContain("[scrollbar-width:none]");
    expect(markup).toContain("overflow-auto");
    expect(markup).not.toContain('data-slot="scroll-area-scrollbar"');
  });
});
