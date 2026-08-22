import { describe, expect, it } from "vite-plus/test";

import { resolveComposerCommandMenuPosition } from "./ChatComposer";

describe("resolveComposerCommandMenuPosition", () => {
  it("places the menu immediately above the full composer without covering a quick-slot bar", () => {
    const position = resolveComposerCommandMenuPosition({
      verticalAnchor: { top: 697 },
      horizontalAnchor: { left: 80, width: 768 },
      viewportHeight: 800,
      drawerInset: 22,
    });

    expect(position).toEqual({ bottom: 103, left: 102, maxHeight: 673, width: 724 });
  });
});
