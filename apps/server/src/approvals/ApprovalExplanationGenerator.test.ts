import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import * as Generator from "./ApprovalExplanationGenerator.ts";

it.effect("reports an unconfigured key without starting a worker", () =>
  Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* Effect.flip(
      generator.generate({ cwd: "/workspace", command: "git status" }),
    );
    assert.include(result.detail, "API key is not configured");
  }).pipe(
    Effect.provide(Generator.layer.pipe(Layer.provide(Settings.layerTest({})))),
    Effect.scoped,
  ),
);

it.effect("reports an unavailable worker without hanging", () => {
  vi.stubEnv("T3CODE_APPROVAL_EXPLANATION_WORKER", "missing-t3-approval-worker");
  return Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* Effect.flip(
      generator.generate({ cwd: "/workspace", command: "git status" }),
    );
    assert.include(result.detail, "worker failed or is unavailable");
    assert.instanceOf(result.cause, Error);
    assert.equal(result.cause.message, "Approval worker could not start");
    const retry = yield* Effect.flip(
      generator.generate({ cwd: "/workspace", command: "git status" }),
    );
    assert.instanceOf(retry.cause, Error);
    assert.equal(retry.cause.message, "Approval worker could not start");
  }).pipe(
    Effect.provide(
      Generator.layer.pipe(
        Layer.provide(Settings.layerTest({ approvalExplanationApiKey: "test-key" })),
      ),
    ),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});
