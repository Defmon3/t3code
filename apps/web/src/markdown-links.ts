import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination as normalizeClientMarkdownLinkDestination,
  parseFileUrlHref,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation, resolvePathLinkTarget } from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function isWindowsDrivePathHref(href: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(safeDecodeURIComponent(href));
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const normalized = normalizeClientMarkdownLinkDestination(value);
  return WINDOWS_DRIVE_PATH_PATTERN.test(normalized)
    ? normalized.replaceAll("\\", "/")
    : normalized;
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

export function normalizeMarkdownFileLinkHrefKey(href: string): string {
  const normalized = normalizeMarkdownLinkDestination(href);
  const rewritten = rewriteMarkdownFileUriHref(normalized) ?? normalized;
  if (!WINDOWS_DRIVE_PATH_PATTERN.test(rewritten)) return rewritten;

  const target = parseFileUrlHref(`file:///${rewritten}`);
  return target ? `${target.path}${target.hash}` : rewritten;
}

interface MarkdownLinkNode {
  type?: string;
  url?: unknown;
  children?: MarkdownLinkNode[];
}

export function remarkRewriteWindowsFileLinks() {
  return (tree: MarkdownLinkNode) => {
    const visit = (node: MarkdownLinkNode) => {
      if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
        const url = normalizeMarkdownLinkDestination(node.url);
        if (WINDOWS_DRIVE_PATH_PATTERN.test(url)) node.url = `file:///${url}`;
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(normalizeMarkdownLinkDestination(href));
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) return pathWithPosition;
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  return candidate === null ? null : resolveMarkdownFileLinkMeta(candidate, cwd, baseDir);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  return targetPath ? buildFileLinkMetaFromTarget(targetPath, cwd) : null;
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}
