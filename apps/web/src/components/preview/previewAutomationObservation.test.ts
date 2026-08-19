import { PreviewTabId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectPreviewObservationTabId } from "./previewAutomationObservation";

describe("projectPreviewObservationTabId", () => {
  const runtimeTabId = PreviewTabId.make('["environment-1","thread-1","epoch-1","tab-1"]');
  const serverTabId = PreviewTabId.make("tab-1");

  it("returns the server tab id instead of the desktop runtime id", () => {
    expect(
      projectPreviewObservationTabId(
        {
          tabId: runtimeTabId,
          observing: true,
          cursor: 0,
          startedAt: "2026-08-19T12:00:00.000Z",
        },
        serverTabId,
      ),
    ).toMatchObject({ tabId: serverTabId });
  });

  it("also returns the server tab id on a saved HAR artifact", () => {
    expect(
      projectPreviewObservationTabId(
        {
          tabId: runtimeTabId,
          observing: false,
          cursor: 2,
          startedAt: "2026-08-19T12:00:00.000Z",
          artifact: {
            id: "browser-observation-1",
            tabId: runtimeTabId,
            path: "C:\\temp\\browser-observation-1.har",
            mimeType: "application/har+json" as const,
            sizeBytes: 42,
            createdAt: "2026-08-19T12:01:00.000Z",
          },
        },
        serverTabId,
      ),
    ).toMatchObject({
      tabId: serverTabId,
      artifact: { tabId: serverTabId },
    });
  });
});
