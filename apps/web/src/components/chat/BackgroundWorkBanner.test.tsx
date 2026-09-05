import { act, isValidElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const renderedButtons = vi.hoisted(
  () => [] as Array<{ label: string; expanded?: boolean; controls?: string; onClick?: () => void }>,
);
const renderedDetailRows = vi.hoisted(() => [] as string[]);

function renderedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderedText).join("");
  return isValidElement<{ children?: unknown }>(value) ? renderedText(value.props.children) : "";
}

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-controls": controls,
    "aria-expanded": expanded,
  }: {
    children: string;
    onClick?: () => void;
    "aria-controls"?: string;
    "aria-expanded"?: boolean;
  }) => {
    renderedButtons.push({
      label: children,
      ...(expanded === undefined ? {} : { expanded }),
      ...(controls === undefined ? {} : { controls }),
      ...(onClick === undefined ? {} : { onClick }),
    });
    return null;
  },
}));
vi.mock("./ComposerBanner", () => ({
  ComposerBanner: {
    Row: ({ children, role }: { children: unknown; role?: string }) => {
      if (role === "listitem") renderedDetailRows.push(renderedText(children));
      return children;
    },
    Icon: ({ children }: { children: unknown }) => children,
    Dot: () => null,
    Content: ({ children }: { children: unknown }) => children,
    Actions: ({ children }: { children: unknown }) => children,
    Scroll: ({ children }: { children: unknown }) => children,
    Children: ({ children }: { children: unknown }) => children,
  },
}));

import { BackgroundWorkBanner, backgroundWorkSummary } from "./BackgroundWorkBanner.tsx";

let root: Root;

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.textContent = value;
    return node;
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

beforeEach(() => {
  const document = new TestNode("#document", null, 9);
  const container = document.createElement("div");
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renderedButtons.length = 0;
  renderedDetailRows.length = 0;
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("backgroundWorkSummary", () => {
  it("uses the concrete item count and first task title", () => {
    expect(
      backgroundWorkSummary([
        {
          taskId: "review",
          category: "agent",
          title: "Review auth flow",
          status: "running",
        },
        {
          taskId: "watch",
          category: "monitor",
          status: "waiting",
        },
      ]),
    ).toEqual({ title: "2 background tasks", description: "Review auth flow" });
  });

  it("shows every live item when Details is activated and removes them when hidden", async () => {
    await act(() => {
      root.render(
        <BackgroundWorkBanner
          items={[
            { taskId: "review", category: "agent", title: "Review auth flow", status: "running" },
            { taskId: "watch", category: "monitor", title: "Watch CI", status: "waiting" },
          ]}
          isStopping={false}
          onStop={() => undefined}
        />,
      );
    });
    expect(renderedDetailRows).toEqual([]);

    const details = renderedButtons.find((button) => button.label === "Details");
    expect(details?.expanded).toBe(false);
    expect(details?.controls).toBeTruthy();
    await act(() => details?.onClick?.());
    expect(renderedDetailRows).toEqual([
      "Review auth flowagent · running",
      "Watch CImonitor · waiting",
    ]);

    const hide = renderedButtons.find((button) => button.label === "Hide details");
    expect(hide?.expanded).toBe(true);
    expect(hide?.controls).toBe(details?.controls);
    renderedDetailRows.length = 0;
    await act(() => hide?.onClick?.());
    expect(renderedDetailRows).toEqual([]);
  });
});
