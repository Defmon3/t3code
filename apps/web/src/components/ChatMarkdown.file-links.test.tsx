import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

type FileLinkElement = ReactElement<{
  readonly onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}>;

const captured = vi.hoisted(() => ({ link: null as FileLinkElement | null }));
const mocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  openFile: vi.fn(),
  openInBrowser: vi.fn(),
  openInEditor: vi.fn(),
  resolveProjectFile: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));

vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => () => false }));

vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: "asset-url" } }));

vi.mock("../state/entities", () => ({ useActiveEnvironmentId: () => "active-environment" }));

vi.mock("../state/preview", () => ({ previewEnvironment: { open: "preview-open" } }));

vi.mock("../state/projects", () => ({ projectEnvironment: { resolveFile: "project-resolve-file" } }));

vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "server-config" },
}));

vi.mock("../state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "http://environment" } }),
}));

vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: string) =>
    family === "project-resolve-file" ? mocks.resolveProjectFile : mocks.createAssetUrl,
}));

vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => mocks.openInEditor }));

vi.mock("../previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));

vi.mock("../browser/openFileInPreview", () => ({
  BrowserPreviewUnavailableError: class BrowserPreviewUnavailableError extends Error {},
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: mocks.openInBrowser,
  openUrlInPreview: vi.fn(),
}));

vi.mock("./chat/FileTagChip", () => ({
  CHAT_FILE_TAG_CHIP_CLASS_NAME: "file-tag",
  FileTagChipContent: ({ label }: { readonly label: string }) => <span>{label}</span>,
}));

vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: mocks.openFile }) },
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: mocks.toastAdd },
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { readonly render: ReactElement }) => {
    captured.link = render as FileLinkElement;
    return render;
  },
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => children,
}));

import ChatMarkdown, { MarkdownFileLink } from "./ChatMarkdown";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

function renderFileLink(input: {
  readonly resolveWorkspaceRelativePath: () => Promise<string | null>;
  readonly onOpenInBrowser?:
    | ((path: string) => Promise<AtomCommandResult<unknown, unknown>>)
    | undefined;
}) {
  captured.link = null;
  renderToStaticMarkup(
    <MarkdownFileLink
      href="G:/workspace/link-tests/test.html"
      targetPath="G:/workspace/link-tests/test.html"
      iconPath="G:/workspace/link-tests/test.html"
      displayPath="link-tests/test.html"
      workspaceRelativePath={null}
      label="test.html"
      copyMarkdown="[test](G:/workspace/link-tests/test.html)"
      theme="dark"
      threadRef={threadRef}
      onOpen={mocks.openInEditor}
      resolveWorkspaceRelativePath={input.resolveWorkspaceRelativePath}
      onOpenInBrowser={input.onOpenInBrowser}
    />,
  );
  const link = captured.link as FileLinkElement | null;
  const onClick = link?.props.onClick;
  expect(onClick).toBeTypeOf("function");
  return onClick as (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

describe("MarkdownFileLink in-app routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectFile.mockResolvedValue({
      _tag: "Success",
      value: { relativePath: "link-tests/test.html" },
    });
    mocks.openInBrowser.mockResolvedValue({ _tag: "Success" });
  });

  it("routes a resolved workspace file to the file panel", async () => {
    const click = renderFileLink({
      resolveWorkspaceRelativePath: async () => "link-tests/test.html",
    });

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        "link-tests/test.html",
        undefined,
      );
    });
    expect(mocks.openInEditor).not.toHaveBeenCalled();
  });

  it("does not route an unresolvable target to an editor or panel", async () => {
    const click = renderFileLink({ resolveWorkspaceRelativePath: async () => null });

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(mocks.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Unable to open file" }));
    });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.openInEditor).not.toHaveBeenCalled();
  });

  it("resolves an HTML target before opening it in the integrated browser", async () => {
    mocks.openInBrowser.mockResolvedValue({ _tag: "Success" });
    const click = renderFileLink({
      resolveWorkspaceRelativePath: async () => "link-tests/test.html",
      onOpenInBrowser: mocks.openInBrowser,
    });

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(mocks.openInBrowser).toHaveBeenCalledExactlyOnceWith("link-tests/test.html");
    });
    expect(mocks.openFile).not.toHaveBeenCalled();
  });

  it("uses the thread environment to resolve a chat link before opening the panel", async () => {
    captured.link = null;
    renderToStaticMarkup(
      <ChatMarkdown
        text="[Open the file](file:///linked-workspace/link-tests/test.html)"
        cwd="/workspace"
        threadRef={threadRef}
      />,
    );
    const link = captured.link as FileLinkElement | null;
    const click = link?.props.onClick;
    expect(click).toBeTypeOf("function");

    (click as (event: { preventDefault: () => void; stopPropagation: () => void }) => void)({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(mocks.resolveProjectFile).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env-1",
        input: { cwd: "/workspace", path: "/linked-workspace/link-tests/test.html" },
      });
      expect(mocks.openInBrowser).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: "link-tests/test.html" }),
      );
    });
  });
});
