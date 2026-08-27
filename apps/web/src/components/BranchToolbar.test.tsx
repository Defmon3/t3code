import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  compact: false,
  cursor: 0,
  element: null as unknown,
  measurements: 0,
  slots: [] as unknown[],
  stateUpdates: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => {
      testState.cursor += 1;
      return callback;
    },
    useEffect: (effect: () => void | (() => void)) => {
      testState.cursor += 1;
      effect();
    },
    useLayoutEffect: (effect: () => void | (() => void)) => {
      testState.cursor += 1;
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
  outerHTML = "<span />";

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
    testState.measurements = 0;
    testState.slots = [];
    testState.stateUpdates = 0;
    label.outerHTML = "<span>main</span>";
    control.outerHTML = "<button>branch</button>";
    Object.assign(globalThis, {
      HTMLElement: TestElement,
      ResizeObserver: class {
        disconnect() {}
        observe() {}
      },
      document: { fonts: { addEventListener: vi.fn(), removeEventListener: vi.fn() } },
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

  it("remeasures when label or control content changes", () => {
    render();
    label.outerHTML = "<span>feature/longer-name</span>";
    render();

    expect(testState.measurements).toBe(2);
  });
});
