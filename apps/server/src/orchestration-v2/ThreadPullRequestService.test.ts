import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect.each(["duplicate", "promotion", "in-flight"] as const)(
    "coalesces %s thread refreshes without losing newer state",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          let thread = { ...threadShell("refresh-thread"), branch: "feature/refresh" };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const releaseStartup = yield* Deferred.make<void>();
          const releaseRefresh = yield* Deferred.make<void>();
          const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
          const eventsConsumed = yield* Queue.unbounded<void>();
          const lookupStarted = yield* Queue.unbounded<boolean>();
          const lookups: boolean[] = [];
          const branches: string[] = [];
          const identityRefreshes: boolean[] = [];
          const backgroundWork: boolean[] = [];
          const base = {
            id: EventId.make("event:refresh"),
            threadId: thread.id,
            occurredAt: NOW,
          };
          const completed: OrchestrationV2DomainEvent = {
            ...base,
            type: "run.updated",
            payload: {
              id: RunId.make("run:refresh"),
              threadId: thread.id,
              ordinal: 1,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:refresh"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              checkpointId: null,
              contextHandoffId: null,
            },
          };
          const checkpoint: OrchestrationV2DomainEvent = {
            ...base,
            type: "checkpoint.captured",
            payload: {
              id: CheckpointId.make("checkpoint:refresh"),
              threadId: thread.id,
              scopeId: CheckpointScopeId.make("scope:refresh"),
              runId: null,
              nodeId: NodeId.make("node:refresh"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/t3/checkpoints/refresh"),
              status: "ready",
              files: [],
              capturedAt: NOW,
            },
          };
          const marker: OrchestrationV2DomainEvent = {
            ...completed,
            payload: { ...completed.payload, status: "running" },
          };
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(domainEvents).pipe(
                Stream.tap((event) =>
                  event === marker ? Queue.offer(eventsConsumed, undefined) : Effect.void,
                ),
              ),
              getPullRequestSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 1,
                  threads: [thread],
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input, options) =>
                Effect.gen(function* () {
                  backgroundWork.push(yield* GitVcsDriver.BackgroundGitWork);
                  const refresh = options?.refresh ?? false;
                  lookups.push(refresh);
                  branches.push(input.branch);
                  yield* Queue.offer(lookupStarted, refresh);
                  if (lookups.length === 1) yield* Deferred.await(releaseStartup);
                  if (scenario === "in-flight" && lookups.length === 2) {
                    yield* Deferred.await(releaseRefresh);
                  }
                  return null;
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (_cwd, options) => {
                identityRefreshes.push(options?.refresh ?? false);
                return Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                });
              },
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunOpportunisticWork: Effect.succeed(false),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            Path.layer,
            FileSystem.layerNoop({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            expect(yield* Queue.take(lookupStarted)).toBe(false);
            if (scenario === "promotion") {
              yield* Queue.offer(domainEvents, {
                ...base,
                type: "thread.metadata-updated",
                payload: { ...thread, branch: "feature/newer", lastVisitedAt: null },
              });
            }
            yield* Queue.offer(domainEvents, completed);
            if (scenario !== "in-flight") yield* Queue.offer(domainEvents, checkpoint);
            yield* Queue.offer(domainEvents, marker);
            yield* Queue.take(eventsConsumed);
            yield* Deferred.succeed(releaseStartup, undefined);
            if (scenario === "in-flight") {
              expect(yield* Queue.take(lookupStarted)).toBe(true);
              thread = { ...thread, branch: "feature/newest" };
              yield* Queue.offerAll(domainEvents, [completed, checkpoint, marker]);
              yield* Queue.take(eventsConsumed);
              yield* Deferred.succeed(releaseRefresh, undefined);
            }
            yield* service.drain;
            const expected = scenario === "in-flight" ? [false, true, true] : [false, true];
            expect(lookups).toEqual(expected);
            expect(backgroundWork).toEqual(expected.map(() => true));
            expect(identityRefreshes).toEqual(expected);
            expect(branches).toEqual(
              scenario === "in-flight"
                ? ["feature/refresh", "feature/refresh", "feature/newest"]
                : ["feature/refresh", "feature/refresh"],
            );
          }).pipe(Effect.provide(dependencies));
        }),
      ),
  );

  it.effect("an event for one thread reads only that thread's pull request snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadShell("updated-thread");
        const other = threadShell("other-thread");
        const activation = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const reads =
          yield* Queue.unbounded<
            Parameters<Orchestrator.OrchestratorV2["Service"]["getPullRequestSnapshot"]>[0]
          >();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromPubSub(events),
            getPullRequestSnapshot: (options) =>
              Queue.offer(reads, options).pipe(
                Effect.as({
                  snapshotSequence: 1,
                  threads:
                    options.threadId === undefined
                      ? [thread, other]
                      : [thread, other].filter((candidate) => candidate.id === options.threadId),
                }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          Path.layer,
          FileSystem.layerNoop({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // Startup backfill reads every active thread.
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: false });
          yield* service.drain;
          const event: OrchestrationV2DomainEvent & { readonly type: "thread.metadata-updated" } = {
            type: "thread.metadata-updated",
            id: EventId.make("event:metadata"),
            threadId: thread.id,
            occurredAt: NOW,
            payload: {
              createdBy: thread.createdBy,
              creationSource: thread.creationSource,
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              activeProviderThreadId: thread.activeProviderThreadId,
              lineage: thread.lineage,
              forkedFrom: null,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          };
          yield* PubSub.publish(events, event);
          yield* PubSub.publish(events, {
            ...event,
            payload: {
              ...event.payload,
              title: "New title",
              issues: [
                {
                  provider: "github",
                  repository: "owner/repo",
                  number: 7,
                  url: "https://github.com/owner/repo/issues/7",
                  title: "Updated issue",
                  state: "closed",
                },
              ],
            },
          });
          yield* PubSub.publish(events, {
            ...event,
            payload: { ...event.payload, worktreePath: "/workspace/changed" },
          });
          expect(yield* Queue.take(reads)).toEqual({ threadId: thread.id });
          yield* service.drain;
          expect(yield* Queue.size(reads)).toBe(0);
          for (const changes of [
            { branch: "new-branch" },
            { projectId: ProjectId.make("new-project") },
          ]) {
            yield* PubSub.publish(events, { ...event, payload: { ...event.payload, ...changes } });
            expect(yield* Queue.take(reads)).toEqual({ threadId: thread.id });
            yield* service.drain;
            expect(yield* Queue.size(reads)).toBe(0);
          }
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  it.effect("does not sweep branch pull requests while no client is connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Polling active branches without a connected client wastes GitHub requests.
        const thread = { ...threadShell("idle-branch-thread"), branch: "feature/idle" };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const turnLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ refresh });
                if (refresh) yield* Deferred.succeed(turnLookup, undefined);
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          // No client holds an activity lease.
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // A finished turn still discovers the pull request for its branch.
          yield* Queue.offer(domainEvents, {
            type: "checkpoint.captured",
            threadId: thread.id,
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(turnLookup);
          yield* service.drain;
          const lookupsBeforeIdle = lookups.length;

          yield* TestClock.adjust("10 minutes");
          yield* service.drain;

          expect(lookups.slice(lookupsBeforeIdle)).toEqual([]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect("looks up a finished turn's branch once for all its turn-end events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = { ...threadShell("turn-end-thread"), branch: "t3/turn-end" };
        const otherThread = {
          ...threadShell("other-turn-end-thread"),
          branch: "t3/other-turn-end",
        };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        // A turn end commits its checkpoints and the run's end together.
        const metadata: OrchestrationV2DomainEvent & { readonly type: "thread.metadata-updated" } =
          {
            type: "thread.metadata-updated",
            id: EventId.make("event:turn-end:metadata"),
            threadId: thread.id,
            occurredAt: NOW,
            payload: {
              createdBy: thread.createdBy,
              creationSource: thread.creationSource,
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              activeProviderThreadId: thread.activeProviderThreadId,
              lineage: thread.lineage,
              forkedFrom: null,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          };
        const turnEnd = [
          metadata,
          { type: "checkpoint.captured", threadId: thread.id },
          { type: "checkpoint.captured", threadId: thread.id },
          { type: "run.updated", threadId: thread.id, payload: { status: "completed" } },
          { type: "checkpoint.captured", threadId: otherThread.id },
          { type: "run.updated", threadId: otherThread.id, payload: { status: "completed" } },
        ] as Array<OrchestrationV2DomainEvent>;
        // Arrives during the thread's own lookup, which may already have read the old host state.
        const duringLookup = [
          { type: "checkpoint.captured", threadId: thread.id },
          { ...metadata, id: EventId.make("event:turn-end:metadata-during-lookup") },
        ] as Array<OrchestrationV2DomainEvent>;
        const activation = yield* Deferred.make<void>();
        const sweepStarted = yield* Deferred.make<void>();
        const turnEndQueued = yield* Deferred.make<void>();
        const lookupStarted = yield* Deferred.make<void>();
        const followUpQueued = yield* Deferred.make<void>();
        const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            // The batch arrives while the worker is busy with the startup sweep.
            streamDomainEvents: Stream.fromEffect(Deferred.await(sweepStarted)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromIterable(turnEnd)),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(turnEndQueued, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.fromEffect(Deferred.await(lookupStarted)).pipe(Stream.drain)),
              Stream.concat(Stream.fromIterable(duringLookup)),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(followUpQueued, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
            getPullRequestSnapshot: ({ threadId }) =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread, otherThread].filter(
                  (candidate) => threadId === undefined || candidate.id === threadId,
                ),
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input, options) =>
              Effect.gen(function* () {
                lookups.push({ branch: input.branch, refresh: options?.refresh ?? false });
                if (!(yield* Deferred.isDone(turnEndQueued))) {
                  yield* Deferred.succeed(sweepStarted, undefined);
                  yield* Deferred.await(turnEndQueued);
                } else if (
                  input.branch === thread.branch &&
                  !(yield* Deferred.isDone(followUpQueued))
                ) {
                  yield* Deferred.succeed(lookupStarted, undefined);
                  yield* Deferred.await(followUpQueued);
                }
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(followUpQueued);
          yield* service.drain;
        }).pipe(Effect.provide(dependencies));

        // The startup sweep, one refresh lookup per thread for its turn-end batch, then one
        // follow-up refresh for the events that arrived during the thread's lookup.
        expect(lookups).toEqual([
          { branch: thread.branch, refresh: false },
          { branch: otherThread.branch, refresh: false },
          { branch: thread.branch, refresh: true },
          { branch: otherThread.branch, refresh: true },
          { branch: thread.branch, refresh: true },
        ]);
      }),
    ),
  );

  it.effect.each([
    {
      worktree: "a linked worktree",
      existingPaths: ["/workspace/worktree", "/workspace/worktree/.git"],
      unreadablePaths: [],
      cwd: "/workspace/worktree",
    },
    // A folder that outlived its .git makes git fail with not_a_repository.
    {
      worktree: "a folder without .git",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
    {
      worktree: "a folder whose .git cannot be checked",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: ["/workspace/worktree/.git"],
      cwd: "/workspace/worktree",
    },
    {
      worktree: "a missing folder",
      existingPaths: [],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
  ] as const)(
    "looks up a branch whose worktree is $worktree in $cwd",
    ({ existingPaths, unreadablePaths, cwd }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = {
            ...threadShell("worktree-thread"),
            settledOverride: "settled" as const,
            settledAt: NOW,
            branch: "feature/worktree",
            worktreePath: "/workspace/worktree",
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const lookupCwds: Array<string> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input) =>
                Effect.sync(() => {
                  lookupCwds.push(input.cwd);
                  return null;
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({
              exists: (path) =>
                unreadablePaths.some((entry) => entry === path)
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "exists",
                        pathOrDescriptor: path,
                      }),
                    )
                  : Effect.succeed(existingPaths.some((entry) => entry === path)),
            }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          expect(lookupCwds).toEqual([cwd]);
        }),
      ),
  );

  it.effect("leaves delegated child threads to their own refresh instead of the sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = {
          ...threadShell("parent-thread"),
          branch: "feature/parent",
          worktreePath: "/workspace/parent",
        };
        const child: OrchestrationV2ThreadShell = {
          ...threadShell("child-thread"),
          branch: "t3/reply-ok",
          worktreePath: "/workspace/child",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        };
        const project: OrchestrationProjectShell = {
          id: parent.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const sweeps = yield* Queue.unbounded<void>();
        const childLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: ({ threadId }) =>
              threadId !== undefined
                ? Effect.succeed({ snapshotSequence: 1, threads: [child] })
                : Queue.offer(sweeps, undefined).pipe(
                    Effect.as({
                      schemaVersion: 2,
                      snapshotSequence: 1,
                      threads: [parent, child],
                      archivedThreads: [],
                    }),
                  ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ branch: input.branch, refresh });
                if (input.branch === child.branch && refresh) {
                  yield* Deferred.succeed(childLookup, undefined);
                }
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(true),
            shouldRunOpportunisticWork: Effect.succeed(true),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // Startup backfill sweep, then one periodic sweep.
          yield* Queue.take(sweeps);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
          const sweepLookups = lookups.map((lookup) => lookup.branch).toSorted();

          // The child's own turn still discovers its pull request.
          yield* Queue.offer(domainEvents, {
            type: "checkpoint.captured",
            threadId: child.id,
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(childLookup);
          yield* service.drain;

          expect(sweepLookups).toEqual([parent.branch, parent.branch]);
          expect(lookups.slice(sweepLookups.length)).toEqual([
            { branch: child.branch, refresh: true },
          ]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect.each([
    { state: "open", checkedOut: false },
    { state: "merged", checkedOut: false },
    { state: "closed", checkedOut: false },
    { state: "merged", checkedOut: true },
  ] as const)(
    "associates a $state branch PR (checkedOut=$checkedOut) only with threads that predate its completion or saved it",
    ({ state, checkedOut }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const reference = {
            projectId: ProjectId.make("project-1"),
            repository: "acme/project",
            number: 42,
            url: "https://github.com/acme/project/pull/42",
          };
          const terminalAt = "2026-09-19T00:00:00.000Z";
          const detected = {
            number: 42,
            url: reference.url,
            title: "Previous staging work",
            baseRef: "main",
            headRef: "staging",
            state,
            updatedAt: terminalAt,
            closedAt: state === "closed" ? terminalAt : null,
            mergedAt: state === "merged" ? terminalAt : null,
            repositoryKey: "github.com/acme/project",
          };
          const threads = [
            { ...threadShell("older"), createdAt: DateTime.makeUnsafe("2026-09-18T00:00:00Z") },
            { ...threadShell("same-time"), createdAt: DateTime.makeUnsafe(terminalAt) },
            threadShell("new"),
            { ...threadShell("saved"), branchPullRequest: reference },
            { ...threadShell("explicit"), linkedPullRequest: reference },
          ].map((thread) => ({ ...thread, branch: "staging" }));
          const project: OrchestrationProjectShell = {
            id: reference.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({ snapshotSequence: 1, threads }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(detected),
              checkedOutPullRequest: () => Effect.succeed(checkedOut),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              summary: () =>
                Effect.succeed({
                  ...detected,
                  ...reference,
                  provider: SourceControlProviderKind.make("github"),
                  baseBranch: detected.baseRef,
                  headBranch: detected.headRef,
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({}),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          expect(
            commands.map((command) => {
              if (command.type !== "thread.pull-request.sync") throw new Error(command.type);
              expect(command).not.toHaveProperty("linkedPullRequest");
              return [command.threadId, command.branchPullRequest];
            }),
          ).toEqual(
            (state === "open" || checkedOut
              ? ["older", "same-time", "new", "explicit"]
              : ["older", "same-time"]
            ).map((id) => [id, reference]),
          );
        }),
      ),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const savedReference = {
            projectId: ProjectId.make("project-1"),
            repository: "acme/project",
            number: 42,
            url: "https://github.com/acme/project/pull/42",
          };
          const thread = {
            ...threadShell("branch-pr-thread"),
            branch: "main",
            branchPullRequest: savedReference,
            linkedPullRequest: savedReference,
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          let snapshotThread: unknown;
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: (options) =>
                Effect.gen(function* () {
                  const store = yield* ProjectionStore.ProjectionStoreV2;
                  yield* store.apply({
                    id: EventId.make(`event:${thread.id}:created`),
                    type: "thread.created",
                    threadId: thread.id,
                    occurredAt: NOW,
                    payload: { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null },
                  });
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql`INSERT INTO orchestration_events (
                    sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                    occurred_at, actor_kind, payload_json, metadata_json, application_event_version
                  ) VALUES (7, 'pr-discovery', 'thread', ${thread.id}, 1, 'thread.created',
                    '2026-09-20T00:00:00.000Z', 'system', '{}', '{}', 2)`;
                  for (const table of [
                    "orchestration_v2_projection_turn_items",
                    "orchestration_v2_projection_messages",
                    "orchestration_v2_projection_provider_threads",
                    "orchestration_v2_projection_runs",
                  ])
                    yield* sql.unsafe(`DROP TABLE ${table}`);
                  const snapshot = yield* store.getPullRequestSnapshot(options);
                  snapshotThread = snapshot.threads[0];
                  yield* Deferred.succeed(sweepStarted, undefined);
                  return snapshot;
                }).pipe(
                  Effect.provide(
                    ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
                  ),
                  Effect.orDie,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              summary: () =>
                Effect.succeed({
                  ...savedReference,
                  provider: SourceControlProviderKind.make("github"),
                  title: "Previous branch work",
                  state,
                  headBranch: sameBranch ? thread.branch : "feature/previous-work",
                  baseBranch: "release",
                  updatedAt: "2026-09-19T00:00:00.000Z",
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({}),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          expect(snapshotThread).toHaveProperty("createdAt", NOW);
          if (sameBranch) {
            expect(commands).toEqual([]);
          } else {
            expect(commands).toHaveLength(1);
            expect(commands[0]).toMatchObject({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              snapshotSequence: 7,
              expected: {
                workspaceRoot: project.workspaceRoot,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                linkedPullRequest: savedReference,
                branchPullRequest: savedReference,
              },
              branchPullRequest: null,
            });
            expect(commands[0]).not.toHaveProperty("linkedPullRequest");
          }
        }),
      ),
  );
});
