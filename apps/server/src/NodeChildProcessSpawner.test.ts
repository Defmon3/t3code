import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

let exitChild: (code: number) => void = () => undefined;
let spawnedOptions: NodeChildProcess.SpawnOptions[] = [];
let taskkillOptions: NodeChildProcess.ExecOptions[] = [];
const require = NodeModule.createRequire(import.meta.url);
const mutableChildProcess = require("node:child_process") as typeof NodeChildProcess;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

const makeChild = () => {
  const child = new NodeEvents.EventEmitter() as unknown as NodeChildProcess.ChildProcess;
  Object.assign(child, { pid: 1, stdin: null, stdout: null, stderr: null, kill: () => true });
  exitChild = (code) => child.emit("exit", code, null);
  queueMicrotask(() => child.emit("spawn"));
  return child;
};

describe("NodeChildProcessSpawner", () => {
  it.effect(
    "hides spawned processes and ignores a taskkill launch error after a non-zero exit",
    () => {
      const originalSpawn = mutableChildProcess.spawn;
      const originalExec = mutableChildProcess.exec;
      return Effect.gen(function* () {
        yield* Effect.sync(() => {
          spawnedOptions = [];
          taskkillOptions = [];
          mutableChildProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
            spawnedOptions.push(args[2]);
            return makeChild();
          }) as typeof NodeChildProcess.spawn;
          mutableChildProcess.exec = ((...args: Parameters<typeof originalExec>) => {
            if (typeof args[0] !== "string" || !args[0].startsWith("taskkill "))
              return originalExec(...args);
            taskkillOptions.push(args[1] as NodeChildProcess.ExecOptions);
            throw new Error("taskkill launch failed");
          }) as typeof NodeChildProcess.exec;
          NodeModule.syncBuiltinESMExports();
          Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
        });
        const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make("test"),
        );
        exitChild(1);
        assert.strictEqual(yield* handle.exitCode, 1);
        assert.strictEqual(spawnedOptions[0]?.windowsHide, true);
        assert.deepStrictEqual(taskkillOptions, [{ windowsHide: true }]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            mutableChildProcess.spawn = originalSpawn;
            mutableChildProcess.exec = originalExec;
            NodeModule.syncBuiltinESMExports();
            Object.defineProperty(process, "platform", platformDescriptor);
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("keeps explicitly detached processes visible", () => {
    const originalSpawn = mutableChildProcess.spawn;
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        spawnedOptions = [];
        mutableChildProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
          spawnedOptions.push(args[2]);
          return makeChild();
        }) as typeof NodeChildProcess.spawn;
        NodeModule.syncBuiltinESMExports();
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      });
      const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        ChildProcess.make("test", [], { detached: true }),
      );
      exitChild(0);
      assert.strictEqual(yield* handle.exitCode, 0);
      assert.strictEqual(spawnedOptions[0]?.windowsHide, false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mutableChildProcess.spawn = originalSpawn;
          NodeModule.syncBuiltinESMExports();
          Object.defineProperty(process, "platform", platformDescriptor);
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("hides taskkill when explicitly terminating a process", () => {
    const originalSpawn = mutableChildProcess.spawn;
    const originalExec = mutableChildProcess.exec;
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        taskkillOptions = [];
        mutableChildProcess.spawn = (() => makeChild()) as typeof NodeChildProcess.spawn;
        mutableChildProcess.exec = ((...args: Parameters<typeof originalExec>) => {
          if (typeof args[0] !== "string" || !args[0].startsWith("taskkill "))
            return originalExec(...args);
          taskkillOptions.push(args[1] as NodeChildProcess.ExecOptions);
          const callback = args[2];
          if (callback === undefined) throw new Error("Expected taskkill to provide a callback");
          queueMicrotask(() => {
            callback(null, "", "");
            exitChild(0);
          });
          return {} as ReturnType<typeof originalExec>;
        }) as typeof NodeChildProcess.exec;
        NodeModule.syncBuiltinESMExports();
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      });
      const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        ChildProcess.make("test"),
      );
      yield* handle.kill();
      assert.deepStrictEqual(taskkillOptions, [{ windowsHide: true }]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mutableChildProcess.spawn = originalSpawn;
          mutableChildProcess.exec = originalExec;
          NodeModule.syncBuiltinESMExports();
          Object.defineProperty(process, "platform", platformDescriptor);
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
  });
});
