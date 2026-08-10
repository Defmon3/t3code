import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ClickableAnchorElement = ReactElement<{
  readonly onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}>;

const capturedFileLink = vi.hoisted(() => ({ element: null as ClickableAnchorElement | null }));
const chatMarkdownMocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  editorHook: vi.fn(),
  openFileInPreview: vi.fn(),
  openFilePanel: vi.fn(),
  openInEditor: vi.fn(),
  resolveProjectFile: vi.fn(),
  serverConfigAtom: vi.fn(() => "server-config"),
  toastAdd: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));

vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: "asset-url" } }));

vi.mock("../state/entities", () => ({
  useActiveEnvironmentId: () => "active-environment",
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));

vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => null }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../state/preview", () => ({ previewEnvironment: { open: "preview-open" } }));

vi.mock("../state/projects", () => ({
  projectEnvironment: { resolveFile: "project-resolve-file" },
}));

vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: chatMarkdownMocks.serverConfigAtom },
}));

vi.mock("../state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "http://environment" } }),
}));

vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: string) =>
    family === "project-resolve-file"
      ? chatMarkdownMocks.resolveProjectFile
      : chatMarkdownMocks.createAssetUrl,
}));

vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: (environmentId: string) => {
    chatMarkdownMocks.editorHook(environmentId);
    return chatMarkdownMocks.openInEditor;
  },
}));

vi.mock("../previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));

vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: chatMarkdownMocks.openFilePanel }) },
}));

vi.mock("../browser/openFileInPreview", () => ({
  BrowserPreviewUnavailableError: class BrowserPreviewUnavailableError extends Error {},
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: chatMarkdownMocks.openFileInPreview,
  openUrlInPreview: vi.fn(),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { readonly render: ReactElement }) => {
    capturedFileLink.element = render as ClickableAnchorElement;
    return render;
  },
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => children,
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: chatMarkdownMocks.toastAdd },
}));

import {
  MarkdownFileLink,
  openMarkdownBrowserFileInT3,
  openMarkdownFileInT3,
} from "./ChatMarkdown";
import ChatMarkdown from "./ChatMarkdown";
import { resolveMarkdownFileLinkMeta } from "../markdown-links";

const threadRef = {
  environmentId: "env-1",
  threadId: "thread-1",
} as never;

