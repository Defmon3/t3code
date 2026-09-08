import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";

import * as HookApprovalRegistry from "./HookApprovalRegistry.ts";

const server = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "::1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const makeRegistry = (options: HookApprovalRegistry.HookApprovalRegistryOptions = {}) =>
  HookApprovalRegistry.__testing
    .make(options)
    .pipe(Effect.provideService(HttpServer.HttpServer, server), Effect.provide(NodeServices.layer));
const input = { command: "python task.py", reason: "Run task", cwd: "G:/repo" };

it.effect("denies invalid and revoked tokens", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry();
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.endpoint).toBe("http://[::1]:43123/hook-approvals");
    expect(yield* registry.request("invalid", input)).toBe("deny");
    yield* registry.revokeThread(threadId);
    expect(yield* registry.request(issued.token, input)).toBe("deny");
  }),
);

it.effect("allows one request and consumes duplicate responses", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry();
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const snapshotFiber = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const requestFiber = yield* Effect.forkScoped(registry.request(issued.token, input));
    const pending = yield* Fiber.join(snapshotFiber);
    const request = Option.getOrThrow(pending)[0]!;
    expect(yield* registry.respond({ requestId: request.requestId, decision: "allow" })).toBe(true);
    expect(yield* registry.respond({ requestId: request.requestId, decision: "allow" })).toBe(
      false,
    );
    expect(yield* Fiber.join(requestFiber)).toBe("allow");
  }),
);

it.effect("requires a scope for a session allowance and scopes the allowance", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry();
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-3"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const initialSnapshot = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const first = yield* Effect.forkScoped(registry.request(issued.token, input));
    const unscoped = Option.getOrThrow(yield* Fiber.join(initialSnapshot))[0]!;
    expect(
      yield* registry.respond({ requestId: unscoped.requestId, decision: "allow-session" }),
    ).toBe(false);
    yield* registry.respond({ requestId: unscoped.requestId, decision: "deny" });
    expect(yield* Fiber.join(first)).toBe("deny");
    const scoped = { ...input, scope: { key: "repo:one", label: "repo one" } };
    const scopedSnapshot = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const second = yield* Effect.forkScoped(registry.request(issued.token, scoped));
    const request = Option.getOrThrow(yield* Fiber.join(scopedSnapshot))[0]!;
    yield* registry.respond({ requestId: request.requestId, decision: "allow-session" });
    expect(yield* Fiber.join(second)).toBe("allow-session");
    expect(yield* registry.request(issued.token, scoped)).toBe("allow");
  }),
);

it.effect("replaces a thread credential atomically", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry();
    const threadId = ThreadId.make("thread-4");
    const first = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const second = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(yield* registry.isTokenActive(first.token)).toBe(false);
    expect(yield* registry.isTokenActive(second.token)).toBe(true);
  }),
);

it.effect("expires pending approvals without retaining a late session allowance", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ timeout: "1 second" });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-5"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const scope = { key: "repo:one", label: "repo one" };
    const pendingSnapshot = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const request = yield* Effect.forkScoped(registry.request(issued.token, { ...input, scope }));
    const pending = Option.getOrThrow(yield* Fiber.join(pendingSnapshot))[0]!;
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(request)).toBe("deny");
    expect(
      yield* registry.respond({ requestId: pending.requestId, decision: "allow-session" }),
    ).toBe(false);
    const nextSnapshot = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const next = yield* Effect.forkScoped(registry.request(issued.token, { ...input, scope }));
    expect(Option.getOrThrow(yield* Fiber.join(nextSnapshot))).toHaveLength(1);
    yield* registry.revokeAll;
    expect(yield* Fiber.join(next)).toBe("deny");
  }),
);

it.effect("keeps an approval that wins before its deadline", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ timeout: "1 second" });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-6"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const snapshot = yield* Effect.forkScoped(
      registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
    );
    const request = yield* Effect.forkScoped(registry.request(issued.token, input));
    const pending = Option.getOrThrow(yield* Fiber.join(snapshot))[0]!;
    expect(yield* registry.respond({ requestId: pending.requestId, decision: "allow" })).toBe(true);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(request)).toBe("allow");
  }),
);

it.effect(
  "publishes pending requests to reconnecting subscribers and clears them on revocation",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const threadId = ThreadId.make("thread-7");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const update = yield* Effect.forkScoped(
        registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
      );
      const waiting = yield* Effect.forkScoped(registry.request(issued.token, input));
      const pending = Option.getOrThrow(yield* Fiber.join(update));
      expect(pending).toHaveLength(1);
      const reconnectSnapshot = Option.getOrThrow(yield* registry.subscribe().pipe(Stream.runHead));
      expect(reconnectSnapshot).toHaveLength(1);
      yield* registry.revokeThread(threadId);
      expect(yield* Fiber.join(waiting)).toBe("deny");
      expect(Option.getOrThrow(yield* registry.subscribe().pipe(Stream.runHead))).toEqual([]);
    }),
);

it.effect(
  "limits remembered approvals to one session and scope and clears interrupted requests",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const first = yield* registry.issue({
        threadId: ThreadId.make("thread-8"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const scope = { key: "repo:one", label: "repo one" };
      const initialUpdate = yield* Effect.forkScoped(
        registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
      );
      const initial = yield* Effect.forkScoped(registry.request(first.token, { ...input, scope }));
      const initialPending = Option.getOrThrow(yield* Fiber.join(initialUpdate))[0]!;
      yield* registry.respond({ requestId: initialPending.requestId, decision: "allow-session" });
      expect(yield* Fiber.join(initial)).toBe("allow-session");
      expect(
        yield* registry.request(first.token, { ...input, command: "python another.py", scope }),
      ).toBe("allow");

      const otherScope = { key: "repo:two", label: "repo two" };
      const otherScopeUpdate = yield* Effect.forkScoped(
        registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
      );
      const otherScopeRequest = yield* Effect.forkScoped(
        Effect.interruptible(registry.request(first.token, { ...input, scope: otherScope })),
        { uninterruptible: false },
      );
      const otherScopePending = Option.getOrThrow(yield* Fiber.join(otherScopeUpdate))[0]!;
      expect(otherScopePending.scope?.key).toBe(otherScope.key);
      yield* Fiber.interrupt(otherScopeRequest);
      yield* Effect.yieldNow;
      expect(
        yield* registry.respond({
          requestId: otherScopePending.requestId,
          decision: "allow-session",
        }),
      ).toBe(false);

      const second = yield* registry.issue({
        threadId: ThreadId.make("thread-9"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const otherSessionUpdate = yield* Effect.forkScoped(
        registry.subscribe().pipe(Stream.drop(1), Stream.runHead),
      );
      const otherSessionRequest = yield* Effect.forkScoped(
        registry.request(second.token, { ...input, scope }),
      );
      expect(Option.getOrThrow(yield* Fiber.join(otherSessionUpdate))).toHaveLength(1);
      yield* registry.revokeAll;
      expect(yield* Fiber.join(otherSessionRequest)).toBe("deny");
    }),
);
