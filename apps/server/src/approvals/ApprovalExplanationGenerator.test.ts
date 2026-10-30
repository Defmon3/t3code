import { assert, it } from "@effect/vitest";
import { ApprovalExplanationContent } from "@t3tools/contracts";
import { buildApprovalExplanationPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as Settings from "../serverSettings.ts";
import * as Generator from "./ApprovalExplanationGenerator.ts";

const input = { cwd: "/workspace", command: "git status" };
const encodePrompt = Schema.encodeSync(Schema.StringFromBase64);
const isHttpError = Schema.is(Generator.ApprovalExplanationHttpError);
const decodeDocumentRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      contents: Schema.NonEmptyArray(
        Schema.Struct({
          parts: Schema.NonEmptyArray(
            Schema.Struct({
              inlineData: Schema.Struct({
                mimeType: Schema.Literal("text/plain"),
                data: Schema.StringFromBase64,
              }),
            }),
          ),
        }),
      ),
    }),
  ),
);
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
  const encodedPrompt = encodePrompt(buildApprovalExplanationPrompt(input).prompt);
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
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "text/plain",
                data: encodedPrompt,
              },
            },
          ],
        },
      ],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseJsonSchema: toJsonSchemaObject(ApprovalExplanationContent),
      },
    });
  }).pipe(Effect.provide(layer(fetch, "test-key")));
});

it.effect("explains shell commands intact when the gateway rejects inline command text", () => {
  const commandInput = {
    ...input,
    command: `ssh build-host "printf '%s\\n' 'räksmörgås'; curl -sS -o /dev/null http://localhost/health"`,
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = await new Request(url, init).text();
    if (body.includes("curl -sS -o /dev/null")) {
      return new Response("<html>Sorry, you have been blocked</html>", {
        status: 403,
        headers: { server: "cloudflare", "content-type": "text/html", "cf-ray": "test-ray" },
      });
    }
    const request = decodeDocumentRequest(body);
    assert.strictEqual(
      request.contents[0].parts[0].inlineData.data,
      buildApprovalExplanationPrompt(commandInput).prompt,
    );
    return Response.json(responseBody(JSON.stringify(content)));
  };
  return Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    assert.deepStrictEqual(yield* generator.generate(commandInput), content);
  }).pipe(Effect.provide(layer(fetch, "test-key")));
});

it.effect.each([
  {
    status: 403,
    headers: { server: "cloudflare", "content-type": "text/html", "cf-ray": "test-ray" },
    cloudflareBlocked: true,
    message: "The explanation gateway blocked this command (HTTP 403).",
  },
  {
    status: 403,
    headers: { server: "cloudflare", "content-type": "application/json", "cf-ray": "test-ray" },
    cloudflareBlocked: false,
    message: "The explanation provider returned HTTP 403.",
  },
  {
    status: 503,
    headers: { "content-type": "text/html" },
    cloudflareBlocked: false,
    message: "The explanation provider returned HTTP 503.",
  },
])("reports a safe typed HTTP $status error", ({ status, headers, cloudflareBlocked, message }) =>
  Effect.gen(function* () {
    const generator = yield* Generator.ApprovalExplanationGenerator;
    const error = yield* Effect.flip(generator.generate(input));
    assert.instanceOf(error.cause, Generator.ApprovalExplanationHttpError);
    if (!isHttpError(error.cause)) {
      assert.fail("Expected a typed explanation HTTP error");
    }
    assert.strictEqual(error.cause.status, status);
    assert.strictEqual(error.cause.cloudflareBlocked, cloudflareBlocked);
    assert.strictEqual(error.cause.message, message);
    assert.notInclude(error.cause.message, "test-key");
  }).pipe(
    Effect.provide(
      layer(
        () =>
          Promise.resolve(
            new Response("test-key and private provider details", { status, headers }),
          ),
        "test-key",
      ),
    ),
  ),
);

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
