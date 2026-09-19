import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn<(message: string, options: { variant: "destructive" }) => Promise<boolean>>(),
  refresh: vi.fn(),
  signalProcess: vi.fn(),
  addToast: vi.fn(),
  kill: null as (() => void) | null,
}));

vi.mock("./ProjectFavicon", () => ({
  ProjectFavicon: () => null,
}));
vi.mock("./ui/button", () => ({
  Button: ({
    children,
    ...props
  }: {
    readonly children: ReactNode;
    readonly onClick?: () => void;
    readonly "aria-label"?: string;
  }) => {
    if (props["aria-label"] === "Kill test process 42") mocks.kill = props.onClick ?? null;
    return <button {...props}>{children}</button>;
  },
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { readonly render: ReactNode }) => <>{render}</>,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      processes: [
        {
          pid: 42,
          startTimeMs: 1_234,
          ppid: 0,
          childPids: [],
          command: "vitest run",
          cwd: "C:\\code\\t3code",
          cpuPercent: 2.4,
          cpuTimeMs: 1_200,
          rssBytes: 16 * 1024 * 1024,
          elapsed: "00:01",
        },
      ],
      registeredProjectWorktrees: [],
      hostCpuPercent: 2.4,
      hostMemoryUsedBytes: 16 * 1024 * 1024,
      hostMemoryTotalBytes: 32 * 1024 * 1024,
      error: Option.none(),
    },
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    processDiscovery: vi.fn(),
    signalProcess: {},
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mocks.signalProcess,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.addToast },
}));

import { ProcessPanel } from "./ProcessPanel";

const environmentId = "environment-1" as EnvironmentId;

function renderPanel() {
  mocks.kill = null;
  return renderToStaticMarkup(
    <ProcessPanel
      environmentConnectionPhase="connected"
      environmentId={environmentId}
      projects={[{ id: "project-1", title: "T3 Code", workspaceRoot: "C:\\code\\t3code" }]}
      threads={[]}
    />,
  );
}

async function clickKill() {
  renderPanel();
  const kill = mocks.kill;
  if (!kill) throw new Error("Kill control was not rendered.");
  kill();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
}

describe("ProcessPanel", () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.refresh.mockReset();
    mocks.signalProcess.mockReset();
    mocks.addToast.mockReset();
    mocks.kill = null;
  });

  it("confirms before killing a detected test run", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.signalProcess.mockResolvedValue({
      _tag: "Success",
      value: { signaled: true, message: Option.none() },
    });

    await clickKill();

    expect(mocks.confirm).toHaveBeenCalledWith(
      "Kill test process 42? This cannot be handled by the process.",
      { variant: "destructive" },
    );
    await vi.waitFor(() => {
      expect(mocks.signalProcess).toHaveBeenCalledWith({
        environmentId,
        input: { pid: 42, startTimeMs: 1_234, signal: "SIGKILL" },
      });
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not signal when termination is not confirmed", async () => {
    mocks.confirm.mockResolvedValue(false);

    await clickKill();

    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.signalProcess).not.toHaveBeenCalled();
  });

  it("shows the server message when the process was not signaled", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.signalProcess.mockResolvedValue({
      _tag: "Success",
      value: { signaled: false, message: Option.some("Process no longer exists.") },
    });

    await clickKill();

    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith({
        type: "error",
        title: "Could not kill test process",
        description: "Process no longer exists.",
      });
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows an error when the kill RPC rejects", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.signalProcess.mockRejectedValue(new Error("Connection lost."));

    await clickKill();

    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith({
        type: "error",
        title: "Could not kill test process",
        description: "Connection lost.",
      });
    });
  });
});
