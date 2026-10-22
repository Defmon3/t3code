import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

export {
  GitHubApiAuthenticationError,
  GitHubApiRateLimitError,
  GitHubApiResponseError,
  PinnedGitHubCredential,
  type GitHubApiError,
} from "./GitHubRequestPolicy.ts";
export type { GitHubRestResponse } from "./GitHubRest.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
  readonly minimumCost?: number;
  readonly maxResponseBytes?: number;
}

/**
 * GitHub's REST transport plus GraphQL sent as a hand-written document, for readers that have no
 * generated client. Both go through `GitHubRequestPolicy`, so they share its slots, quota and pause.
 */
export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer. */
    readonly graphql: (
      input: GitHubGraphQlInput,
    ) => Effect.Effect<string, GitHubRequestPolicy.GitHubApiError>;
    readonly rest: GitHubRest.GitHubRest["Service"]["rest"];
    readonly credential: GitHubRest.GitHubRest["Service"]["credential"];
  }
>()("@t3tools/source-control-github/server/GitHubApi") {}

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** GitHub reports a failed GraphQL document with HTTP 200 and an `errors` list. */
function classify(answer: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
}): GitHubRequestPolicy.GitHubAnswer<string> {
  const { status, headers, body } = answer;
  const meta = { status, headers };
  const errors = Option.getOrUndefined(decodeGraphQlErrors(body))?.errors;
  if (
    GitHubRequestPolicy.isRateLimited({
      status,
      headers,
      body,
      ...(errors === undefined ? {} : { graphqlErrors: errors }),
    })
  ) {
    return { _tag: "RateLimited", ...meta };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (status === 404 || errors?.every((error) => error.type === "NOT_FOUND") === true) {
    return { _tag: "NotFound", ...meta };
  }
  if (errors !== undefined) {
    const messages = errors.flatMap((error) =>
      error.message === undefined ? [] : [error.message],
    );
    return { _tag: "Failed", messages, ...meta };
  }
  // why: a body cut at the byte cap hides any `errors` past the cut and cannot be decoded.
  if (answer.truncated || status < 200 || status >= 300) return { _tag: "Failed", ...meta };
  return { _tag: "Ok", value: body, ...meta };
}

/**
 * Sends one hand-written GraphQL document through `GitHubRequestPolicy` and returns the raw JSON
 * body of a successful answer.
 */
export const sendGraphQlDocument = Effect.fn("GitHubApi.graphql")(function* (
  input: GitHubGraphQlInput,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const host = GitHubRequestPolicy.normalizeHost(input.host);
  const operation = input.operation;
  yield* Effect.annotateCurrentSpan({ "github.kind": "graphql" });
  const request = HttpClientRequest.post(GitHubRequestPolicy.gitHubApiUrls(host).graphql).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJsonUnsafe({ query: input.query, variables: input.variables ?? {} }),
  );
  return yield* policy.request(
    {
      host,
      operation,
      resource: "graphql",
      allowReserve: input.allowReserve ?? (yield* SourceControlRateLimit.Interactive),
      minimumCost: input.minimumCost,
    },
    (headers) =>
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(request.pipe(HttpClientRequest.setHeaders(headers)))
          .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        const collected = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        }).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "EmptyBodyError",
            () => Effect.succeed({ text: "", truncated: false }),
          ),
        );
        return classify({
          status: response.status,
          headers: response.headers,
          body: collected.text,
          truncated: collected.truncated,
        });
      }).pipe(
        Effect.mapError(
          (cause) => new GitHubRequestPolicy.GitHubApiRequestError({ host, operation, cause }),
        ),
      ),
  );
});

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const rest = yield* GitHubRest.GitHubRest;
  return GitHubApi.of({
    graphql: (input) =>
      sendGraphQlDocument(input).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(GitHubRequestPolicy.GitHubRequestPolicy, policy),
      ),
    rest: rest.rest,
    credential: rest.credential,
  });
});

export const layer = Layer.effect(GitHubApi, make);

/** Both transports with everything `GitHubRest.layerWithDependencies` reads through. */
export const layerWithDependencies = layer.pipe(
  Layer.provideMerge(GitHubRest.layerWithDependencies),
);
