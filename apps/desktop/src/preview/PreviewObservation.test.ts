import { describe, expect, it } from "vite-plus/test";

import {
  capturePreviewObservationEvent,
  makeSanitizedHar,
  readPreviewObservation,
  sanitizeObservedUrl,
  startPreviewObservation,
} from "./PreviewObservation.ts";

describe("preview observation", () => {
  it("returns cursor-based deltas and preserves request timing", () => {
    let state = startPreviewObservation("2026-08-19T10:00:00.000Z");
    state = capturePreviewObservationEvent(
      state,
      "Network.requestWillBeSent",
      {
        requestId: "request-1",
        timestamp: 10,
        type: "Fetch",
        request: { method: "GET", url: "https://example.com/api?token=secret&view=full" },
        initiator: { type: "script" },
      },
      "2026-08-19T10:00:01.000Z",
    );
    const [first, afterFirstRead] = readPreviewObservation("tab-1", state);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      cursor: 1,
      kind: "request",
      url: "https://example.com/api?token=%5BREDACTED%5D&view=full",
    });

    state = capturePreviewObservationEvent(
      afterFirstRead,
      "Network.loadingFinished",
      { requestId: "request-1", timestamp: 10.25, encodedDataLength: 128 },
      "2026-08-19T10:00:01.250Z",
    );
    const [second] = readPreviewObservation("tab-1", state);
    expect(second.events).toEqual([
      expect.objectContaining({
        cursor: 2,
        kind: "loadingFinished",
        durationMs: 250,
        encodedDataLength: 128,
      }),
    ]);
  });

  it("sanitizes HAR URLs and omits credentials, headers, and bodies", () => {
    let state = startPreviewObservation("2026-08-19T10:00:00.000Z");
    state = capturePreviewObservationEvent(
      state,
      "Network.requestWillBeSent",
      {
        requestId: "request-1",
        request: {
          method: "POST",
          url: "https://example.com/upload?api_key=secret#fragment",
          headers: { Authorization: "Bearer secret" },
          postData: "secret body",
        },
      },
      "2026-08-19T10:00:01.000Z",
    );
    const serialized = JSON.stringify(makeSanitizedHar(state));
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("fragment");
    expect(serialized).toContain("%5BREDACTED%5D");
  });

  it("removes fragments from malformed and valid URLs", () => {
    expect(sanitizeObservedUrl("https://example.com/path#secret")).toBe("https://example.com/path");
    expect(sanitizeObservedUrl("relative/path#secret")).toBe("relative/path");
  });

  it("reports only unread events lost from the bounded buffer", () => {
    let state = startPreviewObservation("2026-08-19T10:00:00.000Z");
    for (let index = 0; index < 505; index += 1) {
      state = capturePreviewObservationEvent(
        state,
        "Runtime.consoleAPICalled",
        { type: "log", args: [{ value: String(index) }] },
        "2026-08-19T10:00:01.000Z",
      );
    }
    const [result] = readPreviewObservation("tab-1", state);
    expect(result.events).toHaveLength(500);
    expect(result.droppedEvents).toBe(5);
    expect(result.events[0]?.cursor).toBe(6);
  });
});
