import { HookApprovalHttpRequest, type HookApprovalHttpResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { HookApprovalRegistry } from "./HookApprovalRegistry.ts";

const MAX_REQUEST_BODY_BYTES = 32_768;

const malformedRequest = HttpServerResponse.jsonUnsafe(
  { error: "invalid_hook_approval_request" },
  { status: 400, headers: { "cache-control": "no-store" } },
);

const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "invalid_hook_approval_credential" },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

const bearerToken = (authorization: string | undefined): string | undefined => {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

export const handleHookApprovalRequest = Effect.fn("HookApprovalHttp.handleHookApprovalRequest")(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = bearerToken(request.headers.authorization);
    if (!token) return unauthorized;

    const hookApprovals = yield* HookApprovalRegistry;
    if (!(yield* hookApprovals.isTokenActive(token))) return unauthorized;

    const input = yield* HttpServerRequest.schemaBodyJson(HookApprovalHttpRequest).pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(MAX_REQUEST_BODY_BYTES)),
      Effect.orElseSucceed(() => undefined),
    );
    if (!input) return malformedRequest;

    const decision = yield* hookApprovals.request(token, {
      command: input.command,
      reason: input.reason,
      cwd: input.cwd,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    return HttpServerResponse.jsonUnsafe({ decision } satisfies HookApprovalHttpResponse, {
      headers: { "cache-control": "no-store" },
    });
  },
);

export const hookApprovalHttpRouteLayer = Layer.unwrap(
  HookApprovalRegistry.pipe(
    Effect.map((hookApprovals) =>
      HttpRouter.add(
        "POST",
        "/hook-approvals",
        handleHookApprovalRequest().pipe(
          Effect.provideService(HookApprovalRegistry, hookApprovals),
        ),
      ),
    ),
  ),
);
