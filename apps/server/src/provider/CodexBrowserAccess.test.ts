// @effect-diagnostics nodeBuiltinImport:off - Verify native Ed25519 signatures with the public key given to the browser host.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as CodexBrowserAccess from "./CodexBrowserAccess.ts";

const Response = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Finite]),
  result: Schema.Struct({ payload: Schema.String, signature: Schema.String }),
});
const Payload = Schema.Struct({
  domain: Schema.Literal("codex.browserAccess.v1"),
  request: Schema.Struct({
    executorId: Schema.String,
    sessionId: Schema.String,
    turnId: Schema.String,
    nonce: Schema.String,
  }),
  allowed: Schema.Boolean,
});
const params = { sessionId: "native-session", turnId: "native-turn", nonce: "nonce-1" };
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));
const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Payload));

function frame(body: string) {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(4);
  if (NodeOS.endianness() === "LE") header.writeUInt32LE(bytes.length);
  else header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

const exchange = (endpoint: string, bytes: Buffer, split = false) =>
  Effect.tryPromise(
    () =>
      new Promise<string | undefined>((resolve, reject) => {
        const socket = NodeNet.createConnection(endpoint);
        let buffered = Buffer.alloc(0);
        socket.once("error", reject);
        socket.once("close", () => resolve(undefined));
        socket.once("connect", () => {
          if (split) {
            socket.write(bytes.subarray(0, 2));
            socket.write(bytes.subarray(2));
          } else socket.write(bytes);
        });
        socket.on("data", (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (buffered.length < 4) return;
          const length =
            NodeOS.endianness() === "LE" ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
          if (buffered.length < 4 + length) return;
          resolve(buffered.subarray(4, length + 4).toString("utf8"));
          socket.destroy();
        });
      }),
  );

describe("CodexBrowserAccess", () => {
  it.live.each([
    {
      permission: true,
      executor: "own",
      sessionId: params.sessionId,
      turnId: params.turnId,
      allowed: true,
    },
    {
      permission: true,
      executor: "other",
      sessionId: params.sessionId,
      turnId: params.turnId,
      allowed: false,
    },
    {
      permission: true,
      executor: "own",
      sessionId: "unknown",
      turnId: params.turnId,
      allowed: false,
    },
    {
      permission: true,
      executor: "own",
      sessionId: params.sessionId,
      turnId: "ended",
      allowed: false,
    },
    {
      permission: false,
      executor: "own",
      sessionId: params.sessionId,
      turnId: params.turnId,
      allowed: false,
    },
  ])("signs the permission result for $executor/$sessionId/$turnId/$permission", (testCase) =>
    Effect.gen(function* () {
      const access = yield* CodexBrowserAccess.make({
        authorize: (request) =>
          Effect.succeed(
            testCase.permission &&
              request.sessionId === params.sessionId &&
              request.turnId === params.turnId,
          ),
      });
      const request = {
        nonce: params.nonce,
        turnId: testCase.turnId,
        sessionId: testCase.sessionId,
        executorId:
          testCase.executor === "own" ? access.environment.BROWSER_USE_ACCESS_EXECUTOR_ID : "other",
      };
      const body = yield* exchange(
        access.environment.BROWSER_USE_ACCESS_PIPE_PATH,
        frame(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "browser/access", params: request })),
        true,
      );
      const response = yield* decodeResponse(body);
      assert.equal(response.id, 7);
      assert.equal(
        response.result.payload,
        JSON.stringify({ domain: "codex.browserAccess.v1", request, allowed: testCase.allowed }),
      );
      const key = NodeCrypto.createPublicKey({
        key: Buffer.from(access.environment.BROWSER_USE_ACCESS_VERIFYING_IDENTITY, "base64"),
        format: "der",
        type: "spki",
      });
      assert.isTrue(
        NodeCrypto.verify(
          null,
          Buffer.from(response.result.payload),
          key,
          Buffer.from(response.result.signature, "base64"),
        ),
      );
      assert.isFalse(
        NodeCrypto.verify(
          null,
          Buffer.from(response.result.payload.replace(params.nonce, "another-nonce")),
          key,
          Buffer.from(response.result.signature, "base64"),
        ),
      );
      assert.equal((yield* decodePayload(response.result.payload)).allowed, testCase.allowed);
    }).pipe(Effect.scoped),
  );

  it.live.each([
    "{",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wrong", params }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "browser/access",
      params: { ...params, executorId: "test", extra: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "browser/access",
      params: { ...params, executorId: "test", nonce: 1 },
    }),
  ])("closes malformed requests without granting access: %s", (body) =>
    Effect.gen(function* () {
      const access = yield* CodexBrowserAccess.make({
        authorize: () => Effect.die("Malformed request reached authorization."),
      });
      assert.isUndefined(
        yield* exchange(access.environment.BROWSER_USE_ACCESS_PIPE_PATH, frame(body)),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each([0, 8 * 1024 * 1024 + 1])("rejects invalid native frame length %s", (length) =>
    Effect.gen(function* () {
      const access = yield* CodexBrowserAccess.make({
        authorize: () => Effect.die("Invalid frame reached authorization."),
      });
      const header = Buffer.alloc(4);
      if (NodeOS.endianness() === "LE") header.writeUInt32LE(length);
      else header.writeUInt32BE(length);
      assert.isUndefined(yield* exchange(access.environment.BROWSER_USE_ACCESS_PIPE_PATH, header));
    }).pipe(Effect.scoped),
  );

  it.live("closes owned connections and removes the listener when its scope ends", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const access = yield* CodexBrowserAccess.make({
        authorize: () => Effect.succeed(false),
      }).pipe(Scope.provide(scope));
      const socket = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeNet.Socket>((resolve, reject) => {
              const connection = NodeNet.createConnection(
                access.environment.BROWSER_USE_ACCESS_PIPE_PATH,
              );
              connection.once("connect", () => resolve(connection));
              connection.once("error", reject);
            }),
        ),
        (connection) => Effect.sync(() => connection.destroy()),
      );
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => closed);
      assert.isTrue(socket.destroyed);
      assert.equal(
        (yield* exchange(access.environment.BROWSER_USE_ACCESS_PIPE_PATH, frame("{}")).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.scoped),
  );
});
