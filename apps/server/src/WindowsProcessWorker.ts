// @effect-diagnostics nodeBuiltinImport:off -- Node worker threads isolate Windows process creation.
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ProcessWorkerError extends Schema.TaggedError<ProcessWorkerError>()(
  "ProcessWorkerError",
  {
    phase: Schema.Literals(["spawn", "stdin", "stdout", "stderr", "worker"]),
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
  },
) {}

export class ProcessWorkerOutputLimitError extends Schema.TaggedError<ProcessWorkerOutputLimitError>()(
  "ProcessWorkerOutputLimitError",
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

const BufferedReply = Schema.Struct({
  id: Schema.Number,
  result: Schema.Union([
    Schema.Struct({ type: Schema.Literal("output"), output: Output }),
    Schema.Struct({ type: Schema.Literal("error"), error: ProcessWorkerError }),
    Schema.Struct({ type: Schema.Literal("limit"), error: ProcessWorkerOutputLimitError }),
  ]),
});

const ProcessSignal = Schema.declare<NodeJS.Signals>(
  (value): value is NodeJS.Signals =>
    typeof value === "string" && Object.hasOwn(NodeOS.constants.signals, value),
);
const StreamingReply = Schema.Union([
  Schema.Struct({ id: Schema.Number, stream: Schema.Literal("stdout"), data: Schema.Uint8Array }),
  Schema.Struct({ id: Schema.Number, stream: Schema.Literal("end") }),
  Schema.Struct({
    id: Schema.Number,
    stream: Schema.Literal("written"),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ id: Schema.Number, stream: Schema.Literal("error"), error: Schema.String }),
  Schema.Struct({
    id: Schema.Number,
    stream: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(ProcessSignal),
  }),
]);
const decodeReply = Schema.decodeUnknownSync(Schema.Union([BufferedReply, StreamingReply]));

interface Command {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean;
  readonly stdin?: string | undefined;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly forceKillAfterMs?: number | undefined;
}

export class WindowsProcessWorker extends Context.Service<
  WindowsProcessWorker,
  {
    readonly run: (
      input: Command,
    ) => Effect.Effect<typeof Output.Type, ProcessWorkerError | ProcessWorkerOutputLimitError>;
    readonly spawn: (input: SpawnOptions) => SpawnedProcess;
  }
>()("t3/WindowsProcessWorker") {}

class WorkerProcess extends NodeEvents.EventEmitter implements SpawnedProcess {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.Readable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private exited = false;
  private writeCallback: ((error?: Error | null) => void) | undefined;
  private readonly send: (message: object) => void;

  constructor(send: (message: object) => void) {
    super();
    this.send = send;
    this.stdin = new NodeStream.Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.writeCallback = callback;
        this.send({ type: "write", data: chunk });
      },
      final: (callback) => {
        this.send({ type: "end" });
        callback();
      },
    });
    this.stdout = new NodeStream.Readable({ read: () => this.send({ type: "resume" }) });
  }

  kill(_signal: NodeJS.Signals): boolean {
    if (this.killed || this.exited) return false;
    this.killed = true;
    this.send({ type: "cancel" });
    return true;
  }

  receive(message: typeof StreamingReply.Type): void {
    if (message.stream === "stdout") {
      if (this.stdout.push(Buffer.from(message.data))) this.send({ type: "resume" });
    } else if (message.stream === "end") {
      this.stdout.push(null);
    } else if (message.stream === "written") {
      const callback = this.writeCallback;
      this.writeCallback = undefined;
      callback?.(message.error === undefined ? null : new Error(message.error));
    } else if (message.stream === "error") {
      this.fail(new Error(message.error));
    } else if (message.stream === "exit") {
      this.exited = true;
      this.exitCode = message.code;
      this.signalCode = message.signal;
      this.stdout.push(null);
      this.writeCallback?.(new Error("Process exited before stdin was written"));
      this.writeCallback = undefined;
      this.stdin.destroy();
      this.emit("exit", this.exitCode, this.signalCode);
    }
  }

  fail(error: Error): void {
    this.writeCallback?.(error);
    this.writeCallback = undefined;
    this.emit("error", error);
  }

  workerFailed(error: Error): void {
    this.exited = true;
    this.stdout.push(null);
    this.stdin.destroy();
    this.fail(error);
    this.emit("exit", null, null);
  }
}

