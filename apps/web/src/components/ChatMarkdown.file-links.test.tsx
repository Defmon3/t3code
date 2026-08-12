import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type FileLinkElement = ReactElement<{
  readonly onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}>;

const captured = vi.hoisted(() => ({ link: null as FileLinkElement | null }));
const mocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  openFile: vi.fn(),
  openInBrowser: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => () => false }));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: "asset-url" } }));
vi.mock("../state/entities", () => ({ useActiveEnvironmentId: () => "env-1" }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: "preview-open" } }));
vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "server-config" },
}));
vi.mock("../state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "http://environment" } }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.createAssetUrl,
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
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { readonly render: ReactElement }) => {
    captured.link = render as FileLinkElement;
    return render;
  },
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => children,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

function renderChatLink(path: string, withThread = true) {
  captured.link = null;
  renderToStaticMarkup(
    <ChatMarkdown
      text={`[Open the file](file:///${path})`}
      cwd="G:/workspace"
      threadRef={withThread ? threadRef : undefined}
    />,
  );
  const link = captured.link as FileLinkElement | null;
  const onClick = link?.props.onClick;
  expect(onClick).toBeTypeOf("function");
  return onClick as (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

describe("ChatMarkdown file link routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openInBrowser.mockResolvedValue({ _tag: "Success" });
    mocks.openInEditor.mockResolvedValue({ _tag: "Success" });
  });

  it("opens workspace HTML with the relative path required by browser preview", async () => {
    const click = renderChatLink("G:/workspace/previews/report.html");

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(mocks.openInBrowser).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: "previews/report.html" }),
      );
    });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.openInEditor).not.toHaveBeenCalled();
  });

  it.each(["README.md", "screenshots/result.png"])(
    "keeps %s in the existing T3 file panel flow",
    async (relativePath) => {
      const click = renderChatLink(`G:/workspace/${relativePath}`);

      click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

      await vi.waitFor(() => {
        expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, relativePath, undefined);
      });
      expect(mocks.openInBrowser).not.toHaveBeenCalled();
      expect(mocks.openInEditor).not.toHaveBeenCalled();
    },
  );

  it("keeps the editor fallback when no thread panel is available", async () => {
    const click = renderChatLink("G:/workspace/README.md", false);

    click({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    await vi.waitFor(() => {
      expect(mocks.openInEditor).toHaveBeenCalledExactlyOnceWith("G:/workspace/README.md");
    });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.openInBrowser).not.toHaveBeenCalled();
  });
});
