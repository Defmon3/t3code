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

export const HookApprovalDecision = Schema.Literals(["allow", "allow-session", "deny"]);
export type HookApprovalDecision = typeof HookApprovalDecision.Type;

export const HookApprovalRequest = Schema.Struct({
  requestId: HookApprovalRequestId,
  threadId: ThreadId,
  command: HookApprovalCommand,
  reason: HookApprovalReason,
  cwd: HookApprovalWorkingDirectory,
  scope: Schema.optional(HookApprovalScope),
  createdAt: Schema.DateTimeUtc,
});
export type HookApprovalRequest = typeof HookApprovalRequest.Type;

export const HookApprovalRespondInput = Schema.Struct({
  requestId: HookApprovalRequestId,
  decision: HookApprovalDecision,
});
export type HookApprovalRespondInput = typeof HookApprovalRespondInput.Type;

export const HookApprovalHttpRequest = Schema.Struct({
  command: HookApprovalCommand,
  reason: HookApprovalReason,
  cwd: HookApprovalWorkingDirectory,
  scope: Schema.optional(HookApprovalScope),
});
export type HookApprovalHttpRequest = typeof HookApprovalHttpRequest.Type;

export const HookApprovalHttpResponse = Schema.Struct({
  decision: HookApprovalDecision,
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
