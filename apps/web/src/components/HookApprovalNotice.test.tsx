import { EnvironmentId, HookApprovalRequestId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ScopedHookApprovalRequest } from "@t3tools/client-runtime/state/hook-approvals";

const { approvals } = vi.hoisted(() => ({
  approvals: [] as Array<ScopedHookApprovalRequest>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => approvals }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { HookApprovalNotice } from "./HookApprovalNotice";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  approvals.length = 0;
  await act(() => renderer?.unmount());
  renderer = undefined;
});

function approval(threadId: string) {
  return {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make(threadId),
    requestId: HookApprovalRequestId.make("approval-a"),
    createdAt: DateTime.makeUnsafe("2026-09-11T10:00:00.000Z"),
    command: "git status",
    cwd: "G:\\workspace",
    reason: "Check the worktree",
  };
}

async function renderNotice(initialEntry: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <HookApprovalNotice />
        <Outlet />
      </>
    ),
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  await act(() => {
    renderer = create(<RouterProvider router={router} />);
  });
  return router;
}

describe("HookApprovalNotice", () => {
  it("opens the requesting thread from another active thread", async () => {
    approvals.push(approval("thread-a"));
    const router = await renderNotice("/environment-a/thread-b");

    const link = renderer!.root.findAllByType(Link)[0]!;
    expect(link.props.params).toEqual({ environmentId: "environment-a", threadId: "thread-a" });
    await act(async () => {
      await router.navigate({ to: link.props.to, params: link.props.params });
      renderer!.update(<RouterProvider router={router} />);
    });

    expect(router.state.location.pathname).toBe("/environment-a/thread-a");
  });

  it("hides when no approval remains", async () => {
    await renderNotice("/environment-a/thread-b");

    expect(
      renderer!.root.findAllByProps({ "aria-label": "Open pending custom hook approval" }),
    ).toHaveLength(0);
  });
});
