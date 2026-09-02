import { describe, expect, it } from "vite-plus/test";

import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

describe("preview keyboard packets", () => {
  it("separates Enter key phases from its character input", () => {
    expect(makePreviewAutomationKeySequence({ key: "Enter" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      char: { type: "char", keyCode: "\r", modifiers: [] },
      keyUp: { type: "keyUp", keyCode: "Enter", modifiers: [] },
      signal: { kind: "key", key: "Enter", code: "Enter" },
    });
  });

  it("separates printable key phases from character input", () => {
    expect(makePreviewAutomationKeySequence({ key: "z" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Z", modifiers: [] },
      char: { type: "char", keyCode: "z", modifiers: [] },
      keyUp: { type: "keyUp", keyCode: "Z", modifiers: [] },
      signal: { kind: "key", key: "z", code: "KeyZ" },
    });
  });

  it("suppresses character input for shortcuts", () => {
    expect(makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "A", modifiers: ["meta"] },
      keyUp: { type: "keyUp", keyCode: "A", modifiers: ["meta"] },
      signal: { kind: "key", key: "a", code: "KeyA" },
    });
  });

  it("adds the native shift modifier for shifted printable values", () => {
    expect(makePreviewAutomationKeySequence({ key: "!" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "1", modifiers: ["shift"] },
      char: { type: "char", keyCode: "!", modifiers: ["shift"] },
      keyUp: { type: "keyUp", keyCode: "1", modifiers: ["shift"] },
      signal: { kind: "key", key: "!", code: "Digit1" },
    });
  });
});
