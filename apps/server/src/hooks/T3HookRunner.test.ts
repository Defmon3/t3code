import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import * as T3HookRunner from "./T3HookRunner.ts";

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function decodeJson(value: string): unknown {
  return JSON.parse(value);
}

const successfulOutput = (stdout: string): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0 as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function testLayer(run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput>) {
  return Layer.effect(T3HookRunner.T3HookRunner, T3HookRunner.make()).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(ProcessRunner, ProcessRunner.of({ run })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("T3HookRunner", () => {
  it.layer(
    testLayer((input) =>
      Effect.sync(() => {
        const payload = decodeJson(input.stdin ?? "") as Record<string, unknown>;
        assert.equal(payload.hook_event_name, "PreToolUse");
        assert.equal(payload.provider, "codex");
        assert.equal(payload.tool_name, "Bash");
        assert.deepEqual(payload.tool_input, { command: "git push origin main" });
        assert.match(input.args.at(-1) ?? "", /hook\.js/);
        return successfulOutput(
          encodeJson({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: "Protected branch policy requires confirmation.",
              title: "Push protected branch?",
              description: "This updates the shared remote branch.",
            },
          }),
        );
      }),
    ),
  )("discovers a parent config and returns a Claude-compatible ask decision", (it) => {
    it.effect("evaluates the matching script", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });
        const nested = path.join(root, "packages", "app");
        const configDirectory = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDirectory, "hooks.json"),
          encodeJson({
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "command",
                      command: 'node "${T3_PROJECT_DIR}/.t3code/hook.js"',
                      timeout: 30,
                    },
                  ],
                },
              ],
            },
          }),
        );

        const runner = yield* T3HookRunner.T3HookRunner;
        const plan = yield* runner.prepare(nested);
        const decision = yield* plan.evaluatePreToolUse({
          provider: "codex",
          threadId: "thread-1",
          toolName: "Bash",
          toolInput: { command: "git push origin main" },
        });

        assert.equal(plan.configPath, path.join(configDirectory, "hooks.json"));
        assert.isTrue(plan.hasPreToolUseHooks);
        assert.deepEqual(decision, {
          decision: "ask",
          reason: "Protected branch policy requires confirmation.",
          title: "Push protected branch?",
          description: "This updates the shared remote branch.",
        });
      }),
    );
  });

  it.layer(testLayer(() => Effect.die("a non-matching hook must not execute")))(
    "filters hooks with the same matcher shape as Claude settings",
    (it) => {
      it.effect("allows a non-matching tool", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });
          const configDirectory = path.join(root, ".t3code");
          yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(configDirectory, "hooks.json"),
            encodeJson({
              hooks: {
                PreToolUse: [
                  {
                    matcher: "Write|Edit",
                    hooks: [{ type: "command", command: "never" }],
                  },
                ],
              },
            }),
          );

          const runner = yield* T3HookRunner.T3HookRunner;
          const plan = yield* runner.prepare(root);
          const decision = yield* plan.evaluatePreToolUse({
            provider: "claudeAgent",
            threadId: "thread-2",
            toolName: "Bash",
            toolInput: { command: "pwd" },
          });

          assert.deepEqual(decision, { decision: "allow" });
        }),
      );
    },
  );

  it.layer(
    testLayer(() =>
      Effect.succeed({
        ...successfulOutput(""),
        code: 2 as ProcessRunOutput["code"],
        stderr: "Blocked by repository policy.",
      }),
    ),
  )("fails closed when a hook exits with Claude's blocking status", (it) => {
    it.effect("returns deny with the script reason", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });
        const configDirectory = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDirectory, "hooks.json"),
          encodeJson({
            hooks: {
              PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy" }] }],
            },
          }),
        );

        const runner = yield* T3HookRunner.T3HookRunner;
        const plan = yield* runner.prepare(root);
        const decision = yield* plan.evaluatePreToolUse({
          provider: "claudeAgent",
          threadId: "thread-3",
          toolName: "Bash",
          toolInput: { command: "git push" },
        });

        assert.deepEqual(decision, {
          decision: "deny",
          reason: "Blocked by repository policy.",
        });
      }),
    );
  });
});
