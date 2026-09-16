import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type {
  ServerComposerAutocompleteInput,
  ServerComposerAutocompleteResult,
} from "@t3tools/contracts";

const OLLAMA_URL = "http://127.0.0.1:11435";
const OLLAMA_MODEL = "composer-autocomplete";

const OllamaGenerateResponse = Schema.Struct({
  response: Schema.String,
});

export const normalizeComposerSuggestion = (draft: string, response: string): string | null => {
  let suggestion = response.replace(/\r/g, "").split("\n", 1)[0]?.trimEnd() ?? "";
  if (suggestion.startsWith(draft)) suggestion = suggestion.slice(draft.length);
  if (
    suggestion.length >= 2 &&
    ((suggestion.startsWith('"') && suggestion.endsWith('"')) ||
      (suggestion.startsWith("'") && suggestion.endsWith("'")))
  ) {
    suggestion = suggestion.slice(1, -1);
  }
  const wordPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  const draftWords = [...draft.matchAll(wordPattern)].map((match) =>
    match[0].replace(/['’]/g, "").toLocaleLowerCase(),
  );
  const suggestionWords = [...suggestion.matchAll(wordPattern)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    value: match[0].replace(/['’]/g, "").toLocaleLowerCase(),
  }));
  for (
    let count = Math.min(4, draftWords.length, suggestionWords.length);
    count > 0;
    count -= 1
  ) {
    const draftSuffix = draftWords.slice(-count);
    const suggestionPrefix = suggestionWords.slice(0, count).map((word) => word.value);
    if (draftSuffix.every((word, index) => word === suggestionPrefix[index])) {
      suggestion = suggestion.slice(suggestionWords[count - 1]?.end ?? 0).trimStart();
      break;
    }
  }
  if (/\s$/.test(draft)) suggestion = suggestion.trimStart();
  suggestion = suggestion.slice(0, 160);
  return suggestion.length > 0 ? suggestion : null;
};

export const generateComposerAutocomplete = Effect.fn("composerAutocomplete.generate")(function* (
  input: ServerComposerAutocompleteInput,
): Effect.fn.Return<ServerComposerAutocompleteResult, never, HttpClient.HttpClient> {
  const draft = input.draft.slice(-8_000);
  if (draft.trim().length < 8 || /\s$/.test(draft) === false) {
    return { suggestion: null, model: null };
  }

  const httpClient = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const prompt = `A concise software-development request.\n\n${draft.trimEnd()}`;
    const request = yield* HttpClientRequest.post(`${OLLAMA_URL}/api/generate`).pipe(
      HttpClientRequest.bodyJson({
        model: OLLAMA_MODEL,
        stream: false,
        raw: true,
        prompt,
        keep_alive: "2m",
        options: {
          temperature: 0.2,
          top_k: 20,
          top_p: 0.9,
          repeat_penalty: 1.15,
          num_ctx: 2_048,
          num_predict: 8,
          stop: ["\n"],
        },
      }),
    );
    const response = yield* request.pipe(
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaGenerateResponse)),
    );

    return {
      suggestion: normalizeComposerSuggestion(draft, response.response),
      model: OLLAMA_MODEL,
    };
  }).pipe(
    Effect.timeout("90 seconds"),
    Effect.catchCause((cause) =>
      Effect.logDebug("local composer autocomplete unavailable", { cause }).pipe(
        Effect.as({ suggestion: null, model: null }),
      ),
    ),
  );
});
