import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Logger from "effect/Logger";
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

function writeHooksConfig(root: string, hooks: unknown) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDirectory = path.join(root, ".t3code");
    yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
    const configPath = path.join(configDirectory, "hooks.json");
    yield* fileSystem.writeFileString(configPath, encodeJson({ hooks }));
    return configPath;
  });
}

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

  it.layer(
    testLayer(() =>
      Effect.succeed({
        ...successfulOutput(""),
        code: 2 as ProcessRunOutput["code"],
        stderr: "Hook added while the session was running.",
      }),
    ),
  )("picks up a config created after prepare", (it) => {
    it.effect("reports live hooks and evaluates them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });

        const runner = yield* T3HookRunner.T3HookRunner;
        const plan = yield* runner.prepare(root);
        assert.equal(plan.configPath, undefined);
        assert.isFalse(plan.hasPreToolUseHooks);
        assert.isFalse(yield* plan.hasPreToolUseHooksNow);

        yield* writeHooksConfig(root, {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy" }] }],
        });

        assert.isTrue(yield* plan.hasPreToolUseHooksNow);
        const decision = yield* plan.evaluatePreToolUse({
          provider: "claudeAgent",
          threadId: "thread-created",
          toolName: "Bash",
          toolInput: { command: "git push" },
        });

        assert.deepEqual(decision, {
          decision: "deny",
          reason: "Hook added while the session was running.",
        });
      }),
    );
  });

  it.layer(
    testLayer(() =>
      Effect.succeed(
        successfulOutput(encodeJson({ decision: "ask", reason: "Bash needs confirmation." })),
      ),
    ),
  )("applies an edited matcher without preparing again", (it) => {
    it.effect("re-reads the config before each evaluation", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });
        yield* writeHooksConfig(root, {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy" }] }],
        });

        const runner = yield* T3HookRunner.T3HookRunner;
        const plan = yield* runner.prepare(root);
        const bashCall = {
          provider: "claudeAgent",
          threadId: "thread-edited",
          toolName: "Bash",
          toolInput: { command: "git push" },
        };

        assert.deepEqual(yield* plan.evaluatePreToolUse(bashCall), {
          decision: "ask",
          reason: "Bash needs confirmation.",
        });

        yield* writeHooksConfig(root, {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "policy" }] }],
        });

        assert.deepEqual(yield* plan.evaluatePreToolUse(bashCall), { decision: "allow" });
      }),
    );
  });

  it.layer(testLayer(() => Effect.die("an unreadable config must not run a hook")))(
    "fails closed when the config becomes invalid mid-session",
    (it) => {
      it.effect("reports live hooks and asks for confirmation", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });

          const runner = yield* T3HookRunner.T3HookRunner;
          const plan = yield* runner.prepare(root);
          assert.isFalse(plan.hasPreToolUseHooks);

          const configDirectory = path.join(root, ".t3code");
          yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
          const configPath = path.join(configDirectory, "hooks.json");
          yield* fileSystem.writeFileString(configPath, "{ not json");

          assert.isTrue(yield* plan.hasPreToolUseHooksNow);
          assert.deepEqual(
            yield* plan.evaluatePreToolUse({
              provider: "codex",
              threadId: "thread-invalid",
              toolName: "Bash",
              toolInput: { command: "git push" },
            }),
            {
              decision: "ask",
              title: "T3 hook config failed",
              reason: `T3 project hooks could not be loaded from ${configPath}.`,
            },
          );
        }),
      );
    },
  );

  it.layer(
    testLayer(() =>
      Effect.succeed(successfulOutput(encodeJson({ decision: "ask", reason: "Reviewed." }))),
    ),
  )("warns about hook events it does not implement", (it) => {
    it.effect("warns once and still runs PreToolUse", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-runner-" });
        const configPath = yield* writeHooksConfig(root, {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "after" }] }],
          Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
        });

        const runner = yield* T3HookRunner.T3HookRunner;
        const records: Array<{ readonly logLevel: LogLevel.LogLevel; readonly message: unknown }> =
          [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          records.push({ logLevel, message });
        });

        const decisions = yield* Effect.gen(function* () {
          const plan = yield* runner.prepare(root);
          const call = {
            provider: "claudeAgent",
            threadId: "thread-unsupported",
            toolName: "Bash",
            toolInput: { command: "git push" },
          };
          return [yield* plan.evaluatePreToolUse(call), yield* plan.evaluatePreToolUse(call)];
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

        const warnings = records.filter((record) => record.logLevel === "Warn");
        assert.equal(warnings.length, 1);
        const rendered = encodeJson(warnings[0]?.message);
        assert.match(rendered, /PostToolUse/);
        assert.match(rendered, /Stop/);
        assert.include(rendered, encodeJson(configPath));
        assert.deepEqual(decisions, [
          { decision: "ask", reason: "Reviewed." },
          { decision: "ask", reason: "Reviewed." },
        ]);
      }),
    );
  });
});
