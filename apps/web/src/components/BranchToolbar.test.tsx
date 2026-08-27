import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  compact: false,
  cursor: 0,
  element: null as unknown,
  effectCleanups: [] as (() => void)[],
  effectDependencies: [] as (readonly unknown[] | undefined)[],
  fontLoadingDone: null as (() => void) | null,
  measurements: 0,
  mutationObserverCallback: null as MutationCallback | null,
  mutationObserverDisconnects: 0,
  resizeObserverCallback: null as ResizeObserverCallback | null,
  resizeObserverDisconnects: 0,
  slots: [] as unknown[],
  stateUpdates: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T, dependencies: readonly unknown[]) => {
      const index = testState.cursor++;
      const previousDependencies = testState.effectDependencies[index];
      const changed =
        previousDependencies === undefined ||
        dependencies.length !== previousDependencies.length ||
        dependencies.some(
          (dependency, dependencyIndex) => dependency !== previousDependencies[dependencyIndex],
        );
      if (changed) {
        testState.effectDependencies[index] = dependencies;
        testState.slots[index] = callback;
      }
      return testState.slots[index] as T;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = testState.cursor++;
      const previousDependencies = testState.effectDependencies[index];
      const changed =
        dependencies === undefined ||
        previousDependencies === undefined ||
        dependencies.length !== previousDependencies.length ||
        dependencies.some(
          (dependency, dependencyIndex) => dependency !== previousDependencies[dependencyIndex],
        );
      if (!changed) return;
      testState.effectDependencies[index] = dependencies;
      const cleanup = effect();
      if (cleanup) testState.effectCleanups.push(cleanup);
    },
    useLayoutEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = testState.cursor++;
      const previousDependencies = testState.effectDependencies[index];
      const changed =
        dependencies === undefined ||
        previousDependencies === undefined ||
        dependencies.length !== previousDependencies.length ||
        dependencies.some(
          (dependency, dependencyIndex) => dependency !== previousDependencies[dependencyIndex],
        );
      if (!changed) return;
      testState.effectDependencies[index] = dependencies;
      effect();
    },
    useMemo: <T,>(factory: () => T) => {
      testState.cursor += 1;
      return factory();
    },
    useRef: <T,>(initialValue: T) => {
      const index = testState.cursor++;
      if (testState.slots[index] === undefined) {
        testState.slots[index] = { current: initialValue };
      }
      return testState.slots[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = testState.cursor++;
      if (testState.slots[index] === undefined) {
        testState.slots[index] = initialValue === null ? testState.element : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = testState.slots[index] as T;
        const next =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
        if (next !== previous) {
          testState.slots[index] = next;
          testState.compact = next === true;
          testState.stateUpdates += 1;
        }
      };
      return [testState.slots[index] as T, setValue] as const;
    },
  };
});

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeProjectRef: () => "project",
  scopeThreadRef: () => "thread",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: { getDraftThreadByRef: () => null }) => unknown) =>
    selector({ getDraftThreadByRef: () => null }),
}));
vi.mock("../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../state/entities", () => ({
  useProject: () => ({}),
  useThread: () => ({ environmentId: "environment", projectId: "project", worktreePath: null }),
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("./BranchToolbar.logic", () => ({
  resolveCurrentWorkspaceLabel: () => "Current checkout",
  resolveEffectiveEnvMode: () => "local",
  resolveEnvModeLabel: () => "Current checkout",
  resolveLockedWorkspaceLabel: () => "Local checkout",
  resolvePreviousWorktreeLabel: () => null,
  resolvePreviousWorktreeSeed: () => null,
  shouldShowEnvironmentIndicator: () => false,
}));
vi.mock("./BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: "branch-selector",
}));
vi.mock("./BranchToolbarEnvironmentSelector", () => ({
  BranchToolbarEnvironmentSelector: "environment-selector",
}));
vi.mock("./BranchToolbarEnvModeSelector", () => ({
  BranchToolbarEnvModeSelector: "mode-selector",
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/menu", () => ({
  Menu: "menu",
  MenuGroup: "menu-group",
  MenuGroupLabel: "menu-group-label",
  MenuPopup: "menu-popup",
  MenuRadioGroup: "menu-radio-group",
  MenuRadioItem: "menu-radio-item",
  MenuSeparator: "menu-separator",
  MenuTrigger: "menu-trigger",
}));
vi.mock("./ui/separator", () => ({ Separator: "separator" }));

class TestElement {
  countMeasurements = false;
  children: TestElement[] = [];
  isConnected = false;

  get clientWidth() {
    if (this.countMeasurements) testState.measurements += 1;
    return 100;
  }

  get offsetWidth() {
    return 10;
  }

  get scrollWidth() {
    return 0;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0 } as DOMRect;
  }

  querySelectorAll(_selector: string) {
    return [] as TestElement[];
  }
}

