import { describe, expect, it } from "vite-plus/test";

import { transformMarkdownUrl } from "./markdown-url-transform";

describe("transformMarkdownUrl", () => {
  it("preserves absolute Windows file paths for the markdown file-link renderer", () => {
    expect(transformMarkdownUrl("G:/argus/audits/local-file-links.md")).toBe(
      "G:/argus/audits/local-file-links.md",
    );
  });

  it("continues to reject unsupported URI schemes", () => {
    expect(transformMarkdownUrl("javascript:alert(1)")).toBe("");
  });
});
