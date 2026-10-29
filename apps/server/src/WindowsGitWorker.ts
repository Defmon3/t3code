// @effect-diagnostics nodeBuiltinImport:off -- Node worker threads isolate Windows process creation.
import * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class GitWorkerError extends Schema.TaggedError<GitWorkerError>()("GitWorkerError", {
  phase: Schema.Literals(["spawn", "stdin", "stdout", "stderr", "worker"]),
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {}

export class GitWorkerOutputLimitError extends Schema.TaggedError<GitWorkerOutputLimitError>()(
  "GitWorkerOutputLimitError",
  {
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {}

const Output = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  stdout: Schema.Uint8Array,
  stderr: Schema.Uint8Array,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});

const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.Number,
    result: Schema.Union([
      Schema.Struct({ type: Schema.Literal("output"), output: Output }),
      Schema.Struct({ type: Schema.Literal("error"), error: GitWorkerError }),
      Schema.Struct({ type: Schema.Literal("limit"), error: GitWorkerOutputLimitError }),
    ]),
  }),
);

interface Command {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean;
  readonly stdin?: string | undefined;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
}

export class WindowsGitWorker extends Context.Service<
  WindowsGitWorker,
  {
    readonly run: (
      input: Command,
    ) => Effect.Effect<typeof Output.Type, GitWorkerError | GitWorkerOutputLimitError>;
  }
>()("t3/WindowsGitWorker") {}

const source = `
const { parentPort } = require("node:worker_threads");
const cp = require("node:child_process");
const jobs = new Map();
let closing = false;
const failure = (error, phase) => ({
  _tag: "GitWorkerError", phase, message: String(error.message ?? error),
  ...(error.code === undefined ? {} : { code: String(error.code) }),
});
const finish = (id, result) => {
  const job = jobs.get(id);
  if (job === undefined) return;
  clearTimeout(job.forceKill);
  jobs.delete(id);
  parentPort.postMessage({ id, result });
  if (closing && jobs.size === 0) parentPort.close();
};
const cancel = (id) => {
  const job = jobs.get(id);
  const child = job?.child;
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null || job.cancelling) return;
  job.cancelling = true;
  if (process.platform === "win32") {
    const killer = cp.spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    });
    killer.on("error", (error) => {
      job.error ??= failure(error, "worker");
      child.kill("SIGKILL");
    });
    killer.on("exit", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        job.error ??= failure(new Error("taskkill exited with code " + code), "worker");
        child.kill("SIGKILL");
      }
    });
  } else {
    child.kill("SIGTERM");
    job.forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
  }
};
process.on("uncaughtException", (error) => {
  closing = true;
  for (const [id, job] of jobs) {
    job.error ??= failure(error, "worker");
    cancel(id);
  }
  if (jobs.size === 0) parentPort.close();
});
parentPort.on("message", (message) => {
  if (message.type === "cancel") { cancel(message.id); return; }
  if (message.type === "shutdown") {
    closing = true;
    for (const id of jobs.keys()) cancel(id);
    if (jobs.size === 0) parentPort.close();
    return;
  }
  const { id, input } = message;
  if (closing) {
    parentPort.postMessage({ id, result: { type: "error", error: failure(new Error("Git worker is closing"), "worker") } });
    return;
  }
  const job = { buffers: { stdout: [], stderr: [] }, bytes: { stdout: 0, stderr: 0 } };
  jobs.set(id, job);
  const collect = (stream, chunk) => {
    const bytes = job.bytes[stream];
    job.bytes[stream] += chunk.length;
    const remaining = input.maxOutputBytes - bytes;
    if (remaining > 0) job.buffers[stream].push(chunk.subarray(0, remaining));
    if (input.outputMode === "error" && job.bytes[stream] > input.maxOutputBytes && !job.error && !job.limit) {
      job.limit = {
        _tag: "GitWorkerOutputLimitError", stream, maxBytes: input.maxOutputBytes,
        observedBytes: job.bytes[stream],
      };
      cancel(id);
    }
  };
  let child;
  try {
    child = cp.spawn(input.command, input.args, {
      cwd: input.cwd, env: input.env, shell: input.shell,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    job.child = child;
  } catch (error) {
    finish(id, { type: "error", error: failure(error, "spawn") });
    return;
  }
  child.on("error", (error) => { job.error ??= failure(error, "spawn"); });
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  for (const stream of ["stdout", "stderr"]) {
    child[stream].on("error", (error) => { job.error ??= failure(error, stream); cancel(id); });
  }
  child.stdin.on("error", (error) => {
    if (input.stdin !== undefined) { job.error ??= failure(error, "stdin"); cancel(id); }
  });
  child.on("close", (code) => {
    if (job.limit) { finish(id, { type: "limit", error: job.limit }); return; }
    if (job.error) { finish(id, { type: "error", error: job.error }); return; }
    finish(id, { type: "output", output: {
      code,
      stdout: Buffer.concat(job.buffers.stdout),
      stderr: Buffer.concat(job.buffers.stderr),
      stdoutTruncated: job.bytes.stdout > input.maxOutputBytes,
      stderrTruncated: job.bytes.stderr > input.maxOutputBytes,
    } });
  });
  if (input.stdin !== undefined) child.stdin.end(input.stdin);
});
`;

