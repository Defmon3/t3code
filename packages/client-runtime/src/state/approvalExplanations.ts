import {
  WS_METHODS,
  ApprovalExplanationInput,
  type ApprovalExplanationResult,
  EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { ThreadPendingApproval } from "./threadRequests.ts";

const ApprovalExplanationTarget = Schema.Struct({
  environmentId: EnvironmentId,
  input: ApprovalExplanationInput,
  content: Schema.Struct({
    command: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
    detail: Schema.NullOr(Schema.String),
  }),
});
type ApprovalExplanationTarget = typeof ApprovalExplanationTarget.Type;
const decodeExplanationTarget = Schema.decodeUnknownSync(ApprovalExplanationTarget);

export function approvalExplanationTarget(
  threadRef: ScopedThreadRef,
  approval: ThreadPendingApproval,
): ApprovalExplanationTarget {
  return {
    environmentId: threadRef.environmentId,
    input: {
      threadId: approval.originThreadId ?? threadRef.threadId,
      source: approval.hookRequestId === undefined ? "native" : "hook",
      requestId: approval.hookRequestId ?? approval.requestId,
    },
    content: {
      command: approval.command ?? null,
      cwd: approval.cwd ?? null,
      reason: approval.reason ?? null,
      detail: approval.detail ?? null,
    },
  };
}

export type ApprovalExplanationView =
  | Extract<ApprovalExplanationResult, { readonly status: "ready" }>
  | { readonly status: "loading" | "unavailable" | "error"; readonly message: string };

export type ApprovalRejectionDraft =
  | { readonly status: "untouched" | "manual" | "dismissed" }
  | { readonly status: "edited"; readonly reason: string };

export function approvalRejectionDraftKey(
  threadRef: ScopedThreadRef,
  approval: ThreadPendingApproval,
): string {
  const target = approvalExplanationTarget(threadRef, approval);
  return JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    target.input,
    approval.requestId,
  ]);
}

export function approvalRejectionReason(
  draft: ApprovalRejectionDraft,
  explanation: ApprovalExplanationView | undefined,
  supportsFeedback: boolean,
): string | null {
  if (!supportsFeedback || draft.status === "dismissed") return null;
  if (draft.status === "edited") return draft.reason;
  if (explanation?.status === "ready" && explanation.judgement.verdict === "unsafe") {
    return explanation.judgement.reason;
  }
  return draft.status === "manual" ? "" : null;
}

export const approvalJudgementLabels = {
  safe: "Safe",
  unsafe: "Unsafe",
  uncertain: "Uncertain",
} as const;

export function approvalExplanationView(
  result: AsyncResult.AsyncResult<ApprovalExplanationResult, unknown>,
): ApprovalExplanationView {
  if (AsyncResult.isInitial(result))
    return { status: "loading", message: "Preparing AI explanation…" };
  if (AsyncResult.isFailure(result))
    return {
      status: "error",
      message: "AI explanation could not be loaded. You can still review the command and respond.",
    };
  const value = result.value;
  if (value.status === "ready") return value;
  if (value.status === "error") return { status: "error", message: value.message };
  if (value.reason === "provider_unsupported")
    return {
      status: "unavailable",
      message:
        "This model cannot explain commands without tools. Choose another text-generation model in Settings.",
    };
  return {
    status: "unavailable",
    message:
      "AI explanation is unavailable for this request. Review the command before responding.",
  };
}

export function createApprovalExplanationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const explain = createEnvironmentRpcCommand(runtime, {
    label: "approval-explanation:generate",
    tag: WS_METHODS.approvalsExplain,
  });
  const family = Atom.family((key: string) => {
    const target = decodeExplanationTarget(JSON.parse(key));
    return Atom.make((get) => {
      if (!get(explain.permissionAtom(target.environmentId, target.input))) {
        return Effect.succeed<ApprovalExplanationResult>({
          status: "error",
          message:
            "This connection cannot request AI explanations. You can still review the command.",
        });
      }
      return Effect.promise(() =>
        explain.run(get.registry, { environmentId: target.environmentId, input: target.input }),
      ).pipe(
        Effect.flatMap((result) =>
          result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause),
        ),
      );
    }).pipe(Atom.withLabel(`approval-explanation:${key}`));
  });
  return (target: ApprovalExplanationTarget) => family(JSON.stringify(target));
}
