import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it, vi } from "vite-plus/test";

import { transformMarkdownUrl } from "./markdown-url-transform";

describe("markdown Windows file links", () => {
  it.each([
    "G:/argus/plans/local-plan.md",
    "G:/argus/reports/preview.html",
    "G:/argus/screenshots/result.png",
  ])("delivers %s to the rendered link", (target) => {
    const onLink = vi.fn();

    renderToStaticMarkup(
      <ReactMarkdown
        urlTransform={(href) => transformMarkdownUrl(href, "G:/argus")}
        components={{
          a({ href, children }) {
            onLink(href);
            return <a href={href}>{children}</a>;
          },
        }}
      >
        {`[Open the file](${target})`}
      </ReactMarkdown>,
    );

    expect(onLink).toHaveBeenCalledExactlyOnceWith(target);
  });
});