class ContentElement extends TestElement {
  override get offsetWidth() {
    return testState.compact ? 50 : 110;
  }
}

const label = new TestElement();
const control = new TestElement();
const group = new TestElement();
const strip = new TestElement();
strip.countMeasurements = true;
group.children = [new ContentElement()];
strip.children = [group];
strip.querySelectorAll = (selector: string) => {
  if (selector === "[data-composer-label]") return [label];
  if (selector === "[data-composer-context-control]") return [control];
  return [label, control];
};

import { BranchToolbar } from "./BranchToolbar";

function render() {
  testState.cursor = 0;
  (BranchToolbar as unknown as { type: (props: Record<string, unknown>) => unknown }).type({
    environmentId: "environment",
    threadId: "thread",
    showGitControls: true,
    onEnvModeChange: vi.fn(),
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    envLocked: false,
  });
}

describe("BranchToolbar", () => {
  beforeEach(() => {
    testState.compact = false;
    testState.element = strip;
    testState.effectCleanups = [];
    testState.effectDependencies = [];
    testState.fontLoadingDone = null;
    testState.measurements = 0;
    testState.mutationObserverCallback = null;
    testState.mutationObserverDisconnects = 0;
    testState.resizeObserverCallback = null;
    testState.resizeObserverDisconnects = 0;
    testState.slots = [];
    testState.stateUpdates = 0;
    Object.assign(globalThis, {
      HTMLElement: TestElement,
      ResizeObserver: class {
        constructor(callback: ResizeObserverCallback) {
          testState.resizeObserverCallback = callback;
        }

        disconnect() {
          testState.resizeObserverDisconnects += 1;
        }

        observe() {}
      },
      MutationObserver: class {
        constructor(callback: MutationCallback) {
          testState.mutationObserverCallback = callback;
        }

        disconnect() {
          testState.mutationObserverDisconnects += 1;
        }

        observe() {}
      },
      document: {
        fonts: {
          addEventListener: (_event: string, callback: () => void) => {
            testState.fontLoadingDone = callback;
          },
          removeEventListener: vi.fn(),
        },
      },
      getComputedStyle: () => ({ columnGap: "0", position: "static" }),
      window: { matchMedia: () => ({ matches: true }) },
    });
  });

  it("does not remeasure unchanged content after compact state changes its geometry", () => {
    render();
    render();

    expect(testState.measurements).toBe(1);
    expect(testState.stateUpdates).toBe(1);
  });

  it("remeasures for observed resize, font loading, and content changes", () => {
    render();

    testState.resizeObserverCallback?.([], {} as ResizeObserver);
    testState.fontLoadingDone?.();
    testState.mutationObserverCallback?.([], {} as MutationObserver);

    expect(testState.measurements).toBe(4);
  });

  it("disconnects observers when the toolbar unmounts", () => {
    render();
    for (const cleanup of testState.effectCleanups) {
      cleanup();
    }

    expect(testState.resizeObserverDisconnects).toBe(1);
    expect(testState.mutationObserverDisconnects).toBe(1);
  });
});
