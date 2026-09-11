import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ClaudeAdapter from "../Layers/ClaudeAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-driver-hooks-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Claude must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("ClaudeDriver", (it) => {
  it.effect("passes the T3 hook runner to the Claude adapter", () =>
    Effect.gen(function* () {
      let adapterOptions: ClaudeAdapter.ClaudeAdapterLiveOptions | undefined;
      const makeAdapter = vi
        .spyOn(ClaudeAdapter, "makeClaudeAdapter")
        .mockImplementation((_settings, options) => {
          adapterOptions = options;
          return Effect.die("Stop after capturing Claude adapter options");
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => makeAdapter.mockRestore()));

      const result = yield* ClaudeDriver.create({
        instanceId: ProviderInstanceId.make("claude-hooks"),
        displayName: "Claude test",
        enabled: false,
        environment: [],
        config: ClaudeDriver.defaultConfig(),
      }).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(makeAdapter).toHaveBeenCalledOnce();
      expect(adapterOptions?.hookRunner).toBeDefined();
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Driver construction must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});
