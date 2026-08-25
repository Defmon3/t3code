import { describe, expect, it } from "@effect/vitest";

import {
  deriveProcessPanelGroups,
  formatTestCommand,
  isTestCommand,
  processPanelStatus,
  type ProcessPanelEntry,
} from "./ProcessPanel.logic";

const project = {
  id: "project-1",
  title: "T3 Code",
  workspaceRoot: "C:\\code\\t3code",
};

function process(overrides: Partial<ProcessPanelEntry>): ProcessPanelEntry {
  return {
    pid: 1,
    ppid: 0,
    childPids: [],
    command: "vitest run",
    cwd: "C:\\code\\t3code",
    cpuPercent: 2.4,
    cpuTimeMs: 1_200,
    rssBytes: 16 * 1024 * 1024,
    elapsed: "00:01",
    ...overrides,
  };
}

describe("isTestCommand", () => {
  it.each([
    "vitest run",
    "node C:\\repo\\node_modules\\vitest\\vitest.mjs run",
    "vite test --run",
    "jest --watch",
    "pytest -q",
    "uv run pytest -q",
    "python -m pytest",
    "python check-all.py --scope web",
    "python run-mutation.py --target parser",
    "uv run python C:\\tools\\check-is-vitest.py --pid 42",
    "vp test run src/example.test.ts",
    "pnpm test -- --run",
    "npm test",
    "yarn test",
    "bun test",
    "dotnet test",
    '"C:\\Program Files\\dotnet\\dotnet.exe" test',
    '"C:\\Program Files\\vstest.console.exe" tests.dll',
    "dotnet-stryker",
    "cargo test -p app",
    "go test ./...",
  ])("recognizes %s", (command) => expect(isTestCommand(command)).toBe(true));

  it("leaves unrelated commands out", () => {
    expect(isTestCommand("node server.js")).toBe(false);
    expect(isTestCommand("npm contest")).toBe(false);
    expect(isTestCommand("python -m pytester")).toBe(false);
    expect(isTestCommand("dotnet-test")).toBe(false);
    expect(isTestCommand("python server.py")).toBe(false);
    expect(isTestCommand("rg -n vitest src")).toBe(false);
    expect(isTestCommand("echo pnpm test")).toBe(false);
  });

  it.each([
    '"C:\\Program Files\\pnpm.cmd" run test:unit',
    "vp.ps1 test src/components/ProcessPanel.logic.test.ts",
    "cargo.exe test -p app",
    "go.exe test ./...",
  ])("recognizes test executables in direct or quoted executable position: %s", (command) => {
    expect(isTestCommand(command)).toBe(true);
  });

  it("uses structured argv before the flattened command fallback", () => {
    expect(isTestCommand("vitest run", ["rg", "-n", "vitest", "src"])).toBe(false);
    expect(isTestCommand("not a test", ["pnpm", "--filter", "web", "test"])).toBe(true);
  });

  it.each([
    { argv: ["cmd.exe", "/c", "pnpm", "--filter", "web", "test"] },
    { argv: ["powershell.exe", "-Command", "npm --workspace web test"] },
    { argv: ["pwsh.exe", "-c", "cargo.exe test"] },
    { argv: ["sh", "-c", "go.exe test ./..."] },
  ])("unwraps shell command arguments", ({ argv }) => {
    expect(isTestCommand("not a test", argv)).toBe(true);
  });

  it("handles package selectors without scanning arbitrary arguments", () => {
    expect(isTestCommand("pnpm --filter web test")).toBe(true);
    expect(isTestCommand("npm --workspace web test")).toBe(true);
    expect(isTestCommand("pnpm --filter web config test")).toBe(false);
  });
});

