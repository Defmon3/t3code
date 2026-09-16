import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

function makeMockDetachedHandle(onUnref: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const testLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
}) => {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle(input.onUnref);
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer))),
    Layer.succeed(HostProcessPlatform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launches the default browser through the platform command", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "xdg-open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      testLayer({
        platform: "linux",
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

it.effect("launches an installed editor with platform-safe arguments", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "vscode",
        cwd: "C:\\workspace with spaces\\src\\index.ts:12:4",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "code" ? "C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, '^"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD^"');
    assert.deepEqual(spawned.args, [
      '^"--goto^"',
      '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
    ]);
    assert.equal(spawned.options.shell, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers editors through the service API", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memoizes editor discovery and refreshes after the cache window", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.sync(() => {
              statCalls += 1;
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const first = yield* launcher.resolveAvailableEditors();
    assert.equal(first.includes("vscode"), true);
    const statCallsAfterFirstScan = statCalls;
    assert.isAbove(statCallsAfterFirstScan, 0);

    yield* TestClock.adjust("31 seconds");
    const second = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...second], [...first]);
    assert.equal(statCalls, statCallsAfterFirstScan);

    yield* TestClock.adjust("30 seconds");
    yield* launcher.resolveAvailableEditors();
    assert.isAbove(statCalls, statCallsAfterFirstScan);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-cache-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

it.effect("shares one editor discovery between concurrent callers", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const discoveryStarted = Deferred.makeUnsafe<void>();
  const releaseDiscovery = Deferred.makeUnsafe<void>();
  let firstStat = true;
  let statCalls = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              if (firstStat) {
                firstStat = false;
                yield* Deferred.succeed(discoveryStarted, undefined);
                yield* Deferred.await(releaseDiscovery);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const first = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Deferred.await(discoveryStarted);
    const second = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(statCalls, 1);
    yield* Deferred.succeed(releaseDiscovery, undefined);

    const [firstEditors, secondEditors] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);

    assert.equal(firstEditors.includes("vscode"), true);
    assert.deepEqual([...secondEditors], [...firstEditors]);
    assert.isAbove(statCalls, 0);
    const statCallsAfterSharedDiscovery = statCalls;
    const cachedEditors = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...cachedEditors], [...firstEditors]);
    assert.equal(statCalls, statCallsAfterSharedDiscovery);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-concurrent-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("evicts a timed out editor discovery so a later caller can retry", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const discoveryStarted = Deferred.makeUnsafe<void>();
  const neverReleaseDiscovery = Deferred.makeUnsafe<void>();
  let firstStat = true;
  let statCalls = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              if (firstStat) {
                firstStat = false;
                yield* Deferred.succeed(discoveryStarted, undefined);
                yield* Deferred.await(neverReleaseDiscovery);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const first = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Deferred.await(discoveryStarted);
    const second = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(statCalls, 1);

    yield* TestClock.adjust("5 seconds");
    const [firstEditors, secondEditors] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    assert.deepEqual([...firstEditors], []);
    assert.deepEqual([...secondEditors], []);

    const retriedEditors = yield* launcher.resolveAvailableEditors();
    assert.equal(retriedEditors.includes("vscode"), true);
    const statCallsAfterRetry = statCalls;
    yield* launcher.resolveAvailableEditors();
    assert.equal(statCalls, statCallsAfterRetry);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-timeout-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

it.effect("releases callers and retries after a defective editor discovery", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const discoveryStarted = Deferred.makeUnsafe<void>();
  let firstStat = true;
  let statCalls = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              if (firstStat) {
                firstStat = false;
                yield* Deferred.succeed(discoveryStarted, undefined);
                return yield* Effect.die(new Error("editor discovery failed"));
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const first = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Deferred.await(discoveryStarted);

    const firstEditors = yield* Fiber.join(first);
    assert.deepEqual([...firstEditors], []);

    const retriedEditors = yield* launcher.resolveAvailableEditors();
    assert.equal(retriedEditors.includes("vscode"), true);
    assert.isAbove(statCalls, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-defect-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("continues editor discovery after an interrupted caller", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const discoveryStarted = Deferred.makeUnsafe<void>();
  const releaseDiscovery = Deferred.makeUnsafe<void>();
  let firstStat = true;
  let statCalls = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              if (firstStat) {
                firstStat = false;
                yield* Deferred.succeed(discoveryStarted, undefined);
                yield* Deferred.await(releaseDiscovery);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const interruptedCaller = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Deferred.await(discoveryStarted);
    yield* Fiber.interrupt(interruptedCaller);

    const reconnect = yield* launcher.resolveAvailableEditors().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(statCalls, 1);
    yield* Deferred.succeed(releaseDiscovery, undefined);

    const editors = yield* Fiber.join(reconnect);
    assert.equal(editors.includes("vscode"), true);
    const statCallsAfterDiscovery = statCalls;
    const cachedEditors = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...cachedEditors], [...editors]);
    assert.equal(statCalls, statCallsAfterDiscovery);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-interrupt-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: "" } }))),
);
