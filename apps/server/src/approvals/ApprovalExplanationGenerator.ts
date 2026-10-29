// @effect-diagnostics nodeBuiltinImport:off - The persistent worker adapter owns duplex Node stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { ApprovalExplanationContent, TextGenerationError } from "@t3tools/contracts";
import { buildApprovalExplanationPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

const responseSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ id: Schema.String, content: ApprovalExplanationContent }),
    Schema.Struct({
      id: Schema.String,
      error: Schema.Literals(["invalid_request", "generation_failed", "internal_error"]),
    }),
  ]),
);
const decodeResponse = Schema.decodeUnknownSync(responseSchema);

export class ApprovalExplanationGenerator extends Context.Service<
  ApprovalExplanationGenerator,
  {
    readonly generate: (input: {
      readonly cwd: string;
      readonly command: string;
      readonly workingDirectory?: string | undefined;
      readonly reason?: string | undefined;
    }) => Effect.Effect<ApprovalExplanationContent, TextGenerationError>;
  }
>()("t3/approvals/ApprovalExplanationGenerator") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let sequence = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: ApprovalExplanationContent) => void;
      reject: (error: Error) => void;
    }
  >();

  const start = () => {
    const executable = process.env.T3CODE_APPROVAL_EXPLANATION_WORKER?.trim();
    if (!executable) throw new Error("Approval worker is not configured");
    const worker = NodeChildProcess.spawn(executable, [], { windowsHide: true, stdio: "pipe" });
    child = worker;
    const reader = NodeReadline.createInterface({ input: worker.stdout });
    let diagnosticBytes = 0;
    const onDiagnostic = (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
    };
    const fail = (reason: string) => {
      if (child !== worker) return;
      child = undefined;
      reader.close();
      worker.stderr.off("data", onDiagnostic);
      worker.stderr.resume();
      worker.stdin.destroy();
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
      const detail = diagnosticBytes ? `${reason} (worker wrote diagnostics)` : reason;
      for (const request of pending.values()) request.reject(new Error(detail));
      pending.clear();
    };
    worker.stderr.on("data", onDiagnostic);
    worker.on("error", () => fail("Approval worker could not start"));
    worker.on("exit", () => fail("Approval worker exited"));
    worker.stdin.on("error", () => fail("Approval worker input failed"));
    worker.stdout.on("error", () => fail("Approval worker output failed"));
    worker.stderr.on("error", () => fail("Approval worker diagnostics failed"));
    reader.on("line", (line) => {
      try {
        const response = decodeResponse(line);
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if ("content" in response) request.resolve(response.content);
        else request.reject(new Error(`Approval worker: ${response.error}`));
      } catch {
        fail("Approval worker returned an invalid response");
      }
    });
    return worker;
  };

  yield* Effect.addFinalizer(() => Effect.sync(() => child?.stdin.end()));

  const generate = Effect.fn("ApprovalExplanationGenerator.generate")(function* (input: {
    readonly cwd: string;
    readonly command: string;
    readonly workingDirectory?: string | undefined;
    readonly reason?: string | undefined;
  }) {
    const apiKey = (yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateApprovalExplanation",
            detail: "Approval explanation settings could not be read.",
            cause,
          }),
      ),
    )).approvalExplanationApiKey;
    if (!apiKey) {
      return yield* new TextGenerationError({
        operation: "generateApprovalExplanation",
        detail: "Approval explanation API key is not configured.",
      });
    }
    const prompt = buildApprovalExplanationPrompt(input).prompt;
    return yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<ApprovalExplanationContent>((resolve, reject) => {
          if (signal.aborted) throw new Error("Approval generation cancelled");
          const worker = child ?? start();
          const id = String(++sequence);
          const abort = () => {
            pending.delete(id);
            worker.stdin.write(`${JSON.stringify({ kind: "cancel", id })}\n`);
            reject(new Error("Approval generation cancelled"));
          };
          signal.addEventListener("abort", abort, { once: true });
          pending.set(id, {
            resolve: (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            reject: (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          });
          worker.stdin.write(`${JSON.stringify({ kind: "generate", id, key: apiKey, prompt })}\n`);
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateApprovalExplanation",
          detail: "Approval explanation worker failed or is unavailable.",
          cause,
        }),
    });
  });

  return ApprovalExplanationGenerator.of({ generate });
});

export const layer = Layer.effect(ApprovalExplanationGenerator, make);
