import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarChromePillLabel } from "./SidebarChrome";

describe("SidebarChrome", () => {
  it("shows custom build identity independently of the connected server channel", () => {
    expect(resolveSidebarChromePillLabel("Nightly", "artwork")).toBe("Custom");
    expect(resolveSidebarChromePillLabel("Alpha", "artwork")).toBeNull();
  });

  it("respects pill mode for development builds", () => {
    expect(resolveSidebarChromePillLabel("Dev", "pill")).toBe("Dev");
    expect(resolveSidebarChromePillLabel("Dev", "artwork")).toBeNull();
    expect(resolveSidebarChromePillLabel("Dev", "none")).toBeNull();
  });
});