const source = `
const { parentPort } = require("node:worker_threads");
const cp = require("node:child_process");
const jobs = new Map();
let closing = false;
const failure = (error, phase) => ({
  _tag: "ProcessWorkerError", phase, message: String(error.message ?? error),
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
  if (!child || job.cancelling) return;
  job.cancelling = true;
  if (job.streaming) {
    child.stdout.resume();
    child.stdin.destroy();
  }
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (job.forceKillAfterMs !== undefined) {
    job.forceKill = setTimeout(() => child.kill("SIGKILL"), job.forceKillAfterMs);
  }
  if (process.platform === "win32") {
    const killer = cp.spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    });
    killer.on("error", (error) => {
      job.error ??= failure(error, "worker");
      if (job.streaming) parentPort.postMessage({ id, stream: "error", error: job.error.message });
      child.kill("SIGKILL");
    });
    killer.on("exit", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        job.error ??= failure(new Error("taskkill exited with code " + code), "worker");
        if (job.streaming) parentPort.postMessage({ id, stream: "error", error: job.error.message });
        child.kill("SIGKILL");
      }
    });
  } else {
    child.kill("SIGTERM");
    job.forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  }
};
process.on("uncaughtException", (error) => {
  closing = true;
  for (const [id, job] of jobs) {
    job.error ??= failure(error, "worker");
    if (job.streaming) parentPort.postMessage({ id, stream: "error", error: job.error.message });
    cancel(id);
  }
  if (jobs.size === 0) parentPort.close();
});
parentPort.on("message", (message) => {
  if (message.type === "cancel") { cancel(message.id); return; }
  if (message.type === "write") {
    const job = jobs.get(message.id);
    if (!job?.child) { parentPort.postMessage({ id: message.id, stream: "written", error: "Process has exited" }); return; }
    job.child.stdin.write(Buffer.from(message.data), (error) => parentPort.postMessage({ id: message.id, stream: "written", error: error?.message }));
    return;
  }
  if (message.type === "end") { jobs.get(message.id)?.child?.stdin.end(); return; }
  if (message.type === "resume") { jobs.get(message.id)?.child?.stdout.resume(); return; }
  if (message.type === "shutdown") {
    closing = true;
    for (const id of jobs.keys()) cancel(id);
    if (jobs.size === 0) parentPort.close();
    return;
  }
  const { id, input } = message;
  if (closing) {
    parentPort.postMessage({ id, result: { type: "error", error: failure(new Error("Process worker is closing"), "worker") } });
    return;
  }
  const job = { buffers: { stdout: [], stderr: [] }, bytes: { stdout: 0, stderr: 0 }, forceKillAfterMs: input.forceKillAfterMs };
  jobs.set(id, job);
  const collect = (stream, chunk) => {
    const bytes = job.bytes[stream];
    job.bytes[stream] += chunk.length;
    const remaining = input.maxOutputBytes - bytes;
    if (remaining > 0) job.buffers[stream].push(chunk.subarray(0, remaining));
    if (input.outputMode === "error" && job.bytes[stream] > input.maxOutputBytes && !job.error && !job.limit) {
      job.limit = {
        _tag: "ProcessWorkerOutputLimitError", stream, maxBytes: input.maxOutputBytes,
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
    if (message.type === "spawn") { jobs.delete(id); parentPort.postMessage({ id, stream: "error", error: String(error.message ?? error) }); parentPort.postMessage({ id, stream: "exit", code: null, signal: null }); return; }
    finish(id, { type: "error", error: failure(error, "spawn") });
    return;
  }
  if (message.type === "spawn") {
    job.streaming = true;
    child.on("error", (error) => parentPort.postMessage({ id, stream: "error", error: String(error.message ?? error) }));
    child.stdout.on("data", (chunk) => { if (!job.cancelling) { child.stdout.pause(); parentPort.postMessage({ id, stream: "stdout", data: chunk }); } });
    child.stdout.on("end", () => parentPort.postMessage({ id, stream: "end" }));
    child.stderr.resume();
    child.stdout.on("error", (error) => { parentPort.postMessage({ id, stream: "error", error: String(error.message ?? error) }); cancel(id); });
    child.stderr.on("error", (error) => { parentPort.postMessage({ id, stream: "error", error: String(error.message ?? error) }); cancel(id); });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      clearTimeout(job.forceKill);
      jobs.delete(id);
      parentPort.postMessage({ id, stream: "exit", code, signal });
      if (closing && jobs.size === 0) parentPort.close();
    });
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
    catch: (cause) => new ProcessWorkerError({ phase: "worker", message: String(cause) }),
  });
  type Result = Effect.Effect<
    typeof Output.Type,
    ProcessWorkerError | ProcessWorkerOutputLimitError
  >;
  const pending = new Map<
    number,
    { readonly resume: (result: Result) => void; readonly end: () => void }
  >();
  const streams = new Map<number, WorkerProcess>();
  let stopped = Promise.withResolvers<void>();
  let nextId = 0;
  let failed: ProcessWorkerError | undefined;
  let closing = false;
  const fail = (message: string) => {
    failed = new ProcessWorkerError({ phase: "worker", message });
    for (const entry of pending.values()) {
      entry.resume(Effect.fail(failed));
      entry.end();
    }
    pending.clear();
    for (const stream of streams.values()) stream.workerFailed(new Error(message));
    streams.clear();
  };
  const receive = (message: unknown) => {
    let reply: ReturnType<typeof decodeReply>;
    try {
      reply = decodeReply(message);
    } catch (cause) {
      fail(`Invalid process worker reply: ${String(cause)}`);
      worker.postMessage({ type: "shutdown" }, []);
      return;
    }
    if ("stream" in reply) {
      const child = streams.get(reply.id);
      if (child === undefined) return;
      child.receive(reply);
      if (reply.stream === "exit") {
        streams.delete(reply.id);
        if (pending.size === 0 && streams.size === 0) worker.unref();
      }
      return;
    }
    const entry = pending.get(reply.id);
    if (entry === undefined) return;
    pending.delete(reply.id);
    entry.end();
    if (pending.size === 0 && streams.size === 0) worker.unref();
    const result = reply.result;
    entry.resume(
      result.type === "output" ? Effect.succeed(result.output) : Effect.fail(result.error),
    );
  };
  const observe = () => {
    worker.on("message", receive);
    worker.on("error", (cause) => fail(cause.message));
    worker.on("exit", (code) => {
      fail(`Process worker exited with code ${code}`);
      stopped.resolve();
    });
    worker.unref();
  };
  observe();
  const ensureRunning = (): ProcessWorkerError | undefined => {
    if (closing)
      return (
        failed ?? new ProcessWorkerError({ phase: "worker", message: "Process worker is closing" })
      );
    if (failed === undefined) return undefined;
    if (worker.threadId !== -1) return failed;
    try {
      worker = new NodeWorkerThreads.Worker(source, { eval: true });
      stopped = Promise.withResolvers<void>();
      failed = undefined;
      observe();
      return undefined;
    } catch (cause) {
      return new ProcessWorkerError({ phase: "worker", message: String(cause) });
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      if (worker.threadId !== -1) {
        worker.ref();
        worker.postMessage({ type: "shutdown" }, []);
      }
      await stopped.promise;
    }),
  );
  return WindowsProcessWorker.of({
    spawn: (input) => {
      const id = ++nextId;
      const child = new WorkerProcess((message) => worker.postMessage({ ...message, id }, []));
      const error = ensureRunning();
      if (error !== undefined) {
        queueMicrotask(() => child.workerFailed(new Error(error.message)));
        return child;
      }
      streams.set(id, child);
      worker.ref();
      try {
        worker.postMessage(
          {
            type: "spawn",
            id,
            input: { ...input, signal: undefined, shell: false },
          },
          [],
        );
      } catch (cause) {
        streams.delete(id);
        if (pending.size === 0 && streams.size === 0) worker.unref();
        queueMicrotask(() =>
          child.workerFailed(cause instanceof Error ? cause : new Error(String(cause))),
        );
        return child;
      }
      const abort = () => child.kill("SIGTERM");
      child.once("exit", () => input.signal.removeEventListener("abort", abort));
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
      return child;
    },
    run: Effect.fn("WindowsProcessWorker.run")(function (input: Command) {
      return Effect.callback<
        typeof Output.Type,
        ProcessWorkerError | ProcessWorkerOutputLimitError
      >((resume) => {
        const error = ensureRunning();
        if (error !== undefined) {
          resume(Effect.fail(error));
          return;
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
          if (pending.size === 0 && streams.size === 0) worker.unref();
          resume(Effect.fail(new ProcessWorkerError({ phase: "worker", message: String(cause) })));
        }
        return Effect.promise(async () => {
          if (!pending.has(id)) return;
          worker.postMessage({ type: "cancel", id }, []);
          await ended.promise;
        });
      });
    }),
  });
}).pipe(Effect.uninterruptible);

export const layer = Layer.effect(WindowsProcessWorker, make);
