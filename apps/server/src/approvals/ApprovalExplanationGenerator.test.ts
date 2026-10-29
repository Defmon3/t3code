import { assert, it } from "@effect/vitest";
import { ApprovalExplanationContent } from "@t3tools/contracts";
import { buildApprovalExplanationPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as Settings from "../serverSettings.ts";
import * as Generator from "./ApprovalExplanationGenerator.ts";

const input = { cwd: "/workspace", command: "git status" };
const content = {
  judgement: { verdict: "safe", reason: "Reads repository status." },
  operations: [{ action: "Read", detail: "Git status", note: null }],
} satisfies ApprovalExplanationContent;

const responseBody = (text: string) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
});

const layer = (fetch: typeof globalThis.fetch, apiKey = "") =>
  Generator.layer.pipe(
    Layer.provide(Settings.layerTest({ approvalExplanationApiKey: apiKey })),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );

it.effect("reports an unconfigured key without making a request", () =>
  Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* Effect.flip(generator.generate(input));
    assert.include(result.detail, "API key is not configured");
  }).pipe(Effect.provide(layer(() => Promise.reject(new Error("Unexpected request"))))),
);

it.effect("requests native structured Gemini output with thinking disabled", () => {
  const requests: Array<Request> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(new Request(url, init));
    const text = JSON.stringify(content);
    return Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Internal reasoning", thought: true },
              { text: text.slice(0, 20) },
              { text: text.slice(20) },
            ],
          },
        },
      ],
    });
  };
  return Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* generator.generate(input);

    assert.deepStrictEqual(result, content);
    assert.lengthOf(requests, 1);
    const request = requests[0]!;
    assert.strictEqual(
      request.url,
      "https://wonton.soup.herahorizon.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(request.headers.get("x-goog-api-key"), "test-key");
    assert.deepStrictEqual(yield* Effect.promise(() => request.json()), {
      contents: [{ role: "user", parts: [{ text: buildApprovalExplanationPrompt(input).prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseJsonSchema: toJsonSchemaObject(ApprovalExplanationContent),
      },
    });
  }).pipe(Effect.provide(layer(fetch, "test-key")));
});

it.effect.each([
  { name: "unauthorized", status: 401, body: "credentials rejected" },
  { name: "server failure", status: 503, body: "unavailable" },
  { name: "invalid JSON", status: 200, body: "not JSON" },
  { name: "empty body", status: 200, body: "" },
  { name: "missing candidates", status: 200, body: "{}" },
  { name: "empty candidates", status: 200, body: JSON.stringify({ candidates: [] }) },
  { name: "invalid explanation JSON", status: 200, body: JSON.stringify(responseBody("not JSON")) },
  { name: "invalid explanation", status: 200, body: JSON.stringify(responseBody("{}")) },
  {
    name: "empty operations",
    status: 200,
    body: JSON.stringify(responseBody(JSON.stringify({ ...content, operations: [] }))),
  },
  {
    name: "incomplete generation",
    status: 200,
    body: JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }),
  },
])("reports $name without retrying", ({ status, body }) => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests += 1;
    return new Response(body, { status });
  };
  return Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* Effect.flip(generator.generate(input));

    assert.include(result.detail, "request failed or returned an invalid response");
    assert.isDefined(result.cause);
    assert.strictEqual(requests, 1);
  }).pipe(Effect.provide(layer(fetch, "test-key")));
});

it.effect("reports network failure", () => {
  const failure = new Error("Connection closed");
  return Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const result = yield* Effect.flip(generator.generate(input));

    assert.instanceOf(result.cause, Error);
    assert.strictEqual(result.cause, failure);
  }).pipe(Effect.provide(layer(() => Promise.reject(failure), "test-key")));
});

it.effect("aborts the HTTP request when generation is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    const fetch: typeof globalThis.fetch = (_url, init) => {
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error("Missing cancellation signal"));
      Deferred.doneUnsafe(started, Effect.succeed(signal));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    yield* Effect.gen(function* () {
      const generator = yield* Generator.ApprovalExplanationGenerator;
      const fiber = yield* Effect.forkChild(generator.generate(input));
      const signal = yield* Deferred.await(started);

      yield* Fiber.interrupt(fiber);

      assert.isTrue(signal.aborted);
    }).pipe(Effect.provide(layer(fetch, "test-key")));
  }),
);
