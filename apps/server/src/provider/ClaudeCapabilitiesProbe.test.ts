// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeModule from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as WindowsProcessWorker from "../WindowsProcessWorker.ts";

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
    vi.mocked(query).mockImplementationOnce((input) => {
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
