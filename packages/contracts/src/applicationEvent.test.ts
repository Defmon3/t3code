import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ApplicationProjectEvent } from "./applicationEvent.ts";

const decodeApplicationProjectEvent = Schema.decodeUnknownEffect(ApplicationProjectEvent);

describe("application project events", () => {
  it.effect("carries quick slot shortcuts on project.created", () =>
    Effect.gen(function* () {
      const event = yield* decodeApplicationProjectEvent({
        sequence: 12,
        eventId: "event-project-12",
        aggregateKind: "project",
        aggregateId: "project-1",
        occurredAt: "2026-06-24T12:00:00.000Z",
        commandId: "command-project-12",
        causationEventId: null,
        correlationId: "command-project-12",
        metadata: {},
        type: "project.created",
        payload: {
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          skillShortcuts: ["review"],
          skillShortcutColors: { review: "violet" },
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
      });

      expect(event.type).toBe("project.created");
      if (event.type === "project.created") {
        expect(event.payload.skillShortcuts).toEqual(["review"]);
        expect(event.payload.skillShortcutColors).toEqual({ review: "violet" });
      }
    }),
  );
});
