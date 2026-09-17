import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const createdAt = "2026-09-17T10:00:00.000Z";
const threadId = ThreadId.make("thread-1");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: createdAt,
};

it.layer(NodeServices.layer)("thread message completion decider", (it) => {
  it.effect("preserves assistant completion text", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("command-assistant-complete"),
          threadId,
          messageId: MessageId.make("message-assistant"),
          text: "Assistant text",
          createdAt,
        },
        readModel,
      });

      expect(event).toMatchObject({
        type: "thread.message-sent",
        payload: { role: "assistant", text: "Assistant text" },
      });
    }),
  );

  it.effect("completes reasoning without text", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.reasoning.complete",
          commandId: CommandId.make("command-reasoning-complete"),
          threadId,
          messageId: MessageId.make("message-reasoning"),
          createdAt,
        },
        readModel,
      });

      expect(event).toMatchObject({
        type: "thread.message-sent",
        payload: { role: "reasoning", text: "" },
      });
    }),
  );
});
