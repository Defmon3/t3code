import { describe, expect, it } from "vite-plus/test";
import { isValidElement, type ReactElement } from "react";
import {
  componentElement,
  commit,
  environmentId,
  flushEffects,
  gitRef,
  historyState,
  page,
  renderPanel,
} from "./GitHistoryPanel.test-fixture";
import { visitElements } from "../test/reactElementTree";

function syncSelectedRef(
  panel: ReactElement<Record<string, unknown>>,
  action: "fetch" | "pull" | "push",
): void {
  const refsPane = componentElement(panel, "GitRefsPane");
  (refsPane.props.onSync as (action: "fetch" | "pull" | "push") => void)(action);
}

function selectRef(
  panel: ReactElement<Record<string, unknown>>,
  name: string,
  revision: string,
): void {
  const refsPane = componentElement(panel, "GitRefsPane");
  const sharedRefTreeProps = refsPane.props.sharedRefTreeProps as {
    readonly onSelect: (name: string, revision: string) => void;
  };
  sharedRefTreeProps.onSelect(name, revision);
}

function openDialog(
  panel: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const dialog = visitElements(
    panel,
    (element) => element.props.open === true && typeof element.props.onOpenChange === "function",
  );
  expect(dialog).not.toBeNull();
  return dialog as ReactElement<Record<string, unknown>>;
}

function hasTextChild(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value))
    return value
      .map((child) => textFromChild(child))
      .join("")
      .includes(text);
  if (!isValidElement<{ readonly children?: unknown }>(value)) return false;
  return hasTextChild(value.props.children, text);
}

function textFromChild(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((child) => textFromChild(child)).join("");
  if (!isValidElement<{ readonly children?: unknown }>(value)) return "";
  return textFromChild(value.props.children);
}

describe("Git History sync", () => {
  it("asks before pushing the selected default branch", () => {
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );

    syncSelectedRef(renderPanel(), "push");

    expect(historyState.syncHistory).not.toHaveBeenCalled();
    const panel = renderPanel();
    expect(
      visitElements(panel, (element) => element.props.children === "Push to default branch?"),
    ).not.toBeNull();
    expect(hasTextChild(panel.props.children, "Push main to origin/main.")).toBe(true);
  });

  it("does not push when the default branch confirmation is cancelled", () => {
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );

    syncSelectedRef(renderPanel(), "push");
    (openDialog(renderPanel()).props.onOpenChange as (open: boolean) => void)(false);
    renderPanel();

    expect(historyState.syncHistory).not.toHaveBeenCalled();
  });

  it("pushes the captured default branch after confirmation", () => {
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
    historyState.syncHistory.mockImplementation(() => new Promise<never>(() => {}));

    syncSelectedRef(renderPanel(), "push");
    const push = visitElements(
      openDialog(renderPanel()),
      (element) =>
        typeof element.props.onClick === "function" && hasTextChild(element.props.children, "Push"),
    );
    (push?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.syncHistory).toHaveBeenCalledOnce();
    expect(historyState.syncHistory).toHaveBeenCalledWith({
      environmentId,
      input: { action: "push", cwd: "C:/workspace", namespace: "local", refName: "main" },
    });
  });

  it("invalidates a default branch push confirmation when the selected target changes", () => {
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
      gitRef("feature/history", { upstreamName: "origin/feature/history" }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );

    syncSelectedRef(renderPanel(), "push");
    selectRef(renderPanel(), "feature/history", "refs/heads/feature/history");
    const panel = renderPanel();

    expect(historyState.syncHistory).not.toHaveBeenCalled();
    expect(
      visitElements(
        panel,
        (element) =>
          element.props.open === true && typeof element.props.onOpenChange === "function",
      ),
    ).toBeNull();
  });

  it("invalidates a default branch push confirmation when its upstream changes", () => {
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );

    syncSelectedRef(renderPanel(), "push");
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "fork/main",
      }),
    ];
    renderPanel();
    flushEffects();
    historyState.refs = [
      gitRef("main", {
        aheadCount: 1,
        current: true,
        isDefault: true,
        upstreamName: "origin/main",
      }),
    ];
    const panel = renderPanel();

    expect(historyState.syncHistory).not.toHaveBeenCalled();
    expect(
      visitElements(
        panel,
        (element) =>
          element.props.open === true && typeof element.props.onOpenChange === "function",
      ),
    ).toBeNull();
  });

  it("does not sync through a connection without source control write permission", () => {
    historyState.canSync = false;
    historyState.refs = [
      gitRef("feature", { current: true, upstreamName: "origin/feature", aheadCount: 1 }),
    ];
    historyState.pages.set(undefined, page([commit("a".repeat(40), "Initial")]));

    syncSelectedRef(renderPanel(), "push");

    expect(historyState.syncHistory).not.toHaveBeenCalled();
  });

  it("runs ordinary sync actions immediately", () => {
    historyState.refs = [
      gitRef("feature/history", {
        aheadCount: 1,
        behindCount: 1,
        current: true,
        upstreamName: "origin/feature/history",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
    historyState.syncHistory.mockImplementation(() => new Promise<never>(() => {}));

    syncSelectedRef(renderPanel(), "pull");

    expect(historyState.syncHistory).toHaveBeenCalledWith({
      environmentId,
      input: {
        action: "pull",
        cwd: "C:/workspace",
        namespace: "local",
        refName: "feature/history",
      },
    });
  });

  it("fetches the selected branch immediately", () => {
    historyState.refs = [
      gitRef("feature/history", {
        current: true,
        upstreamName: "origin/feature/history",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
    historyState.syncHistory.mockImplementation(() => new Promise<never>(() => {}));

    syncSelectedRef(renderPanel(), "fetch");

    expect(historyState.syncHistory).toHaveBeenCalledWith({
      environmentId,
      input: {
        action: "fetch",
        cwd: "C:/workspace",
        namespace: "local",
        refName: "feature/history",
      },
    });
  });

  it("pushes a selected feature branch immediately", () => {
    historyState.refs = [
      gitRef("feature/history", {
        aheadCount: 1,
        current: true,
        upstreamName: "origin/feature/history",
      }),
    ];
    historyState.pages.set(
      undefined,
      page([commit("aaaaaaaa11111111111111111111111111111111", "Initial")]),
    );
    historyState.syncHistory.mockImplementation(() => new Promise<never>(() => {}));

    syncSelectedRef(renderPanel(), "push");

    expect(historyState.syncHistory).toHaveBeenCalledWith({
      environmentId,
      input: {
        action: "push",
        cwd: "C:/workspace",
        namespace: "local",
        refName: "feature/history",
      },
    });
  });
});
