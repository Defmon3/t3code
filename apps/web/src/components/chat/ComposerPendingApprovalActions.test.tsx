// @vitest-environment jsdom

import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderActions(
  props: Partial<ComponentProps<typeof ComposerPendingApprovalActions>> = {},
) {
  const onRespondToApproval = vi.fn(async () => undefined);
  await act(async () => {
    root.render(
      <ComposerPendingApprovalActions
        requestId={requestId}
        canRespond
        isResponding={false}
        onRespondToApproval={onRespondToApproval}
        {...props}
      />,
    );
  });
  return onRespondToApproval;
}

function findButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing approval button: ${label}`);
  return button;
}

function findMenuItem(label: string) {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
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
    const respond = await renderActions();

    await click(findButton(label));

    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, decision);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("preserves provider labels and warnings for visible and secondary decisions", async () => {
    const respond = await renderActions({ options: providerOptions });
    const sessionButton = findButton(providerOptions[1].label);
    expect(sessionButton.getAttribute("aria-description")).toBe(providerOptions[1].warning);

    await click(sessionButton);
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "acceptForSession");

    await click(findButton("More approval options"));
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    const persistentItem = findMenuItem(providerOptions[3].label);
    expect(persistentItem.getAttribute("aria-description")).toBe(providerOptions[3].warning);
    await click(persistentItem);

    expect(respond).toHaveBeenLastCalledWith(requestId, "acceptAlways");
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("keeps cancel available in the secondary menu", async () => {
    const respond = await renderActions();

    await click(findButton("More approval options"));
    await click(findMenuItem("Cancel"));

    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "cancel");
  });

  it("does not add session approval or a menu when the provider does not offer them", async () => {
    const respond = await renderActions({
      options: [providerOptions[0], providerOptions[2]],
    });

    expect(container.querySelectorAll("button")).toHaveLength(2);
    await click(findButton("Deny"));
    await click(findButton("Allow once"));

    expect(respond.mock.calls).toEqual([
      [requestId, "decline"],
      [requestId, "accept"],
    ]);
  });

  it.each([{ canRespond: false }, { isResponding: true }, { disabled: true }])(
    "blocks all visible choices and the menu when unavailable: %j",
    async (availability) => {
      const respond = await renderActions(availability);

      for (const button of container.querySelectorAll("button")) {
        expect(button.disabled).toBe(true);
        await click(button);
      }

      expect(respond).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    },
  );

  it.each([{ canRespond: false }, { isResponding: true }, { disabled: true }])(
    "blocks an already open menu when availability changes: %j",
    async (availability) => {
      const respond = vi.fn(async () => undefined);
      await renderActions({ onRespondToApproval: respond });
      await click(findButton("More approval options"));
      await renderActions({ ...availability, onRespondToApproval: respond });

      const cancelItem = findMenuItem("Cancel");
      expect(cancelItem.getAttribute("aria-disabled")).toBe("true");
      await click(cancelItem);

      expect(respond).not.toHaveBeenCalled();
    },
  );
});
