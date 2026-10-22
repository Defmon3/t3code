import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRest from "./GitHubRest.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const RESET_SECONDS = Math.floor(NOW / 1000) + 600;
const QUERY = "query { viewer { login } }";

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("first"),
          source: "gh" as const,
          fingerprint: `${host}:first`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    }),
  );
  const layer = GitHubApi.layer.pipe(
    Layer.provideMerge(GitHubRest.layer),
    Layer.provideMerge(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer, requests };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("GitHubApi.graphql", () => {
  it.effect("sends the document with the token and returns GitHub's answer", () => {
    const { layer, requests } = harness(() => json({ data: { viewer: { login: "julius" } } }));
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const body = yield* api.graphql({ host: "github.com", operation: "viewer", query: QUERY });

      expect(body).toContain('"login":"julius"');
      expect(requests[0]!.url).toBe("https://api.github.com/graphql");
      expect(requests[0]!.headers.authorization).toBe("Bearer first");
      const sent = requests[0]!.body;
      expect(sent._tag === "Uint8Array" ? new TextDecoder().decode(sent.body) : "").toContain(
        `"query":"${QUERY}"`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      answer: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] },
      headers: {},
      tag: "GitHubApiResponseError",
    },
    {
      answer: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] },
      headers: {},
      tag: "GitHubApiNotFoundError",
    },
    {
      answer: { errors: [{ message: "API rate limit already exceeded for user ID 1." }] },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) },
      tag: "GitHubApiRateLimitError",
    },
  ])("fails a GraphQL answer carrying errors as $tag", ({ answer, headers, tag }) => {
    const { layer } = harness(() => json(answer, { headers }));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "detail", query: QUERY }),
      );

      expect(error._tag).toBe(tag);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops a costlier request before HTTP when a cheap read leaves too few points", () => {
    const { layer, requests } = harness(() =>
      json(
        { data: { viewer: { login: "julius" } } },
        {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "502",
            "x-ratelimit-reset": String(RESET_SECONDS),
          },
        },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const read = { host: "github.com", operation: "detail", query: QUERY };
      yield* api.graphql(read);
      const error = yield* Effect.flip(api.graphql({ ...read, minimumCost: 3 }));

      expect(error._tag).toBe("SourceControlRateLimitPausedError");
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
