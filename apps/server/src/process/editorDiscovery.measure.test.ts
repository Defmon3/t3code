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
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

const makeMockDetachedHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

it.effect("measures concurrent cold editor discovery amplification", () => {
  const releaseDiscovery = Deferred.makeUnsafe<void>();
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  let statCalls = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              yield* Deferred.await(releaseDiscovery);
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(makeMockDetachedHandle)),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const startedAt = performance.now();
    const callers = yield* Effect.all(
      Array.from({ length: 20 }, () => launcher.resolveAvailableEditors().pipe(Effect.forkChild)),
    );
    yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow);
    const probesBeforeRelease = statCalls;
    yield* Deferred.succeed(releaseDiscovery, undefined);
    yield* Effect.all(callers.map(Fiber.join));
    const elapsedMs = performance.now() - startedAt;
    console.log(
      `EDITOR_DISCOVERY_MEASURE ${JSON.stringify({ callers: 20, probesBeforeRelease, totalProbes: statCalls, elapsedMs })}`,
    );
    assert.isAbove(statCalls, 0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-measure",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});
