import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatBuildIdentityLabel,
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  StageBackdropArt,
  StageBackdropButtonArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("formats an identifiable custom nightly build", () => {
    expect(
      formatBuildIdentityLabel({
        stageLabel: "Custom",
        commitHash: "f0a8937d8d41cafe",
        buildTime: "2026-08-10T17:20:31.000Z",
      }),
    ).toBe("Custom · 2026-08-10 17:20Z · f0a8937d");
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

  it.each(["Latest", "Alpha", ""])(
    "resolves a custom client build independently of the %s server stage",
    (stageLabel) => {
      expect(
        resolveEnvironmentIdentificationPillLabel(stageLabel, {
          version: "0.0.34-nightly.20260813.1000",
          commitHash: "b1b5c80c00e68cf4",
          buildTime: "2026-08-13T10:00:00.000Z",
        }),
      ).toBe("Custom");
    },
  );

  it("does not identify an ordinary stable build as custom", () => {
    expect(
      resolveEnvironmentIdentificationPillLabel("Latest", {
        version: "0.0.34",
        commitHash: "b1b5c80c00e68cf4",
        buildTime: "2026-08-13T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("matches the focus-ring offset to each artwork palette", () => {
    expect(resolveSidebarStageFocusRingOffsetClass("nightly")).toBe(
      "focus-visible:ring-offset-(--stage-night-bottom)",
    );
    expect(resolveSidebarStageFocusRingOffsetClass("dev")).toBe(
      "focus-visible:ring-offset-(--stage-art-bottom)",
    );
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

  it("paints each artwork variant with theme-owned color tokens", () => {
    const nightlyMarkup = renderToStaticMarkup(<StageBackdropArt variant="nightly" />);
    const devMarkup = renderToStaticMarkup(<StageBackdropArt variant="dev" />);

    expect(nightlyMarkup).toContain("var(--stage-night-bottom)");
    expect(nightlyMarkup).toContain("var(--stage-night-line)");
    expect(devMarkup).toContain("var(--stage-art-bottom)");
    expect(devMarkup).toContain("var(--stage-art-line)");
    expect(nightlyMarkup).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(devMarkup).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it.each([
    ["nightly", "96 0 8192 96"],
    ["dev", "64 0 8192 96"],
  ] as const)("uses the compact %s crop inside the send button", (variant, viewBox) => {
    const markup = renderToStaticMarkup(<StageBackdropButtonArt variant={variant} />);

    expect(markup).toContain(`viewBox="${viewBox}"`);
    expect(markup).toContain(`stage-${variant === "dev" ? "blueprint" : "nightly"}`);
  });
});
