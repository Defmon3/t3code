import { ApprovalExplanationContent, TextGenerationError } from "@t3tools/contracts";
import { buildApprovalExplanationPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSettings from "../serverSettings.ts";

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidates: Schema.NonEmptyArray(
        Schema.Struct({
          finishReason: Schema.Literal("STOP"),
          content: Schema.Struct({
            parts: Schema.NonEmptyArray(
              Schema.Struct({ text: Schema.String, thought: Schema.optionalKey(Schema.Boolean) }),
            ),
          }),
        }),
      ),
    }),
  ),
);
const decodeContent = Schema.decodeUnknownSync(Schema.fromJsonString(ApprovalExplanationContent));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const responseJsonSchema = toJsonSchemaObject(ApprovalExplanationContent);

export class ApprovalExplanationGenerator extends Context.Service<
  ApprovalExplanationGenerator,
  {
    readonly generate: (input: {
      readonly cwd: string;
      readonly command: string;
      readonly workingDirectory?: string | undefined;
      readonly reason?: string | undefined;
    }) => Effect.Effect<ApprovalExplanationContent, TextGenerationError>;
  }
>()("t3/approvals/ApprovalExplanationGenerator") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fetch = yield* FetchHttpClient.Fetch;

  const generate = Effect.fn("ApprovalExplanationGenerator.generate")(function* (input: {
    readonly cwd: string;
    readonly command: string;
    readonly workingDirectory?: string | undefined;
    readonly reason?: string | undefined;
  }) {
    const apiKey = (yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateApprovalExplanation",
            detail: "Approval explanation settings could not be read.",
            cause,
          }),
      ),
    )).approvalExplanationApiKey;
    if (!apiKey) {
      return yield* new TextGenerationError({
        operation: "generateApprovalExplanation",
        detail: "Approval explanation API key is not configured.",
      });
    }
    const { prompt } = buildApprovalExplanationPrompt(input);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(
          "https://wonton.soup.herahorizon.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: encodeRequest({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                thinkingConfig: { thinkingBudget: 0 },
                responseMimeType: "application/json",
                responseJsonSchema,
              },
            }),
            signal,
            redirect: "error",
          },
        );
        if (!response.ok) {
          throw new Error(`Approval explanation request failed with HTTP ${response.status}`);
        }
        const { candidates } = decodeResponse(await response.text());
        return decodeContent(
          candidates[0].content.parts
            .filter((part) => !part.thought)
            .map((part) => part.text)
            .join(""),
        );
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateApprovalExplanation",
          detail: "Approval explanation request failed or returned an invalid response.",
          cause,
        }),
    });
  });

  return ApprovalExplanationGenerator.of({ generate });
});

export const layer = Layer.effect(ApprovalExplanationGenerator, make);
