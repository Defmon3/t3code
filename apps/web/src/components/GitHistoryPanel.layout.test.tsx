import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

import {
  componentElement,
  commit,
  effectQueue,
  flushEffects,
  historyState,
  page,
  primaryCommitHash,
  renderComponent,
  renderPanel,
  stubResizeObserver,
} from "./GitHistoryPanel.test-fixture";
import { isWideHistoryLayout } from "./GitHistoryPanel";
import { PaneResizeHandle } from "./git-history/GitHistoryPaneResizeHandle";

describe("GitHistoryPanel layout", () => {
  it("keeps the desktop refs and details workflow available at ordinary desktop widths", () => {
    expect(isWideHistoryLayout(1119)).toBe(false);
    expect(isWideHistoryLayout(1120)).toBe(true);
  });

  it("coalesces pane pointer moves per frame and flushes the final move on pointer up", () => {
    const onMove = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    hooks.beginRender();
    const handle = PaneResizeHandle({
      label: "Resize branches pane",
      value: 320,
      min: 240,
      max: 480,
      onMove,
      onReset: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const target = { releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() };
    const onPointerDown = handle.props.onPointerDown as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;
    const onPointerMove = handle.props.onPointerMove as (event: {
      readonly clientX: number;
      readonly pointerId: number;
    }) => void;
    const onPointerUp = handle.props.onPointerUp as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;

    onPointerDown({ clientX: 100, currentTarget: target, pointerId: 1 });
    onPointerMove({ clientX: 104, pointerId: 1 });
    onPointerMove({ clientX: 110, pointerId: 1 });

    expect(onMove).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    const firstFrame = frames.get(1);
    expect(firstFrame).toBeDefined();
    frames.delete(1);
    firstFrame?.(0);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(10);

    onPointerMove({ clientX: 114, pointerId: 1 });
    onPointerUp({ clientX: 120, currentTarget: target, pointerId: 1 });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenLastCalledWith(10);
    expect(frames).toHaveLength(0);
  });

  it("flushes pending pane movement once when pointer capture is lost before its frame", () => {
    const onMove = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(1, callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    hooks.beginRender();
    const handle = PaneResizeHandle({
      label: "Resize branches pane",
      value: 320,
      min: 240,
      max: 480,
      onMove,
      onReset: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const target = { setPointerCapture: vi.fn() };
    const onPointerDown = handle.props.onPointerDown as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;
    const onPointerMove = handle.props.onPointerMove as (event: {
      readonly clientX: number;
      readonly pointerId: number;
    }) => void;
    const onLostPointerCapture = handle.props.onLostPointerCapture as (event: {
      readonly pointerId: number;
    }) => void;

    onPointerDown({ clientX: 100, currentTarget: target, pointerId: 1 });
    onPointerMove({ clientX: 110, pointerId: 1 });
    const pendingFrame = frames.get(1);
    onLostPointerCapture({ pointerId: 1 });
    pendingFrame?.(0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith(10);
  });

  it("does not rerender history children for repeated wide widths without pane clamping", () => {
    const notify = stubResizeObserver(1400);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    effectQueue.stateUpdates = 0;

    notify(1399);
    notify(1398);
    notify(1397);

    expect(effectQueue.stateUpdates).toBe(0);
  });

  it("constrains both side panes when widening branches at the minimum wide layout", () => {
    stubResizeObserver(1120);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branchHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);

    const constrained = renderPanel();
    const refsPane = componentElement(constrained, "GitRefsPane");
    const detailsPane = componentElement(constrained, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(304);
  });

  it("constrains commit details when resetting at the minimum wide layout", () => {
    stubResizeObserver(1120);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branchHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    const detailsHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    (detailsHandle?.props.onReset as (() => void) | undefined)?.();

    const constrained = renderPanel();
    const refsPane = componentElement(constrained, "GitRefsPane");
    const detailsPane = componentElement(constrained, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(304);
  });

  it("clamps expanded side panes when a wide history panel shrinks", () => {
    const notify = stubResizeObserver(1400);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const expanded = renderPanel();
    const branchHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    const detailsHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    expect(branchHandle).not.toBeNull();
    expect(detailsHandle).not.toBeNull();
    expect(renderComponent(branchHandle!).props.className).not.toContain("hidden");
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    (detailsHandle?.props.onMove as ((delta: number) => void) | undefined)?.(-336);
    renderPanel();

    notify(1120);
    renderPanel();
    flushEffects();
    const shrunken = renderPanel();
    const refsPane = componentElement(shrunken, "GitRefsPane");
    const detailsPane = componentElement(shrunken, "CommitDetailsPane");
    const refsWidth = (refsPane.props.style as { width: number }).width;
    const detailsWidth = (detailsPane.props.style as { width: number }).width;

    expect(refsWidth + detailsWidth).toBeLessThanOrEqual(784);
  });

  it("preserves wide pane widths through a narrow layout transition", () => {
    const notify = stubResizeObserver(1600);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const expanded = renderPanel();
    const branchHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    const detailsHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    (detailsHandle?.props.onMove as ((delta: number) => void) | undefined)?.(-336);

    notify(1119);
    renderPanel();
    flushEffects();
    notify(1600);
    renderPanel();
    flushEffects();
    const restored = renderPanel();
    const refsPane = componentElement(restored, "GitRefsPane");
    const detailsPane = componentElement(restored, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(720);
  });
});
