// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectSkillShortcutBar } from "./ProjectSkillShortcutBar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderBar(props: Partial<ComponentProps<typeof ProjectSkillShortcutBar>> = {}) {
  const onChange = vi.fn(async () => undefined);
  await act(() =>
    root.render(
      <ProjectSkillShortcutBar
        shortcuts={[]}
        colors={{}}
        onChange={onChange}
        onInvoke={vi.fn()}
        onInsert={vi.fn()}
        {...props}
      />,
    ),
  );
  return onChange;
}

function findButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing quick slot button: ${label}`);
  return button;
}

async function enterShortcut(value: string) {
  await act(() => findButton("Add quick slot").click());
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing quick slot input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing native input value setter");
  await act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("ProjectSkillShortcutBar editing", () => {
  it("saves entered text when focus leaves the input", async () => {
    const save = await renderBar();
    const input = await enterShortcut("  review changes  ");

    await act(() => input.blur());

    expect(save).toHaveBeenCalledExactlyOnceWith(["review changes"], {});
    expect(findButton("review changes")).toBeDefined();
    expect(container.querySelector("input")).toBeNull();
  });

  it("saves once when Enter is followed by losing focus", async () => {
    const save = await renderBar();
    const input = await enterShortcut("review changes");

    await act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.blur();
    });

    expect(save).toHaveBeenCalledExactlyOnceWith(["review changes"], {});
    expect(findButton("review changes")).toBeDefined();
  });

  it("discards text on Escape without saving it on later focus changes", async () => {
    const save = await renderBar();
    const input = await enterShortcut("discard this");

    await act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(() => input.blur());

    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("discard this");
  });

  it.each(["   ", "review changes"])(
    "does not save unchanged slots after entering %j",
    async (value) => {
      const save = await renderBar({ shortcuts: ["review changes"] });
      const input = await enterShortcut(value);

      await act(() => input.blur());

      expect(save).not.toHaveBeenCalled();
      expect(findButton("review changes")).toBeDefined();
      expect(container.querySelector("input")).toBeNull();
    },
  );

  it("shows a failed blur save and retries the entered text", async () => {
    const save = vi.fn<ComponentProps<typeof ProjectSkillShortcutBar>["onChange"]>();
    save.mockRejectedValueOnce(new Error("Quick slot save failed")).mockResolvedValue(undefined);
    await renderBar({ onChange: save });
    const input = await enterShortcut("review changes");

    await act(() => input.blur());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Quick slot save failed",
    );
    expect(container.querySelector('[aria-label="review changes"]')).toBeNull();

    await act(() => findButton("Retry").click());

    expect(save.mock.calls).toEqual([
      [["review changes"], {}],
      [["review changes"], {}],
    ]);
    expect(findButton("review changes")).toBeDefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
