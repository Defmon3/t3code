import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatBuildIdentityLabel,
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("formats an identifiable custom nightly build", () => {
    expect(
      formatBuildIdentityLabel({
        stageLabel: "Custom",
        version: "0.0.34-nightly.20260810.1059",
        commitHash: "f0a8937d8d41cafe",
        buildTime: "2026-08-10T17:20:31.000Z",
      }),
    ).toBe("Custom · 2026-08-10 · n1059 · f0a8937d");
  });

  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Custom");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
