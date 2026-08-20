import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

let exitChild: () => unknown = () => undefined,
  taskkillCalls = 0;
const require = NodeModule.createRequire(import.meta.url);
const mutableChildProcess = require("node:child_process") as typeof NodeChildProcess;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

it.layer(NodeServices.layer)("NodeChildProcessSpawner", (it) => {
  it.effect("ignores a synchronous taskkill launch error after a non-zero exit", () => {
    const originalSpawn = mutableChildProcess.spawn;
    const originalExec = mutableChildProcess.exec;
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        taskkillCalls = 0;
        mutableChildProcess.spawn = (() => {
          const child = new NodeEvents.EventEmitter() as unknown as NodeChildProcess.ChildProcess;
          Object.assign(child, { pid: 1, stdin: null, stdout: null, stderr: null });
          exitChild = () => child.emit("exit", 1, null);
          queueMicrotask(() => child.emit("spawn"));
          return child;
        }) as typeof NodeChildProcess.spawn;
        mutableChildProcess.exec = ((...args: Parameters<typeof originalExec>) => {
          if (typeof args[0] !== "string" || !args[0].startsWith("taskkill "))
            return originalExec(...args);
          if (++taskkillCalls === 1) throw new Error("taskkill launch failed");
          return {} as ReturnType<typeof originalExec>;
        }) as typeof NodeChildProcess.exec;
        NodeModule.syncBuiltinESMExports();
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      });
      const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        ChildProcess.make("test"),
      );
      exitChild();
      assert.strictEqual(yield* handle.exitCode, 1);
      assert.strictEqual(taskkillCalls, 1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mutableChildProcess.spawn = originalSpawn;
          mutableChildProcess.exec = originalExec;
          NodeModule.syncBuiltinESMExports();
          Object.defineProperty(process, "platform", platformDescriptor);
        }),
      ),
    );
  });
});
