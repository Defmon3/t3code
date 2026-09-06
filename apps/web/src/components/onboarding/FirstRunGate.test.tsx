import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => "/",
  useNavigate: () => navigate,
}));
vi.mock("effect/unstable/reactivity", () => ({
  Atom: {
    make: () => ({ pipe: () => Symbol("atom") }),
    withLabel: () => Symbol("label"),
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(),
  useClientSettings: <Value,>(select: (settings: { onboardingCompletedAt: null }) => Value) =>
    select({ onboardingCompletedAt: null }),
  useClientSettingsHydrationStatus: () => "ready",
}));
vi.mock("../../hooks/useTheme", () => ({ mountOnboardingTheme: vi.fn() }));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => vi.fn() }));
vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => false,
  useProjects: () => [],
  useThreadShells: () => [],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: false }),
}));
vi.mock("../../state/projects", () => ({
  environmentProjects: { projectsAtom: Symbol("projects") },
}));
vi.mock("../../state/server", () => ({
  primaryServerConfigAtom: Symbol("server-config"),
  primaryServerWelcomeAtom: Symbol("server-welcome"),
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateValueAtom: () => Symbol("shell") },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: Symbol("threads") },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { FirstRunGate } from "./FirstRunGate";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { clearTimeout, setTimeout });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FirstRunGate", () => {
  it("keeps a loading status visible while workspace evidence is pending", async () => {
    await act(async () => {
      renderer = create(
        <FirstRunGate enabled hostedStatic={false}>
          <div>Application shell</div>
        </FirstRunGate>,
      );
    });

    expect(renderer!.root.findByProps({ role: "status" }).props["aria-label"]).toBe(
      "Loading T3 Code",
    );
    expect(renderer!.root.findAllByType("div")).toHaveLength(0);
  });
});
