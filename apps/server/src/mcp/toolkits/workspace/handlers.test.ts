import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../../../vcs/VcsProjectConfig.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { setCallingThreadWorktree } from "./handlers.ts";

const now = "2026-08-18T00:00:00.000Z";
const projectId = ProjectId.make("project-workspace-tool");
const threadId = ThreadId.make("thread-workspace-tool");

const project = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Workspace tool project",
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const thread = (worktreePath: string | null = null): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Workspace tool thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: worktreePath === null ? "main" : "fix/existing-worktree",
  worktreePath,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const invocation = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId: EnvironmentId.make("environment-workspace-tool"),
    threadId,
    providerSessionId: "provider-session-workspace-tool",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities,
    issuedAt: 1,
  });

const processOutput = (stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface Fixture {
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly otherRoot: string;
  readonly nestedRoot: string;
  readonly vcsLayer: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry>;
}

const makeFixture = Effect.fn("WorkspaceToolkitTest.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-tool-" });
  const projectRoot = path.join(root, "project");
  const worktreeRoot = path.join(root, "worktree");
  const otherRoot = path.join(root, "other");
  const nestedRoot = path.join(worktreeRoot, "nested");
  yield* Effect.forEach(
    [
      projectRoot,
      path.join(projectRoot, ".git"),
      worktreeRoot,
      otherRoot,
      path.join(otherRoot, ".git"),
      nestedRoot,
    ],
    (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
    { discard: true },
  );

  const normalize = (value: string) => normalizeProjectPathForComparison(value);
  const normalizedWorktreeRoot = normalize(worktreeRoot);
  const normalizedOtherRoot = normalize(otherRoot);
  const vcsProcess = Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        const args = input.args[0] === "-C" ? input.args.slice(2) : input.args;
        const command = args.join(" ");
        const cwd = normalize(input.cwd);
        const detectedRoot = cwd.startsWith(normalizedWorktreeRoot)
          ? worktreeRoot
          : cwd.startsWith(normalizedOtherRoot)
            ? otherRoot
            : projectRoot;
        if (command === "rev-parse --is-inside-work-tree") return processOutput("true\n");
        if (command === "rev-parse --show-toplevel") return processOutput(`${detectedRoot}\n`);
        if (command === "rev-parse --git-common-dir") {
          return processOutput(
            detectedRoot === otherRoot
              ? `${path.join(otherRoot, ".git")}\n`
              : `${path.join(projectRoot, ".git")}\n`,
          );
        }
        if (command === "symbolic-ref --quiet --short HEAD") {
          return processOutput(detectedRoot === projectRoot ? "main\n" : "fix/existing-worktree\n");
        }
        return processOutput("unexpected git command", 1);
      }),
  });
  const vcsLayer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsProjectConfig.VcsProjectConfig)({
        resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
      }),
    ),
    Layer.provide(vcsProcess),
  );
  return { projectRoot, worktreeRoot, otherRoot, nestedRoot, vcsLayer };
});

const runTool = (
  fixture: Fixture,
  input: { readonly path: string | null },
  options: {
    readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
    readonly currentWorktreePath?: string | null;
  } = {},
) => {
  const commands: OrchestrationCommand[] = [];
  const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () =>
      Effect.succeed(Option.some(thread(options.currentWorktreePath ?? null))),
    getProjectShellById: () => Effect.succeed(Option.some(project(fixture.projectRoot))),
  });
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: 1 };
      }),
  });
  return setCallingThreadWorktree(input).pipe(
    Effect.map((result) => ({ result, commands })),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(options.capabilities ?? new Set(["preview", "workspace"])),
    ),
    Effect.provide(
      Layer.mergeAll(snapshotLayer, engineLayer, fixture.vcsLayer, NodeServices.layer),
    ),
  );
};

describe("workspace_set_worktree", () => {
  it.effect("attaches the calling thread to an existing same-repository worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { result, commands } = yield* runTool(fixture, { path: fixture.worktreeRoot });

        assert.equal(
          result.worktreePath,
          yield* (yield* FileSystem.FileSystem).realPath(fixture.worktreeRoot),
        );
        assert.equal(result.branch, "fix/existing-worktree");
        assert.equal(result.providerWorkspaceApplies, "next-turn");
        assert.equal(result.changed, true);
        assert.equal(commands.length, 1);
        assert.deepInclude(commands[0], {
          type: "thread.meta.update",
          threadId,
          expectedBranch: "main",
          branch: "fix/existing-worktree",
          worktreePath: result.worktreePath,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detaches back to the project checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { result, commands } = yield* runTool(
          fixture,
          { path: null },
          {
            currentWorktreePath: fixture.worktreeRoot,
          },
        );

        assert.equal(result.worktreePath, null);
        assert.equal(result.branch, "main");
        assert.equal(commands.length, 1);
        assert.deepInclude(commands[0], {
          type: "thread.meta.update",
          threadId,
          expectedBranch: "fix/existing-worktree",
          branch: "main",
          worktreePath: null,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unauthorized, relative, nested, and different-repository targets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const cases = [
          [
            runTool(
              fixture,
              { path: fixture.worktreeRoot },
              { capabilities: new Set(["preview"]) },
            ),
            "capability_denied",
          ],
          [runTool(fixture, { path: "relative/worktree" }), "invalid_path"],
          [runTool(fixture, { path: fixture.nestedRoot }), "not_a_worktree_root"],
          [runTool(fixture, { path: fixture.otherRoot }), "different_repository"],
        ] as const;

        for (const [effect, expectedCode] of cases) {
          const error = yield* effect.pipe(Effect.flip);
          assert.equal(error.code, expectedCode);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
