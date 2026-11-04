// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeModule from "node:module";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as WindowsProcessWorker from "../WindowsProcessWorker.ts";
import * as TestClock from "effect/testing/TestClock";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it.live("exchanges probe input and output through the Windows worker and cancels the process", () =>
  Effect.gen(function* () {
    using _restoreBuiltinBindings = { [Symbol.dispose]: NodeModule.syncBuiltinESMExports };
    using _mainThreadSpawn = vi
      .spyOn(process.getBuiltinModule("child_process"), "spawn")
      .mockImplementation(() => {
        throw new Error("Unexpected main-thread Claude spawn");
      });
    NodeModule.syncBuiltinESMExports();
    const sdk = yield* Effect.promise(() =>
      vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
        "@anthropic-ai/claude-agent-sdk",
      ),
    );
    vi.mocked(ClaudeSdk.query).mockImplementationOnce((input) => {
      const spawn = input.options?.spawnClaudeCodeProcess;
      if (!spawn) throw new Error("Missing worker launcher");
      return sdk.query({
        ...input,
        options: {
          ...input.options,
          spawnClaudeCodeProcess: (options) =>
            spawn({
              ...options,
              command: process.execPath,
              args: [
                "-e",
                `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const frame = JSON.parse(line); if (frame.type === 'control_request') process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[],account:{email:'worker@example.com'}}}}) + '\\n') })`,
              ],
            }),
        },
      });
    });
    const result = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({}),
      {},
      undefined,
      false,
    );
    assert.equal(result.email, "worker@example.com");
  }).pipe(
    Effect.provide(Layer.merge(WindowsProcessWorker.layer, NodeServices.layer)),
    Effect.provideService(HostProcess.Platform, "win32"),
  ),
);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
