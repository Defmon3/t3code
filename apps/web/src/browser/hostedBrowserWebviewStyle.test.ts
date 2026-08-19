import { describe, expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        cornerRadius: 12,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
    });
  });

  it("keeps an inactive webview in the compositor viewport while visually hidden", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: 0,
      top: 0,
      width: 393,
      height: 852,
      zIndex: 0,
      pointerEvents: "none",
      visibility: "visible",
      opacity: 0,
    });
  });
});
