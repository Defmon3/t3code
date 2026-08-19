import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly opacity?: number;
  readonly borderRadius?: number;
  readonly visibility?: "visible";
}

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const { active, cornerRadius = 0, hiddenSize, rect } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: 30,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  return {
    left: 0,
    top: 0,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: 0,
    pointerEvents: "none",
    // why: an off-viewport guest can have its compositor surface culled even
    // with background throttling disabled, stalling CDP and capture requests.
    visibility: "visible",
    opacity: 0,
  };
}
