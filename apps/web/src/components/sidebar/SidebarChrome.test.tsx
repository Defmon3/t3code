import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => <a>{children}</a>,
  useLocation: () => null,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../branding", () => ({
  APP_BUILD_TIME: "2026-08-13T10:00:00.000Z",
  APP_COMMIT_HASH: "b1b5c80c00e68cf4",
  APP_VERSION: "0.0.34-nightly.20260813.1000",
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "artwork",
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../SidebarStageBackdrop", () => ({
  formatBuildIdentityLabel: () => "Custom build",
  resolveEnvironmentIdentificationPillLabel: (
    _stageLabel: string,
    buildIdentity: {
      readonly version: string;
      readonly commitHash: string | null;
      readonly buildTime: string | null;
    },
  ) =>
    buildIdentity.commitHash &&
    buildIdentity.buildTime &&
    /-nightly\.\d{8}\.\d+$/.test(buildIdentity.version)
      ? "Custom"
      : null,
  resolveSidebarStageBackdropVariant: () => null,
  resolveSidebarStageFocusRingOffsetClass: () => "",
  SidebarStageBackdrop: () => null,
  useEnvironmentStageLabel: () => "Latest",
}));
vi.mock("../ui/sidebar", () => ({
  SidebarFooter: ({ children }: { readonly children: ReactNode }) => <footer>{children}</footer>,
  SidebarHeader: ({ children }: { readonly children: ReactNode }) => <header>{children}</header>,
  SidebarMenu: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { readonly children: ReactNode }) => (
    <button>{children}</button>
  ),
  SidebarMenuItem: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button />,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => children,
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render }: { readonly render: ReactNode }) => render,
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdateArchitectureWarning: () => null,
  SidebarUpdatePill: () => null,
}));

import { SidebarChromeHeader } from "./SidebarChrome";

describe("SidebarChromeHeader", () => {
  it("renders a keyboard-focusable custom build pill when the server reports Latest", () => {
    const html = renderToStaticMarkup(<SidebarChromeHeader isElectron />);

    expect(html).toContain('data-environment-identification="pill"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(">Custom build</span>");
  });
});
