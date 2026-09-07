import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadPr } from "./threadSettled.ts";

function pullRequest(input: {
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string | null;
}): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 4970,
    title: "Historical pull request",
    url: "https://github.com/t3tools/t3code/pull/4970",
    baseRef: "main",
    headRef: "feature/historical-pr",
    state: input.state,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  };
}

function resolve(pr: NonNullable<VcsStatusResult["pr"]>) {
  return resolveThreadPr({
    threadBranch: "feature/historical-pr",
    threadCreatedAt: "2026-08-01T12:00:00.000Z",
    gitStatus: { refName: "feature/historical-pr", pr },
  });
}

describe("resolveThreadPr", () => {
  it("hides terminal pull requests updated before the thread", () => {
    expect(
      resolve(pullRequest({ state: "merged", updatedAt: "2026-08-01T11:59:59.999Z" })),
    ).toBeNull();
  });

  it("keeps terminal pull requests updated at or after thread creation", () => {
    const closedAtCreation = pullRequest({
      state: "closed",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    const mergedAfterCreation = pullRequest({
      state: "merged",
      updatedAt: "2026-08-01T12:00:00.001Z",
    });

    expect(resolve(closedAtCreation)).toBe(closedAtCreation);
    expect(resolve(mergedAfterCreation)).toBe(mergedAfterCreation);
  });

  it("keeps open and terminal pull requests without usable timestamps", () => {
    const open = pullRequest({ state: "open" });
    const missingTimestamp = pullRequest({ state: "closed", updatedAt: null });
    const invalidTimestamp = pullRequest({ state: "merged", updatedAt: "not-a-date" });

    expect(resolve(open)).toBe(open);
    expect(resolve(missingTimestamp)).toBe(missingTimestamp);
    expect(resolve(invalidTimestamp)).toBe(invalidTimestamp);
  });
});
