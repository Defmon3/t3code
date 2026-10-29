import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProcessRunner from "./processRunner.ts";
import * as WindowsGitWorker from "./WindowsGitWorker.ts";

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly shell?: boolean | string;
  };
};

function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

function makeHandle(input: {
  readonly stdout?: string | Stream.Stream<Uint8Array>;
  readonly stderr?: string | Stream.Stream<Uint8Array>;
  readonly code?: number;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout:
      typeof input.stdout === "string"
        ? Stream.encodeText(Stream.make(input.stdout))
        : (input.stdout ?? Stream.empty),
    stderr:
      typeof input.stderr === "string"
        ? Stream.encodeText(Stream.make(input.stderr))
        : (input.stderr ?? Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(
  f: (
    command: ChildProcessCommand,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>,
) {
  return ChildProcessSpawner.make((command) => f(asChildProcessCommand(command)));
}

const runWith =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (input: ProcessRunner.ProcessRunInput) =>
    Effect.service(ProcessRunner.ProcessRunner).pipe(
      Effect.flatMap((runner) =>
        runner.run({
          ...input,
        }),
      ),
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );

describe("runProcess", () => {
  it.effect("extends the injected host environment with command overrides in the worker", () =>
    Effect.gen(function* () {
      const worker = WindowsGitWorker.WindowsGitWorker.of({
        run: (input) =>
          Effect.succeed({
            code: 0,
            stdout: new TextEncoder().encode(
              `${input.env.T3_TEST_HOST}:${input.env.T3_TEST_OVERRIDE}`,
            ),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      });
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(() => Effect.succeed(makeHandle({}))),
        ),
        Effect.provideService(WindowsGitWorker.WindowsGitWorker, worker),
      );
      const output = yield* runner.run({
        command: "git",
        args: [],
        env: { T3_TEST_OVERRIDE: "command" },
      });
      expect(output.stdout).toBe("host:command");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        T3_TEST_HOST: "host",
        T3_TEST_OVERRIDE: "inherited",
      }),
      Effect.provideService(SpawnExecutableResolution, (command) => command),
    ),
  );

  it.effect.each(["error", "timedOutResult"] as const)(
    "preserves worker timeout behavior %s",
    (timeoutBehavior) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const worker = WindowsGitWorker.WindowsGitWorker.of({
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
        });
        const runner = yield* ProcessRunner.make().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(() => Effect.succeed(makeHandle({}))),
          ),
          Effect.provideService(WindowsGitWorker.WindowsGitWorker, worker),
        );
        const running = yield* runner
          .run({ command: "git", args: [], timeout: "1 second", timeoutBehavior })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(cancelled);
        const result = yield* Fiber.join(running);
        if (timeoutBehavior === "error") {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProcessTimeoutError", timeoutMs: 1000 },
          });
        } else {
          expect(result).toMatchObject({
            _tag: "Success",
            success: { timedOut: true, code: null, stdout: "", stderr: "" },
          });
        }
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(SpawnExecutableResolution, (command) => command),
      ),
  );

  it.effect.each([
    { platform: "win32" as const, command: "git", streaming: false, expected: "worker" },
    {
      platform: "win32" as const,
      command: "C:\\tools\\GIT.EXE",
      streaming: false,
      expected: "worker",
    },
    { platform: "win32" as const, command: "git", streaming: true, expected: "native" },
    { platform: "linux" as const, command: "git", streaming: false, expected: "native" },
  ])(
    "routes $platform $command streaming=$streaming to $expected",
    ({ platform, command, streaming, expected }) =>
      Effect.gen(function* () {
        const worker = WindowsGitWorker.WindowsGitWorker.of({
          run: () =>
            Effect.succeed({
              code: 0,
              stdout: new TextEncoder().encode("worker"),
              stderr: new Uint8Array(),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        });
        const runner = yield* ProcessRunner.make().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(() => Effect.succeed(makeHandle({ stdout: "native" }))),
          ),
          Effect.provideService(WindowsGitWorker.WindowsGitWorker, worker),
        );
        const chunks: string[] = [];
        const output = yield* runner.run({
          command,
          args: [],
          ...(streaming
            ? { onStdoutChunk: (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)) }
            : {}),
        });
        expect(output.stdout).toBe(expected);
        expect(chunks.join("")).toBe(streaming ? "native" : "");
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(SpawnExecutableResolution, (command) => command),
      ),
  );

  it.effect("serves another command while Windows Git runs in the worker", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const nativeCommands: string[] = [];
      const worker = WindowsGitWorker.WindowsGitWorker.of({
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              code: 0,
              stdout: new TextEncoder().encode("checkpoint"),
              stderr: new Uint8Array(),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          ),
      });
      const native = makeSpawner((command) =>
        Effect.sync(() => {
          nativeCommands.push(command.command);
          return makeHandle({ stdout: "interactive" });
        }),
      );
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, native),
        Effect.provideService(WindowsGitWorker.WindowsGitWorker, worker),
      );
      const git = yield* runner.run({ command: "git", args: ["status"] }).pipe(Effect.forkChild);
      yield* Deferred.await(started);

      expect((yield* runner.run({ command: "node", args: [] })).stdout).toBe("interactive");
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(git)).stdout).toBe("checkpoint");
      expect(nativeCommands).toEqual(["C:\\tools\\node.exe"]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(SpawnExecutableResolution, (command) => `C:\\tools\\${command}.exe`),
    ),
  );

  it.effect("resolves and escapes Windows command shims before spawning", () => {
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe(
          [
            '^"C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd^"',
            '^"repos^"',
            '^"pr^"',
            '^"list^"',
            '^"--source-branch^"',
            '^"feature^ ^&^ release^"',
          ].join(" "),
        );
        expect(command.args).toEqual([]);
        expect(command.options.shell).toBe(true);
        return makeHandle({ stdout: "[]" });
      }),
    );

    return runWith(spawner)({
      command: "az",
      args: ["repos", "pr", "list", "--source-branch", "feature & release"],
      env: { AZURE_CONFIG_DIR: "C:\\Users\\tester\\.azure" },
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) =>
        env.PATH === "C:\\Users\\tester\\AppData\\Roaming\\npm" &&
        env.AZURE_CONFIG_DIR === "C:\\Users\\tester\\.azure"
          ? "C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd"
          : undefined,
      ),
      Effect.map((result) => {
        expect(result.stdout).toBe("[]");
      }),
    );
  });

  it.effect("types spawn failures that the platform spawner throws synchronously", () =>
    Effect.gen(function* () {
      // File-valued PATH entries make spawn throw ENOTDIR synchronously, arriving through Effect.callback as a defect.
      const defect = Object.assign(new Error("spawn jj ENOTDIR"), { code: "ENOTDIR" });
      const spawner = makeSpawner(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      );

      const error = yield* runWith(spawner)({
        command: "jj",
        args: ["--version"],
        cwd: "/repo",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessSpawnError");
      if (error._tag !== "ProcessSpawnError") {
        return expect.fail("Expected ProcessSpawnError");
      }
      expect(error).toMatchObject({ command: "jj", argumentCount: 1, cwd: "/repo" });
      expect(error.cause).toBe(defect);
    }),
  );

  it.effect("fails when output exceeds max buffer in default mode", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessOutputLimitError");
      if (error._tag !== "ProcessOutputLimitError") {
        return expect.fail("Expected ProcessOutputLimitError");
      }
      expect(error).toMatchObject({
        stream: "stdout",
        maxBytes: 128,
        observedBytes: 2048,
      });
      expect(error.message).toBe(
        "Process 'fake' stdout produced 2048 bytes, exceeding the 128 byte limit",
      );
    }),
  );

  it.effect("accepts output at the byte limit followed by an empty chunk", () =>
    Effect.gen(function* () {
      const output = new TextEncoder().encode("exactly");
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.make(output, new Uint8Array()),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["exact-limit"],
        maxOutputBytes: output.byteLength,
      });

      expect(result.stdout).toBe("exactly");
    }),
  );

  it.effect("fails fast on output limit before timeout for long-running output", () =>
    Effect.gen(function* () {
      const textChunk = "x".repeat(64);
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.fromIterable(Array.from({ length: 10 }, () => textChunk)).pipe(
              Stream.encodeText,
            ),
            exitCode: Effect.never,
          }),
        ),
      );

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["spam-stdout"],
        maxOutputBytes: 128,
        timeout: "2 seconds",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProcessRunner.ProcessOutputLimitError);
    }),
  );

  it.effect("truncates output when outputMode is truncate", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
        outputMode: "truncate",
      });

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(128);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
    }),
  );

  it.effect("writes stdin before waiting for exit", () =>
    Effect.gen(function* () {
      const stdinWritten = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: "stdin payload",
            stdin: Sink.forEach((chunk: Uint8Array) => {
              const text = decoder.decode(chunk, { stream: true });
              return text.includes("stdin payload")
                ? Deferred.succeed(stdinWritten, undefined)
                : Effect.void;
            }),
            exitCode: Deferred.await(stdinWritten).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdin-echo"],
        stdin: "stdin payload",
      });

      expect(result.stdout).toBe("stdin payload");
      expect(result.code).toBe(0);
    }),
  );
});

describe("isWindowsCommandNotFound", () => {
  it.effect("matches the localized German cmd.exe error text", () =>
    Effect.gen(function* () {
      const isCommandNotFound = yield* ProcessRunner.isWindowsCommandNotFound(
        1,
        "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      expect(isCommandNotFound).toBe(true);
    }),
  );
});
