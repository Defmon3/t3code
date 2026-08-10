import { defaultUrlTransform } from "react-markdown";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "./markdown-links";

export function transformMarkdownUrl(href: string, cwd?: string): string {
  const rewrittenHref = rewriteMarkdownFileUriHref(href) ?? href;
  return resolveMarkdownFileLinkTarget(rewrittenHref, cwd)
    ? rewrittenHref
    : defaultUrlTransform(rewrittenHref);
}
