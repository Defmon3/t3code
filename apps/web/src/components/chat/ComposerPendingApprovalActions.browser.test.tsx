import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const requestId = RuntimeRequestId.make("approval-1");
const providerOptions = [
  { decision: "decline", label: "Deny" },
  {
    decision: "acceptForSession",
    label: "Allow this tool for the rest of this session",
    warning: "Later calls will run without another approval.",
  },
  { decision: "accept", label: "Allow once" },
  {
    decision: "acceptAlways",
    label: `Always allow ${"x".repeat(40)}`,
    warning: "This permission will persist after the session ends.",
  },
  { decision: "cancel", label: "Cancel request" },
] as const satisfies ReadonlyArray<ProviderApprovalOption>;

type ActionsProps = Partial<ComponentProps<typeof ComposerPendingApprovalActions>>;

function actions(props: ActionsProps) {
  return (
    <ComposerPendingApprovalActions
      requestId={requestId}
      canRespond
      isResponding={false}
      onRespondToApproval={async () => undefined}
      {...props}
    />
  );
}

async function renderActions(props: ActionsProps = {}) {
  const respond = vi.fn(async () => undefined);
  const screen = await render(actions({ onRespondToApproval: respond, ...props }));
  return Object.assign(screen, { respond });
}

function findButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing approval button: ${label}`);
  return button;
}

function findMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  );
  if (!item) throw new Error(`Missing approval menu item: ${label}`);
  return item;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("ComposerPendingApprovalActions", () => {
  it.each([
    ["Decline", "decline"],
    ["Always allow this session", "acceptForSession"],
    ["Approve", "accept"],
  ])("submits %s directly without opening the menu", async (label, decision) => {
    await using screen = await renderActions();

    await click(findButton(screen.container, label));

    expect(screen.respond).toHaveBeenCalledExactlyOnceWith(requestId, decision);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("preserves provider labels and warnings for visible and secondary decisions", async () => {
    await using screen = await renderActions({ options: providerOptions });
    const sessionButton = findButton(screen.container, providerOptions[1].label);
    expect(sessionButton.getAttribute("aria-description")).toBe(providerOptions[1].warning);

    await click(sessionButton);
    expect(screen.respond).toHaveBeenCalledExactlyOnceWith(requestId, "acceptForSession");

    await click(findButton(screen.container, "More approval options"));
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    const persistentItem = findMenuItem(providerOptions[3].label);
    expect(persistentItem.getAttribute("aria-description")).toBe(providerOptions[3].warning);
    await click(persistentItem);

    expect(screen.respond).toHaveBeenLastCalledWith(requestId, "acceptAlways");
    expect(screen.respond).toHaveBeenCalledTimes(2);
  });

  it("keeps cancel available in the secondary menu", async () => {
    await using screen = await renderActions();

    await click(findButton(screen.container, "More approval options"));
    await click(findMenuItem("Cancel"));

    expect(screen.respond).toHaveBeenCalledExactlyOnceWith(requestId, "cancel");
  });

  it("does not add session approval or a menu when the provider does not offer them", async () => {
    await using screen = await renderActions({
      options: [providerOptions[0], providerOptions[2]],
    });

    expect(screen.container.querySelectorAll("button")).toHaveLength(2);
    await click(findButton(screen.container, "Deny"));
    await click(findButton(screen.container, "Allow once"));

    expect(screen.respond.mock.calls).toEqual([
      [requestId, "decline"],
      [requestId, "accept"],
    ]);
  });

  it.each([{ canRespond: false }, { isResponding: true }, { disabled: true }])(
    "blocks all visible choices and the menu when unavailable: %j",
    async (availability) => {
      await using screen = await renderActions(availability);

      for (const button of screen.container.querySelectorAll("button")) {
        expect(button.disabled).toBe(true);
        await click(button);
      }

      expect(screen.respond).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    },
  );

  it.each([{ canRespond: false }, { isResponding: true }, { disabled: true }])(
    "blocks an already open menu when availability changes: %j",
    async (availability) => {
      await using screen = await renderActions();
      await click(findButton(screen.container, "More approval options"));
      await screen.rerender(actions({ ...availability, onRespondToApproval: screen.respond }));

      const cancelItem = findMenuItem("Cancel");
      expect(cancelItem.getAttribute("aria-disabled")).toBe("true");
      await click(cancelItem);

      expect(screen.respond).not.toHaveBeenCalled();
    },
  );
});