describe("formatTestCommand", () => {
  it.each([
    {
      argv: ["pnpm", "--filter", "web", "test", "--", "--run"],
      expected: { label: "pnpm test", args: ["--filter", "web", "--", "--run"] },
    },
    {
      argv: ["node", "node_modules/vitest/vitest.mjs", "run", "src/example.test.ts"],
      expected: { label: "Vitest", args: ["run", "src/example.test.ts"] },
    },
    {
      argv: ["uv", "run", "pytest", "-q"],
      expected: { label: "Pytest", args: ["-q"] },
    },
    {
      argv: ["python.exe", "G:\\tools\\check-is-vitest.py", "--pid", "42"],
      expected: { label: "G:\\tools\\check-is-vitest.py", args: ["--pid", "42"] },
    },
    {
      argv: ["uv", "run", "python", "C:\\tools\\check-is-vitest.py", "--pid", "42"],
      expected: { label: "C:\\tools\\check-is-vitest.py", args: ["--pid", "42"] },
    },
    {
      argv: ["cmd.exe", "/c", "cargo", "test", "-p", "app"],
      expected: { label: "Cargo test", args: ["-p", "app"] },
    },
  ])("formats structured test argv without duplicating the full command", ({ argv, expected }) => {
    expect(formatTestCommand("opaque flattened command", argv)).toEqual(expected);
  });
});

describe("deriveProcessPanelGroups", () => {
  it("attributes Windows paths case-insensitively to the deepest worktree", () => {
    const groups = deriveProcessPanelGroups({
      processes: [process({ cwd: "c:/CODE/t3code/worktrees/feature/src", command: "jest" })],
      projects: [project],
      threads: [{ projectId: project.id, worktreePath: "C:\\code\\t3code\\worktrees\\feature" }],
    });
    expect(groups).toMatchObject([
      { cwd: "C:\\code\\t3code\\worktrees\\feature", worktreeLabel: "feature" },
    ]);
  });

  it("uses the worktree directory as its label", () => {
    const groups = deriveProcessPanelGroups({
      processes: [process({ cwd: "C:\\code\\t3code\\worktrees\\issue-451" })],
      projects: [project],
      threads: [
        {
          projectId: project.id,
          worktreePath: "C:\\code\\t3code\\worktrees\\issue-451",
        },
      ],
    });
    expect(groups[0]?.worktreeLabel).toBe("issue-451");
  });

  it("attributes an independent detached worktree to its registered project", () => {
    const groups = deriveProcessPanelGroups({
      processes: [process({ cwd: "C:\\argus-worktrees\\ff-baseline\\src\\Argus.Web" })],
      projects: [{ ...project, title: "Argus", workspaceRoot: "C:\\argus" }],
      threads: [],
      worktrees: [{ projectId: project.id, path: "C:\\argus-worktrees\\ff-baseline" }],
    });

    expect(groups).toMatchObject([
      {
        project: { id: project.id, title: "Argus" },
        cwd: "C:\\argus-worktrees\\ff-baseline",
        worktreeLabel: "ff-baseline",
      },
    ]);
  });

  it("labels a project checkout by its workspace directory", () => {
    const groups = deriveProcessPanelGroups({
      processes: [process({ cwd: "C:\\code\\t3code\\src" })],
      projects: [project],
      threads: [],
    });
    expect(groups[0]?.worktreeLabel).toBe("t3code");
  });

  it("preserves POSIX case when attributing paths", () => {
    expect(
      deriveProcessPanelGroups({
        processes: [process({ cwd: "/work/App", command: "pytest" })],
        projects: [{ ...project, workspaceRoot: "/work/app" }],
        threads: [],
      }),
    ).toEqual([]);
  });

  it("omits processes without a known cwd and deduplicates test descendants", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 10, childPids: [11], command: "vitest run" }),
        process({ pid: 11, ppid: 10, command: "vitest run" }),
        process({ pid: 12, cwd: undefined, command: "jest" }),
      ],
      projects: [project],
      threads: [],
    });
    expect(groups).toMatchObject([{ processes: [{ pid: 10 }] }]);
  });

  it("keeps the top-level test wrapper command when its runner is a child", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 10, childPids: [11], command: "pnpm test -- --run" }),
        process({ pid: 11, ppid: 10, command: "node node_modules/vitest/vitest.mjs run" }),
      ],
      projects: [project],
      threads: [],
    });
    expect(groups[0]?.processes).toMatchObject([{ pid: 10, command: "pnpm test -- --run" }]);
  });

  it("does not let an unattributed test wrapper suppress its attributable child", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 10, childPids: [11], command: "pnpm test", cwd: undefined }),
        process({ pid: 11, ppid: 10, command: "vitest run" }),
      ],
      projects: [project],
      threads: [],
    });
    expect(groups[0]?.processes).toMatchObject([{ pid: 11 }]);
  });

  it("keeps a child attributed to another worktree", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 10, childPids: [11], command: "pnpm test" }),
        process({
          pid: 11,
          ppid: 10,
          command: "vitest run",
          cwd: "C:\\code\\t3code\\worktrees\\other",
        }),
      ],
      projects: [project],
      threads: [{ projectId: project.id, worktreePath: "C:\\code\\t3code\\worktrees\\other" }],
    });
    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.processes.map((entry) => entry.pid)).sort()).toEqual([
      10, 11,
    ]);
  });

  it("groups and sorts sibling tests stably", () => {
    const groups = deriveProcessPanelGroups({
      processes: [process({ pid: 2, command: "vitest z" }), process({ pid: 1, command: "jest a" })],
      projects: [project],
      threads: [],
    });
    expect(groups[0]?.processes.map((entry) => entry.command)).toEqual(["jest a", "vitest z"]);
  });

  it("summarizes current CPU and cumulative CPU time for each worktree", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 1, cpuPercent: 12.5, cpuTimeMs: 20_000 }),
        process({ pid: 2, cpuPercent: 7.5, cpuTimeMs: 5_000, command: "jest" }),
      ],
      projects: [project],
      threads: [],
    });

    expect(groups[0]).toMatchObject({ cpuPercent: 20, cpuTimeMs: 25_000 });
  });

  it("caps a worktree's aggregate CPU at the machine maximum", () => {
    const groups = deriveProcessPanelGroups({
      processes: [
        process({ pid: 1, cpuPercent: 80 }),
        process({ pid: 2, cpuPercent: 50, command: "jest" }),
      ],
      projects: [project],
      threads: [],
    });

    expect(groups[0]?.cpuPercent).toBe(100);
  });
});

