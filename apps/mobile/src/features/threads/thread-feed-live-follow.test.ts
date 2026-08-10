import { describe, expect, it } from "vite-plus/test";

import { resolveThreadFeedLiveFollow } from "./thread-feed-live-follow";

describe("resolveThreadFeedLiveFollow", () => {
  it("pauses immediately when the user starts scrolling", () => {
    expect(resolveThreadFeedLiveFollow(true, { type: "user-scroll-begin" })).toBe(false);
  });

  it("stays paused away from the actual end", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "scroll",
        isAtEnd: false,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
  });

  it("does not mistake programmatic layout compensation for a user scroll", () => {
    expect(
      resolveThreadFeedLiveFollow(true, {
        type: "scroll",
        isAtEnd: false,
        userScrollSessionActive: false,
      }),
    ).toBe(true);
  });

  it("re-arms only at the actual end or after an explicit reset", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "scroll",
        isAtEnd: true,
        userScrollSessionActive: true,
      }),
    ).toBe(true);
    expect(resolveThreadFeedLiveFollow(false, { type: "reset" })).toBe(true);
  });
});