const make = Effect.gen(function* () {
  let worker = yield* Effect.try({
    try: () => new NodeWorkerThreads.Worker(source, { eval: true }),
    catch: (cause) => new GitWorkerError({ phase: "worker", message: String(cause) }),
  });
  type Result = Effect.Effect<typeof Output.Type, GitWorkerError | GitWorkerOutputLimitError>;
  const pending = new Map<
    number,
    { readonly resume: (result: Result) => void; readonly end: () => void }
  >();
  let stopped = Promise.withResolvers<void>();
  let nextId = 0;
  let failed: GitWorkerError | undefined;
  let closing = false;
  const fail = (message: string) => {
    failed = new GitWorkerError({ phase: "worker", message });
    for (const entry of pending.values()) {
      entry.resume(Effect.fail(failed));
      entry.end();
    }
    pending.clear();
  };
  const receive = (message: unknown) => {
    let reply: ReturnType<typeof decodeReply>;
    try {
      reply = decodeReply(message);
    } catch (cause) {
      fail(`Invalid Git worker reply: ${String(cause)}`);
      worker.postMessage({ type: "shutdown" }, []);
      return;
    }
    const entry = pending.get(reply.id);
    if (entry === undefined) return;
    pending.delete(reply.id);
    entry.end();
    if (pending.size === 0) worker.unref();
    const result = reply.result;
    entry.resume(
      result.type === "output" ? Effect.succeed(result.output) : Effect.fail(result.error),
    );
  };
  const observe = () => {
    worker.on("message", receive);
    worker.on("error", (cause) => fail(cause.message));
    worker.on("exit", (code) => {
      fail(`Git worker exited with code ${code}`);
      stopped.resolve();
    });
    worker.unref();
  };
  observe();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      worker.ref();
      worker.postMessage({ type: "shutdown" }, []);
      await stopped.promise;
    }),
  );
  return WindowsGitWorker.of({
    run: Effect.fn("WindowsGitWorker.run")(function (input: Command) {
      return Effect.callback<typeof Output.Type, GitWorkerError | GitWorkerOutputLimitError>(
        (resume) => {
          if (closing) {
            resume(
              Effect.fail(
                failed ?? new GitWorkerError({ phase: "worker", message: "Git worker is closing" }),
              ),
            );
            return;
          }
          if (failed !== undefined) {
            if (worker.threadId !== -1) {
              resume(Effect.fail(failed));
              return;
            }
            try {
              worker = new NodeWorkerThreads.Worker(source, { eval: true });
              stopped = Promise.withResolvers<void>();
              failed = undefined;
              observe();
            } catch (cause) {
              resume(Effect.fail(new GitWorkerError({ phase: "worker", message: String(cause) })));
              return;
            }
          }
          const id = ++nextId;
          const ended = Promise.withResolvers<void>();
          pending.set(id, { resume, end: () => ended.resolve() });
          worker.ref();
          try {
            worker.postMessage({ type: "run", id, input }, []);
          } catch (cause) {
            pending.delete(id);
            ended.resolve();
            if (pending.size === 0) worker.unref();
            resume(Effect.fail(new GitWorkerError({ phase: "worker", message: String(cause) })));
          }
          return Effect.promise(async () => {
            if (!pending.has(id)) return;
            worker.postMessage({ type: "cancel", id }, []);
            await ended.promise;
          });
        },
      );
    }),
  });
}).pipe(Effect.uninterruptible);

export const layer = Layer.effect(WindowsGitWorker, make);
