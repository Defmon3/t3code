import { type ContextWindowSnapshot } from "~/lib/contextWindow";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ContextWindowMeter } from "./ContextWindowMeter";

describe("ContextWindowMeter", () => {
  it("renders a model-labelled compaction meter without a missing provider value", () => {
    const usage = {
      usedTokens: 1_000,
      maxTokens: 10_000,
      totalProcessedTokens: null,
      compactsAutomatically: true,
      usedPercentage: 10,
      remainingTokens: 9_000,
      remainingPercentage: 90,
      updatedAt: "",
    } as ContextWindowSnapshot;

    expect(() => {
      renderToStaticMarkup(
        createElement(ContextWindowMeter, { usage, modelDisplayName: "GPT-5.6 Sol" }),
      );
    }).not.toThrow();
  });
});
