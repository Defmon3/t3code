import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ChildProcessShutdownSignal = "SIGTERM" | "SIGKILL";

export interface BoundedChildProcessSpawnerOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

const normalizedDelay = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);

const isProcessAlive = (pid: ChildProcessSpawner.ProcessId) =>
  Effect.sync(() => {
    try {
      globalThis.process.kill(Number(pid), 0);
      return true;
    } catch (cause) {
      return !(cause instanceof Error && Reflect.get(cause, "code") === "ESRCH");
    }
  });

const isStillRunning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.isRunning.pipe(Effect.orElseSucceed(() => true));

const waitUntilStopped = Effect.fn("BoundedChildProcessSpawner.waitUntilStopped")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMs: number,
  pollIntervalMs: number,
) {
  let remainingMs = timeoutMs;

  while ((yield* isStillRunning(handle)) && (yield* isProcessAlive(handle.pid))) {
    if (remainingMs <= 0) return false;
    const delayMs = Math.min(pollIntervalMs, remainingMs);
    yield* Effect.sleep(delayMs);
    remainingMs -= delayMs;
  }

  return true;
});

export const make = (
  delegate: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BoundedChildProcessSpawnerOptions = {},
) => {
  const termGraceMs = normalizedDelay(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
  const killGraceMs = normalizedDelay(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const pollIntervalMs = Math.max(
    1,
    normalizedDelay(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  );
  const sendSignal = Effect.fn("BoundedChildProcessSpawner.sendSignal")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    signal: ChildProcess.Signal,
  ) {
    yield* handle.kill({ killSignal: signal }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to signal child process", {
          cause,
          pid: Number(handle.pid),
          signal,
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
  });

  const killForShutdown = Effect.fn("BoundedChildProcessSpawner.killForShutdown")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
  ) {
    if (!(yield* isStillRunning(handle))) return;

    yield* sendSignal(handle, "SIGTERM");
    const stoppedAfterInitialSignal = yield* waitUntilStopped(handle, termGraceMs, pollIntervalMs);
    if (stoppedAfterInitialSignal) return;

    yield* sendSignal(handle, "SIGKILL");
    if (yield* waitUntilStopped(handle, killGraceMs, pollIntervalMs)) return;

    yield* Effect.logWarning("Child process did not stop after SIGKILL grace period", {
      pid: Number(handle.pid),
      killGraceMs,
    });
  });

  const shutdown = Effect.fn("BoundedChildProcessSpawner.shutdown")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    isReferenced: () => boolean,
  ) {
    if (isReferenced()) {
      yield* killForShutdown(handle);
    }
  });

  const spawn = Effect.fn("BoundedChildProcessSpawner.spawn")(function* (
    command: ChildProcess.Command,
  ) {
    const childScope = yield* Scope.make("sequential");
    const spawned = yield* delegate
      .spawn(command)
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.exit);

    if (Exit.isFailure(spawned)) {
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
      return yield* Effect.failCause(spawned.cause);
    }

    const delegateHandle = spawned.value;
    let referenced = true;
    const handle = ChildProcessSpawner.makeHandle({
      pid: delegateHandle.pid,
      exitCode: delegateHandle.exitCode,
      isRunning: delegateHandle.isRunning,
      kill: delegateHandle.kill,
      stdin: delegateHandle.stdin,
      stdout: delegateHandle.stdout,
      stderr: delegateHandle.stderr,
      all: delegateHandle.all,
      getInputFd: delegateHandle.getInputFd,
      getOutputFd: delegateHandle.getOutputFd,
      unref: delegateHandle.unref.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            referenced = false;
          }),
        ),
        Effect.map((reref) =>
          reref.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                referenced = true;
              }),
            ),
          ),
        ),
      ),
    });
    yield* Effect.addFinalizer(() => shutdown(delegateHandle, () => referenced));
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.andThen(Scope.close(childScope, Exit.void)),
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach({ startImmediately: true }),
    );

    return handle;
  }, Effect.uninterruptible);

  return ChildProcessSpawner.make(spawn);
};

export const layer = (options?: BoundedChildProcessSpawnerOptions) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (delegate) => make(delegate, options)),
  );
