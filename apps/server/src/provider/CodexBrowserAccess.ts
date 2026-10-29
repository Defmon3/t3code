// @effect-diagnostics nodeBuiltinImport:off - Native browser authorization uses a private pipe or Unix socket.
// @effect-diagnostics preferSchemaOverJson:off - The native signature protocol requires the original JSON parameter order.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class BrowserAccessError extends Schema.TaggedError<BrowserAccessError>()(
  "CodexBrowserAccessError",
  {
    operation: Schema.Literals(["listen", "request"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not ${this.operation === "listen" ? "start" : "handle"} Codex browser authorization.`;
  }
}

const AccessParams = Schema.Struct({
  executorId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
});
const AccessRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Finite]),
  method: Schema.Literal("browser/access"),
  params: AccessParams,
});
const decodeRequest = Schema.decodeUnknownOption(AccessRequest, { onExcessProperty: "error" });
const isRequest = (input: unknown): input is typeof AccessRequest.Type =>
  Option.isSome(decodeRequest(input));
const littleEndian = NodeOS.endianness() === "LE";
// why: The native browser host rejects frames larger than 8 MiB.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const make = Effect.fn("CodexBrowserAccess.make")(function* (options: {
  readonly authorize: (request: typeof AccessParams.Type) => Effect.Effect<boolean>;
}) {
  const platform = yield* HostProcess.Platform;
  const executorId = NodeCrypto.randomUUID();
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const owned = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (platform === "win32") {
          return { endpoint: `\\\\.\\pipe\\t3-codex-browser-${NodeCrypto.randomUUID()}` };
        }
        const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-"));
        try {
          await NodeFSP.chmod(directory, 0o700);
          const created = await NodeFSP.lstat(directory);
          return { endpoint: NodePath.join(directory, "s"), directory, created };
        } catch (cause) {
          await NodeFSP.rmdir(directory);
          throw cause;
        }
      },
      catch: (cause) => new BrowserAccessError({ operation: "listen", cause }),
    }),
    (resource) =>
      Effect.promise(async () => {
        if (resource.directory === undefined) return;
        const current = await NodeFSP.lstat(resource.directory);
        if (
          current.dev !== resource.created.dev ||
          current.ino !== resource.created.ino ||
          current.isSymbolicLink()
        ) {
          throw new Error("Codex browser authorization directory ownership changed.");
        }
        await NodeFSP.rmdir(resource.directory);
      }),
  );
  const run = yield* FiberSet.makeRuntime();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (cause) => {
      run(Effect.logDebug("Codex browser authorization connection failed.", { cause }));
      socket.destroy();
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = littleEndian ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          socket.destroy(new Error("Invalid Codex browser authorization frame length."));
          return;
        }
        if (buffered.length < length + 4) return;
        const frame = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        run(
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => {
                const parsed: unknown = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(frame),
                );
                if (!isRequest(parsed))
                  throw new Error("Invalid Codex browser authorization request.");
                // why: The native host verifies the original parameter property order.
                return parsed;
              },
              catch: (cause) => new BrowserAccessError({ operation: "request", cause }),
            });
            const allowed =
              request.params.executorId === executorId &&
              (yield* options.authorize(request.params));
            const payload = JSON.stringify({
              domain: "codex.browserAccess.v1",
              request: request.params,
              allowed,
            });
            const signature = NodeCrypto.sign(null, Buffer.from(payload), privateKey).toString(
              "base64",
            );
            const response = Buffer.from(
              JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { payload, signature } }),
            );
            const header = Buffer.alloc(4);
            if (littleEndian) header.writeUInt32LE(response.length);
            else header.writeUInt32BE(response.length);
            socket.write(Buffer.concat([header, response]));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Codex browser authorization request failed.", { cause }).pipe(
                Effect.andThen(Effect.sync(() => socket.destroy())),
              ),
            ),
          ),
        );
      }
    });
  });
  server.on("error", (cause) => {
    run(Effect.logWarning("Codex browser authorization listener failed.", { cause }));
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          for (const socket of sockets) socket.destroy();
          server.close((error) =>
            error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve(),
          );
        }),
    ),
  );
  yield* Effect.callback<void, BrowserAccessError>((resume) => {
    const onError = (cause: Error) =>
      resume(Effect.fail(new BrowserAccessError({ operation: "listen", cause })));
    server.once("error", onError);
    try {
      server.listen(owned.endpoint, () => resume(Effect.void));
    } catch (cause) {
      resume(Effect.fail(new BrowserAccessError({ operation: "listen", cause })));
    }
    return Effect.sync(() => server.off("error", onError));
  });
  if (owned.directory !== undefined) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.chmod(owned.endpoint, 0o600),
      catch: (cause) => new BrowserAccessError({ operation: "listen", cause }),
    });
  }
  return {
    environment: {
      BROWSER_USE_ACCESS_EXECUTOR_ID: executorId,
      BROWSER_USE_ACCESS_PIPE_PATH: owned.endpoint,
      BROWSER_USE_ACCESS_VERIFYING_IDENTITY: publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    },
  };
});
