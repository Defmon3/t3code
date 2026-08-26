import { RouterProvider } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { PersistentProcessPanelHosts } from "./components/ProcessPanelSurface";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { useRightPanelStore } from "./rightPanelStore";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  const processPanelEnvironmentIds = useRightPanelStore(
    useShallow((state) =>
      Object.entries(state.byEnvironmentId)
        .filter(([, panel]) => panel.surfaces.length > 0)
        .map(([environmentId]) => environmentId),
    ),
  );
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <PersistentProcessPanelHosts environmentIds={processPanelEnvironmentIds} />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
