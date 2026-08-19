import { describe, expect, it } from "vite-plus/test";

import { waitForPreviewPresentation } from "./previewPresentationReadiness";

describe("waitForPreviewPresentation", () => {
  it("observes an active preview surface that becomes visible after 500ms but before the request deadline", async () => {
    let now = 0;

    await expect(
      waitForPreviewPresentation({
        deadline: 1_000,
        isVisible: () => now >= 600,
        now: () => now,
        sleep: async (durationMs) => {
          now += durationMs;
        },
      }),
    ).resolves.toBe(true);
  });

  it("stops polling at the request deadline when a background surface remains hidden", async () => {
    let now = 0;
    const sleeps: number[] = [];

    await expect(
      waitForPreviewPresentation({
        deadline: 50,
        isVisible: () => false,
        now: () => now,
        sleep: async (durationMs) => {
          sleeps.push(durationMs);
          now += durationMs;
        },
      }),
    ).resolves.toBe(false);

    expect(now).toBe(50);
    expect(sleeps).toEqual([16, 16, 16, 2]);
  });
});