describe("processPanelStatus", () => {
  it("only marks a successful response from a connected environment as live", () => {
    expect(
      processPanelStatus({
        environmentConnectionPhase: "connected",
        hasData: false,
        hasQueryError: false,
        hasDataError: false,
      }),
    ).toEqual({
      label: "Connecting",
      tone: "muted",
    });
    expect(
      processPanelStatus({
        environmentConnectionPhase: "connected",
        hasData: true,
        hasQueryError: false,
        hasDataError: false,
      }),
    ).toEqual({
      label: "Live",
      tone: "live",
    });
    expect(
      processPanelStatus({
        environmentConnectionPhase: "connected",
        hasData: true,
        hasQueryError: true,
        hasDataError: false,
      }),
    ).toEqual({ label: "Unavailable", tone: "error" });
    expect(
      processPanelStatus({
        environmentConnectionPhase: "connected",
        hasData: true,
        hasQueryError: false,
        hasDataError: true,
      }),
    ).toEqual({ label: "Unavailable", tone: "error" });
  });

  it("does not mark retained telemetry live after its environment disconnects", () => {
    expect(
      processPanelStatus({
        environmentConnectionPhase: "offline",
        hasData: true,
        hasQueryError: false,
        hasDataError: false,
      }),
    ).toEqual({ label: "Unavailable", tone: "error" });
  });

  it("does not describe a first-time unavailable environment as connecting", () => {
    expect(
      processPanelStatus({
        environmentConnectionPhase: "available",
        hasData: false,
        hasQueryError: false,
        hasDataError: false,
      }),
    ).toEqual({ label: "Unavailable", tone: "error" });
  });
});
