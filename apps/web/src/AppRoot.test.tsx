import { RouterProvider } from "@tanstack/react-router";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./rightPanelStore", () => ({
  useRightPanelStore: <T,>(
    selector: (state: { byEnvironmentId: Record<string, { surfaces: readonly unknown[] }> }) => T,
  ) => selector({ byEnvironmentId: { "environment-1": { surfaces: [{}] } } }),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: <T,>(selector: T) => selector,
}));

import { AppRoot } from "./AppRoot";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PersistentProcessPanelHosts } from "./components/ProcessPanelSurface";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

describe("AppRoot", () => {
  it("renders persistent process hosts from environment panel state", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(5);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
    expect(isValidElement(children[1]) && children[1].type).toBe(PreviewAutomationHosts);
    expect(isValidElement(children[2]) && children[2].type).toBe(PersistentProcessPanelHosts);
    expect(
      isValidElement<{ readonly environmentIds: readonly string[] }>(children[2]) &&
        children[2].props.environmentIds,
    ).toEqual(["environment-1"]);
    expect(isValidElement(children[3]) && children[3].type).toBe(ElectronBrowserHost);
    expect(isValidElement(children[4]) && children[4].type).toBe(QuitHoldOverlay);
  });
});
