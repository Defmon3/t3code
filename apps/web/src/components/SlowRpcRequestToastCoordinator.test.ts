import { describe, expect, it } from "vite-plus/test";

import { shouldShowSlowRequestWarning } from "./SlowRpcRequestToastCoordinator";

const slowRequest = {
  requestId: "request-1",
  startedAt: "2026-08-10T20:00:00.000Z",
  startedAtMs: 1,
  tag: "vcs.listRefs",
  thresholdMs: 15_000,
};

describe("shouldShowSlowRequestWarning", () => {
  it("suppresses slow request warnings when the preference is disabled", () => {
    expect(shouldShowSlowRequestWarning(false, [slowRequest])).toBe(false);
  });

  it("shows warnings only when enabled requests are actually slow", () => {
    expect(shouldShowSlowRequestWarning(true, [])).toBe(false);
    expect(shouldShowSlowRequestWarning(true, [slowRequest])).toBe(true);
  });
});
