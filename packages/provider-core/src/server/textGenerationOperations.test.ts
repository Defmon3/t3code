import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import type { WorkItemMatchGenerationInput } from "./textGeneration.ts";
import { decodeJsonReply, fromRunner, withoutInvestigation } from "./textGenerationOperations.ts";

const source = {
  kind: "issue" as const,
  provider: "linear",
  referenceStyle: "key-number" as const,
  repository: "ENG",
  number: 12,
  title: "Sessions expire too early",
  url: "https://linear.app/acme/issue/ENG-12",
  body: "Users get signed out while active.",
};
const input: WorkItemMatchGenerationInput = {
  cwd: "/workspace",
  relationship: "duplicate",
  source,
  candidates: [{ ...source, number: 13 }],
  modelSelection: createModelSelection(ProviderInstanceId.make("test-provider"), "test-model"),
};

it.effect.each([
  { explanation: "Reads the repository status.", risk: null },
  { explanation: "Restores the committed file.", risk: "Discards staged and unstaged edits." },
])("decodes approval explanations with concrete risk or no specific warning", (content) =>
  Effect.gen(function* () {
    const generation = fromRunner("Fixture", (request) => {
      expect(request.operation).toBe("generateApprovalExplanation");
      expect(request.investigate).toBeUndefined();
      return decodeJsonReply(request, "Fixture", JSON.stringify(content));
    });
    expect(
      yield* generation.generateApprovalExplanation({
        cwd: input.cwd,
        command: "git restore --staged --worktree -- src/app.ts",
        modelSelection: input.modelSelection,
      }),
    ).toEqual(content);
  }),
);

it.effect.each([
  { explanation: "", risk: null },
  { explanation: "Reads status." },
  { explanation: "Reads status.", risk: "" },
])("rejects malformed approval explanation output", (output) =>
  Effect.gen(function* () {
    const generation = fromRunner("Fixture", (request) =>
      decodeJsonReply(request, "Fixture", JSON.stringify(output)),
    );
    expect(
      yield* generation
        .generateApprovalExplanation({
          cwd: input.cwd,
          command: "git status",
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "TextGenerationError" });
  }),
);

it.effect("generates matches through the shared provider operation", () =>
  Effect.gen(function* () {
    const matches = [{ candidate: 1, confidence: "high", reason: "Same session expiry" }];
    const service = fromRunner("Fixture", (request) => {
      expect(request.operation).toBe("findWorkItemMatches");
      expect(request.cwd).toBe(input.cwd);
      expect(request.modelSelection).toEqual(input.modelSelection);
      expect(request.prompt).toContain("Reference: ENG-12");
      return decodeJsonReply(request, "Fixture", JSON.stringify({ matches }));
    });

    expect(yield* service.findWorkItemMatches(input)).toEqual({ matches });
  }),
);

it.effect("rejects invalid match confidence at the provider response boundary", () =>
  Effect.gen(function* () {
    const service = fromRunner("Fixture", (request) =>
      decodeJsonReply(
        request,
        "Fixture",
        '{"matches":[{"candidate":1,"confidence":"low","reason":"Uncertain"}]}',
      ),
    );

    expect(yield* service.findWorkItemMatches(input).pipe(Effect.flip)).toMatchObject({
      _tag: "TextGenerationError",
      operation: "findWorkItemMatches",
      detail: "Fixture returned invalid structured output.",
    });
  }),
);

it.effect("keeps work item matching available when review investigations are unsupported", () =>
  Effect.gen(function* () {
    const service = fromRunner(
      "Fixture",
      withoutInvestigation("Fixture", (request) =>
        decodeJsonReply(request, "Fixture", JSON.stringify({ matches: [] })),
      ),
    );

    expect(yield* service.findWorkItemMatches(input)).toEqual({ matches: [] });
    expect(
      yield* service
        .generateReviewGuide({
          cwd: input.cwd,
          number: source.number,
          title: source.title,
          description: source.body,
          baseBranch: "main",
          baseCommit: "base-revision",
          settledReview: "",
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.flip),
    ).toMatchObject({
      _tag: "TextGenerationError",
      operation: "generateReviewGuide",
      detail: expect.stringContaining("cannot investigate a checkout read-only"),
    });
  }),
);
