import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ApprovalExplanationInput = Schema.Struct({
  threadId: ThreadId,
  source: Schema.Literals(["native", "hook"]),
  requestId: TrimmedNonEmptyString,
});
export type ApprovalExplanationInput = typeof ApprovalExplanationInput.Type;

export const ApprovalExplanationContent = Schema.Struct({
  judgement: Schema.Struct({
    verdict: Schema.Literals(["safe", "unsafe", "uncertain"]),
    reason: TrimmedNonEmptyString,
  }),
  operations: Schema.NonEmptyArray(
    Schema.Struct({
      action: TrimmedNonEmptyString,
      detail: TrimmedNonEmptyString,
      note: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ApprovalExplanationContent = typeof ApprovalExplanationContent.Type;

export const ApprovalExplanationResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), ...ApprovalExplanationContent.fields }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "request_not_pending",
      "not_command",
      "project_unavailable",
      "provider_unsupported",
    ]),
  }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type ApprovalExplanationResult = typeof ApprovalExplanationResult.Type;
