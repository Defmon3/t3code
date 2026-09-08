import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  HookApprovalRequestInput,
  HookApprovalRegistryShape,
} from "./HookApprovalRegistry.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";

import { handleHookApprovalRequest, hookApprovalHttpRouteLayer } from "./HookApprovalHttp.ts";
import { HookApprovalRegistry } from "./HookApprovalRegistry.ts";
import * as HookApprovalRegistryModule from "./HookApprovalRegistry.ts";

const request = (body: unknown, authorization?: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3773/hook-approvals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const responseJson = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.body._tag !== "Uint8Array") throw new Error("Expected a JSON response body");
  return JSON.parse(new TextDecoder().decode(response.body.body)) as unknown;
};

const run = (httpRequest: ReturnType<typeof request>, hookApprovals: HookApprovalRegistryShape) =>
  handleHookApprovalRequest().pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, httpRequest),
    Effect.provideService(HookApprovalRegistry, hookApprovals),
  );

const hookApprovals = (
  overrides: Partial<HookApprovalRegistryShape> = {},
): HookApprovalRegistryShape => ({
  issue: () => Effect.die("unused"),
  isTokenActive: () => Effect.succeed(true),
  request: () => Effect.succeed("deny"),
  respond: () => Effect.succeed(false),
  subscribe: () => Stream.empty,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
  ...overrides,
});

it.effect("rejects missing and unknown hook credentials", () =>
  Effect.gen(function* () {
    const missing = yield* run(request({}), hookApprovals());
    const unknown = yield* run(
      request({ command: "git status", reason: "Check state", cwd: "C:/repo" }, "Bearer unknown"),
      hookApprovals({ isTokenActive: () => Effect.succeed(false) }),
    );

    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
  }),
);

it.effect("rejects malformed hook approval payloads", () =>
  Effect.gen(function* () {
    const response = yield* run(
      request({ command: "git status", reason: "", cwd: "C:/repo" }, "Bearer valid"),
      hookApprovals(),
    );

    expect(response.status).toBe(400);
  }),
);

it.effect("bridges a real hook request to the registry and back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* HookApprovalRegistryModule.__testing
        .make()
        .pipe(Effect.provide(NodeServices.layer));
      yield* HttpRouter.serve(
        hookApprovalHttpRouteLayer.pipe(
          Layer.provide(Layer.succeed(HookApprovalRegistry, registry)),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const credential = yield* registry.issue({
        threadId: ThreadId.make("hook-http-thread"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .post("/hook-approvals", {
          headers: { authorization: `Bearer ${credential.token}` },
          body: HttpBody.jsonUnsafe({
            command: "git status",
            reason: "Check state",
            cwd: "C:/repo",
          }),
        })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const requests = Option.getOrThrow(
        yield* registry.subscribe().pipe(
          Stream.filter((pending) => pending.length > 0),
          Stream.runHead,
        ),
      );
      const approval = requests[0]!;
      yield* registry.respond({ requestId: approval.requestId, decision: "allow" });
      const completed = yield* Fiber.join(response);

      expect(completed.status).toBe(200);
      expect(yield* completed.json).toEqual({ decision: "allow" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  ),
);

it.effect("waits for a hook decision and returns it", () =>
  Effect.gen(function* () {
    const decision = yield* Deferred.make<"allow" | "allow-session" | "deny">();
    const received = yield* Deferred.make<HookApprovalRequestInput>();
    const pending = yield* Effect.forkChild(
      run(
        request(
          {
            command: "  git status\n",
            reason: "Inspect the working tree",
            cwd: "C:/repo",
            scope: { key: "git-status", label: "Git status" },
          },
          "Bearer valid",
        ),
        hookApprovals({
          request: (_token, input) =>
            Deferred.succeed(received, input).pipe(Effect.andThen(Deferred.await(decision))),
        }),
      ),
    );

    expect(yield* Deferred.await(received)).toEqual({
      command: "  git status\n",
      reason: "Inspect the working tree",
      cwd: "C:/repo",
      scope: { key: "git-status", label: "Git status" },
    });
    yield* Deferred.succeed(decision, "allow-session");
    const response = yield* Fiber.join(pending);

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({ decision: "allow-session" });
  }),
);
