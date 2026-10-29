import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HookApprovalRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("HookApprovalRequestId"),
);
export type HookApprovalRequestId = typeof HookApprovalRequestId.Type;

const HookApprovalCommand = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192));
const HookApprovalReason = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192));
const HookApprovalWorkingDirectory = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_192),
);

export const HookApprovalScope = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192)),
  label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192)),
});
export type HookApprovalScope = typeof HookApprovalScope.Type;

export const HookApprovalBypass = Schema.Struct({
  rule: Schema.String.check(Schema.isNonEmpty()),
  technique: Schema.String.check(Schema.isNonEmpty()),
  tier: Schema.Literals([1, 2]),
  steps: Schema.NonEmptyArray(
    Schema.Struct({ command: Schema.String.check(Schema.isNonEmpty()), triggered: Schema.Boolean }),
  ),
  reasoning: Schema.String,
  runtime: Schema.String,
  model: Schema.String,
  sessionId: Schema.String,
  threadTitle: Schema.String,
  threadId: Schema.String,
});
export type HookApprovalBypass = typeof HookApprovalBypass.Type;

export const HookApprovalDecision = Schema.Literals(["allow", "allow-session", "deny"]);
export type HookApprovalDecision = typeof HookApprovalDecision.Type;

export const HookApprovalDuration = Schema.Literals(["15-minutes", "1-hour", "session"]);
export type HookApprovalDuration = typeof HookApprovalDuration.Type;

export const HookApprovalGrant = Schema.Struct({
  grantId: TrimmedNonEmptyString,
  threadId: ThreadId,
  scope: Schema.optional(HookApprovalScope),
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type HookApprovalGrant = typeof HookApprovalGrant.Type;

export const HookApprovalRevokeGrantInput = Schema.Struct({
  grantId: TrimmedNonEmptyString,
});
export type HookApprovalRevokeGrantInput = typeof HookApprovalRevokeGrantInput.Type;

export const HookApprovalRequest = Schema.Struct({
  requestId: HookApprovalRequestId,
  threadId: ThreadId,
  command: HookApprovalCommand,
  reason: HookApprovalReason,
  cwd: HookApprovalWorkingDirectory,
  scope: Schema.optional(HookApprovalScope),
  createdAt: Schema.DateTimeUtc,
  bypass: Schema.optionalKey(HookApprovalBypass),
});
export type HookApprovalRequest = typeof HookApprovalRequest.Type;

export const HookApprovalRespondInput = Schema.Struct({
  requestId: HookApprovalRequestId,
  decision: HookApprovalDecision,
  duration: Schema.optional(HookApprovalDuration),
  feedback: Schema.optional(TrimmedNonEmptyString),
});
export type HookApprovalRespondInput = typeof HookApprovalRespondInput.Type;

export const HookApprovalHttpRequest = Schema.Struct({
  command: HookApprovalCommand,
  reason: HookApprovalReason,
  cwd: HookApprovalWorkingDirectory,
  scope: Schema.optional(HookApprovalScope),
  bypass: Schema.optionalKey(HookApprovalBypass),
});
export type HookApprovalHttpRequest = typeof HookApprovalHttpRequest.Type;

export const HookApprovalHttpResponse = Schema.Struct({
  decision: HookApprovalDecision,
  feedback: Schema.optional(TrimmedNonEmptyString),
});
export type HookApprovalHttpResponse = typeof HookApprovalHttpResponse.Type;

export const HookApprovalRespondErrorReason = Schema.Literals(["request_not_pending"]);
export type HookApprovalRespondErrorReason = typeof HookApprovalRespondErrorReason.Type;

export class HookApprovalRespondError extends Schema.TaggedError<HookApprovalRespondError>()(
  "HookApprovalRespondError",
  {
    reason: HookApprovalRespondErrorReason,
    message: Schema.String,
  },
) {}
