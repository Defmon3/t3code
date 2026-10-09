import { assert, it } from "@effect/vitest";
import {
  HookApprovalRequestId,
  OrchestrationV2DomainEvent,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { synchronizeHookApprovalPhase } from "./HookApprovalPhase.ts";
import type { HookApprovalPending } from "./HookApprovalRegistry.ts";

const decodeDomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

it.effect("publishes waiting requests, wakes threads, and clears waiting after removal", () =>
  Effect.gen(function* () {
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const pending: HookApprovalPending = {
      runtimeSessionId: ProviderSessionId.make("native-session"),
      request: {
        requestId: HookApprovalRequestId.make("request-phase"),
        threadId: ThreadId.make("thread-phase"),
        command: "git commit",
        reason: "Confirm commit",
        cwd: "G:/workspace",
        createdAt: yield* DateTime.now,
      },
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    const commands: Array<string> = [];
    const dependencies: Parameters<typeof synchronizeHookApprovalPhase>[2] = {
      derive: allocator.derive,
      write: (input) =>
        Effect.sync(() => {
          events.push(...input.events);
          return [];
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command.type);
          return { sequence: 1, storedEvents: [] };
        }),
    };

    yield* synchronizeHookApprovalPhase([], [pending], dependencies);
    yield* synchronizeHookApprovalPhase([pending], [pending], dependencies);
    yield* synchronizeHookApprovalPhase([pending], [], dependencies);

    assert.deepEqual(commands, ["thread.unsnooze"]);
    assert.lengthOf(events, 4);
    for (const event of events) decodeDomainEvent(event);
    assert.deepEqual(
      events
        .filter((event) => event.type === "runtime-request.updated")
        .map((event) => event.payload.status),
      ["pending", "resolved"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "node.updated").map((event) => event.payload.status),
      ["waiting", "completed"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);