function renderChatMarkdownLink(
  path: string,
): (event: { preventDefault: () => void; stopPropagation: () => void }) => void {
  expect(resolveMarkdownFileLinkMeta(path, "G:/t3-code/t3code-terminal")).not.toBeNull();
  capturedFileLink.element = null;
  const markup = renderToStaticMarkup(
    <ChatMarkdown
      text={`[Open the file](${path})`}
      cwd="G:/t3-code/t3code-terminal"
      threadRef={threadRef}
      lineBreaks
    />,
  );
  expect(markup).toContain("chat-markdown-file-link");
  const element = capturedFileLink.element as ClickableAnchorElement | null;
  const click = element?.props.onClick;
  expect(click).toBeTypeOf("function");
  return click as (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

describe("ChatMarkdown file-link click action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatMarkdownMocks.resolveProjectFile.mockResolvedValue({
      _tag: "Success",
      value: { relativePath: ".t3/link-tests/test.md" },
    });
    chatMarkdownMocks.openFileInPreview.mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it.each([
    ["test.md", ".t3/link-tests/test.md"],
    ["test.html", ".t3/link-tests/test.html"],
    ["test.png", ".t3/link-tests/test.png"],
  ])(
    "opens %s in the T3 file panel after resolving its junction path",
    async (_name, relativePath) => {
      const resolveWorkspaceRelativePath = vi.fn(async () => relativePath);
      const openFile = vi.fn();

      const opened = await openMarkdownFileInT3({
        threadRef,
        line: undefined,
        workspaceRelativePath: null,
        resolveWorkspaceRelativePath,
        openFile,
      });

      expect(opened).toBe(true);
      expect(resolveWorkspaceRelativePath).toHaveBeenCalledExactlyOnceWith();
      expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, relativePath, undefined);
    },
  );

  it("does not open a path the server refuses to resolve within the project", async () => {
    const openFile = vi.fn();

    const opened = await openMarkdownFileInT3({
      threadRef,
      line: 4,
      workspaceRelativePath: null,
      resolveWorkspaceRelativePath: async () => null,
      openFile,
    });

    expect(opened).toBe(false);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("resolves an HTML link before invoking the integrated-browser action", async () => {
    const resolveWorkspaceRelativePath = vi.fn(async () => ".t3/link-tests/test.html");
    const openInBrowser = vi.fn(async () => ({ _tag: "Success", value: undefined }) as never);

    const result = await openMarkdownBrowserFileInT3({
      workspaceRelativePath: null,
      resolveWorkspaceRelativePath,
      openInBrowser,
    });

    expect(resolveWorkspaceRelativePath).toHaveBeenCalledExactlyOnceWith();
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(".t3/link-tests/test.html");
    expect(result?._tag).toBe("Success");
  });

  it("clicking an HTML MarkdownFileLink resolves before opening the integrated browser", async () => {
    const resolveWorkspaceRelativePath = vi.fn(async () => ".t3/link-tests/test.html");
    const openInBrowser = vi.fn(async () => ({ _tag: "Success", value: undefined }) as never);

    renderToStaticMarkup(
      <MarkdownFileLink
        href="G:/t3-code/t3code/.t3/link-tests/test.html"
        targetPath="G:/t3-code/t3code/.t3/link-tests/test.html"
        iconPath="G:/t3-code/t3code/.t3/link-tests/test.html"
        displayPath=".t3/link-tests/test.html"
        workspaceRelativePath={null}
        label="test.html"
        copyMarkdown="[test.html](G:/t3-code/t3code/.t3/link-tests/test.html)"
        theme="dark"
        threadRef={threadRef}
        onOpen={async () => ({ _tag: "Success", value: undefined }) as never}
        resolveWorkspaceRelativePath={resolveWorkspaceRelativePath}
        onOpenInBrowser={openInBrowser}
      />,
    );

    const click = capturedFileLink.element?.props.onClick;
    expect(click).toBeTypeOf("function");
    click?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(resolveWorkspaceRelativePath).toHaveBeenCalledExactlyOnceWith();
      expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(".t3/link-tests/test.html");
    });
  });

  it("uses the thread environment and resolved path for a rendered HTML ChatMarkdown click", async () => {
    chatMarkdownMocks.resolveProjectFile.mockResolvedValue({
      _tag: "Success",
      value: { relativePath: ".t3/link-tests/test.html" },
    });
    const click = renderChatMarkdownLink("G:/t3-code/t3code/.t3/link-tests/test.html");

    expect(chatMarkdownMocks.editorHook).toHaveBeenCalledWith("env-1");
    expect(chatMarkdownMocks.serverConfigAtom).toHaveBeenCalledWith("env-1");
    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(chatMarkdownMocks.resolveProjectFile).toHaveBeenCalledWith({
        environmentId: "env-1",
        input: {
          cwd: "G:/t3-code/t3code-terminal",
          path: "g:/t3-code/t3code/.t3/link-tests/test.html",
        },
      });
      expect(chatMarkdownMocks.openFileInPreview).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: ".t3/link-tests/test.html", threadRef }),
      );
      expect(chatMarkdownMocks.openFilePanel).not.toHaveBeenCalled();
    });
  });

  it("uses the right panel instead of browser preview for a rendered Markdown click", async () => {
    const click = renderChatMarkdownLink("G:/t3-code/t3code/.t3/link-tests/test.md");

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(chatMarkdownMocks.openFilePanel).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        ".t3/link-tests/test.md",
        undefined,
      );
      expect(chatMarkdownMocks.openFileInPreview).not.toHaveBeenCalled();
    });
  });

  it("opens a rendered PNG link in the T3 right-panel image preview", async () => {
    chatMarkdownMocks.resolveProjectFile.mockResolvedValue({
      _tag: "Success",
      value: { relativePath: ".t3/link-tests/test.png" },
    });
    const click = renderChatMarkdownLink("G:/t3-code/t3code/.t3/link-tests/test.png");

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(chatMarkdownMocks.openFilePanel).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        ".t3/link-tests/test.png",
        undefined,
      );
      expect(chatMarkdownMocks.openFileInPreview).not.toHaveBeenCalled();
    });
  });

  it("keeps a rejected rendered ChatMarkdown link in T3 and explains why", async () => {
    chatMarkdownMocks.resolveProjectFile.mockResolvedValue({ _tag: "Failure", cause: {} });
    const click = renderChatMarkdownLink("G:/t3-code/t3code/.t3/link-tests/test.md");

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(chatMarkdownMocks.openFilePanel).not.toHaveBeenCalled();
      expect(chatMarkdownMocks.openInEditor).not.toHaveBeenCalled();
      expect(chatMarkdownMocks.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Unable to open file" }),
      );
    });
  });
});
