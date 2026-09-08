import {
  EnvironmentId,
  HookApprovalRequestId,
  ThreadId,
  type HookApprovalRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import {
  hookApprovalResponseErrorMessage,
  hookApprovalResponseTarget,
  scopeHookApprovalRequests,
  sortHookApprovalRequests,
} from "./hookApprovals.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function request(requestId: string, createdAt: string): HookApprovalRequest {
  return {
    requestId: HookApprovalRequestId.make(requestId),
    threadId: ThreadId.make(`thread-${requestId}`),
    command: `command ${requestId}`,
    reason: `reason ${requestId}`,
    cwd: `C:/workspace/${requestId}`,
    createdAt: DateTime.makeUnsafe(createdAt),
  };
}

describe("hook approvals", () => {
  it("orders snapshots from two environments and removes a resolved request", () => {
    const firstSnapshot = sortHookApprovalRequests([
      ...scopeHookApprovalRequests(environmentA, [request("later", "2026-09-07T12:00:01.000Z")]),
      ...scopeHookApprovalRequests(environmentB, [request("first", "2026-09-07T12:00:00.000Z")]),
    ]);
    const afterResolution = sortHookApprovalRequests([
      ...scopeHookApprovalRequests(environmentA, [request("later", "2026-09-07T12:00:01.000Z")]),
      ...scopeHookApprovalRequests(environmentB, []),
    ]);

    expect(firstSnapshot.map((item) => [item.environmentId, item.requestId])).toEqual([
      [environmentB, "first"],
      [environmentA, "later"],
    ]);
    expect(afterResolution.map((item) => item.requestId)).toEqual(["later"]);
  });

  it("routes a decision to the environment that emitted the request", () => {
    const [pending] = scopeHookApprovalRequests(environmentB, [
      request("remote", "2026-09-07T12:00:00.000Z"),
    ]);

    expect(hookApprovalResponseTarget(pending!, "allow-session")).toEqual({
      environmentId: environmentB,
      input: { requestId: "remote", decision: "allow-session" },
    });
  });

  it("keeps a response failure visible to the user", () => {
    expect(hookApprovalResponseErrorMessage(new Error("Request was already resolved."))).toBe(
      "Request was already resolved.",
    );
    expect(hookApprovalResponseErrorMessage({})).toBe(
      "The approval decision was not sent. Try again.",
    );
  });
});
