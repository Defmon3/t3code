// @effect-diagnostics nodeBuiltinImport:off -- A local socket marks child startup and termination.
import * as NodeNet from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as WindowsProcessWorker from "./WindowsProcessWorker.ts";

const layer = Layer.merge(NodeServices.layer, WindowsProcessWorker.layer);

describe("WindowsProcessWorker", () => {
  it.live("streams input and output and reports process exit", () =>
    Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const command = yield* HostProcess.ExecutablePath;
      const child = worker.spawn({
        command,
        args: [
          "-e",
          "process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => process.exitCode = 7)",
        ],
        env: process.env,
        signal: yield* Effect.abortSignal,
      });
      const completed = Effect.promise(async () => {
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        const exit = new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.once("exit", resolve);
        });
        child.stdin.end("hello 雪");
        const code = await exit;
        return { text: Buffer.concat(chunks).toString(), code };
      });
      expect(yield* completed).toEqual({ text: "hello 雪", code: 7 });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("aborts even when stdout is not consumed", () => {
    const abort = new AbortController();
    return Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const command = yield* HostProcess.ExecutablePath;
      const child = worker.spawn({
        command,
        args: ["-e", "process.stdout.write(Buffer.alloc(1024 * 1024)); process.stdin.resume()"],
        env: process.env,
        signal: abort.signal,
      });
      yield* Effect.promise(async () => {
        const exit = new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.once("exit", () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("readable", resolve);
          child.stdout.once("error", reject);
        });
        abort.abort();
        await exit;
      });
      expect(child.killed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("cancels a process whose signal is already aborted", () => {
    const abort = new AbortController();
    abort.abort();
    return Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const command = yield* HostProcess.ExecutablePath;
      const child = worker.spawn({
        command,
        args: ["-e", "process.stdin.resume()"],
        env: process.env,
        signal: abort.signal,
      });
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.once("exit", () => resolve());
          }),
      );
      expect(child.killed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("reports a streaming spawn error and accepts another process", () =>
    Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const child = worker.spawn({
        command: "missing-t3-worker-executable",
        args: [],
        env: process.env,
        signal: yield* Effect.abortSignal,
      });
      const error = yield* Effect.promise(
        () => new Promise<Error>((resolve) => child.on("error", resolve)),
      );
      expect(error.message).toContain("ENOENT");
      const command = yield* HostProcess.ExecutablePath;
      const output = yield* worker.run({
        command,
        args: ["-e", "process.stdout.write('ready')"],
        env: process.env,
        shell: false,
        maxOutputBytes: 100,
        outputMode: "error",
      });
      expect(new TextDecoder().decode(output.stdout)).toBe("ready");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.live("isolates concurrent commands and preserves cwd and environment", () =>
    Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const command = yield* HostProcess.ExecutablePath;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = path.normalize(yield* fs.makeTempDirectoryScoped());
      const outputs = yield* Effect.forEach(
        ["first", "second", "third"],
        (value) =>
          worker.run({
            command,
            args: [
              "-e",
              "process.stdout.write(process.env.T3_WORKER_TEST);process.stderr.write(process.cwd())",
            ],
            cwd,
            env: { ...process.env, T3_WORKER_TEST: value },
            shell: false,
            maxOutputBytes: 4096,
            outputMode: "error",
          }),
        { concurrency: "unbounded" },
      );
      expect(outputs.map((output) => new TextDecoder().decode(output.stdout))).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(outputs.map((output) => new TextDecoder().decode(output.stderr))).toEqual([
        cwd,
        cwd,
        cwd,
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("waits for child termination on interruption and remains usable", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      for (const descendant of platform === "win32" ? [false, true] : [false]) {
        const connected = Promise.withResolvers<void>();
        const disconnected = Promise.withResolvers<void>();
        const server = NodeNet.createServer((socket) => {
          socket.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "ECONNRESET") disconnected.reject(error);
          });
          socket.on("close", () => disconnected.resolve());
          connected.resolve();
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
              }),
          ),
          () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Expected TCP address");
        const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
        const command = yield* HostProcess.ExecutablePath;
        const client = `require('node:net').connect(${address.port},'127.0.0.1')`;
        const input = {
          command,
          args: [
            "-e",
            descendant
              ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(client)}],{stdio:'inherit'})`
              : client,
          ],
          env: process.env,
          shell: false,
          maxOutputBytes: 100,
          outputMode: "error" as const,
        };
        const running = yield* worker.run(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => connected.promise);
        yield* Fiber.interrupt(running);
        yield* Effect.promise(() => disconnected.promise);
        const output = yield* worker.run({
          ...input,
          args: ["-e", "process.stdout.write('ready')"],
        });
        expect(new TextDecoder().decode(output.stdout)).toBe("ready");
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("preserves stdin, both output streams, and nonzero exit codes", () =>
    Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const command = yield* HostProcess.ExecutablePath;
      const output = yield* worker.run({
        command,
        args: [
          "-e",
          "let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{process.stdout.write(text);process.stderr.write('detail');process.exitCode=7})",
        ],
        env: process.env,
        shell: false,
        stdin: "hello",
        maxOutputBytes: 100,
        outputMode: "error",
      });
      expect(new TextDecoder().decode(output.stdout)).toBe("hello");
      expect(new TextDecoder().decode(output.stderr)).toBe("detail");
      expect(output.code).toBe(7);
      expect(output.stdoutTruncated).toBe(false);
      expect(output.stderrTruncated).toBe(false);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live.each(["truncate", "error"] as const)(
    "honors the output byte limit in %s mode",
    (outputMode) =>
      Effect.gen(function* () {
        const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
        const command = yield* HostProcess.ExecutablePath;
        const read = worker.run({
          command,
          args: ["-e", "process.stdout.write('hello')"],
          env: process.env,
          shell: false,
          maxOutputBytes: 3,
          outputMode,
        });
        if (outputMode === "truncate") {
          const output = yield* read;
          expect(new TextDecoder().decode(output.stdout)).toBe("hel");
          expect(output.stdoutTruncated).toBe(true);
          expect(output.code).toBe(0);
        } else {
          const error = yield* read.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProcessWorkerOutputLimitError",
            stream: "stdout",
            maxBytes: 3,
          });
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live.each([
    { invalid: "missing", code: "ENOENT" },
    { invalid: "nul", code: "ERR_INVALID_ARG_VALUE" },
  ])("reports a $invalid executable and accepts the next command", ({ invalid, code }) =>
    Effect.gen(function* () {
      const worker = yield* WindowsProcessWorker.WindowsProcessWorker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const options = {
        args: ["-e", "process.stdout.write('ready')"],
        env: process.env,
        shell: false,
        maxOutputBytes: 100,
        outputMode: "error" as const,
      };
      const error = yield* worker
        .run({
          ...options,
          command: invalid === "nul" ? "git\u0000" : path.join(dir, "missing-command.exe"),
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ProcessWorkerError", phase: "spawn", code });
      const command = yield* HostProcess.ExecutablePath;
      const output = yield* worker.run({ ...options, command });
      expect(new TextDecoder().decode(output.stdout)).toBe("ready");
      expect(output.code).toBe(0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
