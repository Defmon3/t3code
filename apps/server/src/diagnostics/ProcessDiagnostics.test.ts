import { describe, expect, it } from "@effect/vitest";
import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorDiscoveredProcessSample,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

function makeNativeSnapshot(
  processes: ResourceMonitorSnapshotEvent["processes"],
): ResourceMonitorSnapshotEvent {
  return {
    version: 4,
    type: "snapshot",
    sequence: 1,
    sampledAtUnixMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z")),
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

function makeTelemetryLayer(
  snapshot: ResourceMonitorSnapshotEvent,
  desktopSnapshot?: DesktopHostTelemetrySnapshot,
  nativeOverrides: Parameters<typeof NativeTelemetryClient.layerTest>[0] = {},
) {
  const nativeLayer = NativeTelemetryClient.layerTest({
    sampleNow: Effect.succeed({ generation: 0, snapshot }),
    health: Effect.succeed({
      status: "healthy",
      hello: Option.none(),
      lastSampleAt: Option.some(DateTime.makeUnsafe(snapshot.sampledAtUnixMs)),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
    ...nativeOverrides,
  });
  const desktopLayer = desktopSnapshot
    ? DesktopTelemetryReceiver.layerTest({
        latest: Effect.succeedSome(desktopSnapshot),
        health: Effect.succeed({
          status: "healthy",
          lastSampleAt: Option.some(DateTime.makeUnsafe(desktopSnapshot.sampledAtUnixMs)),
          lastError: Option.none(),
        }),
      })
    : DesktopTelemetryReceiver.layerTest();
  const telemetryLayer = ResourceTelemetry.layer.pipe(
    Layer.provide(Layer.mergeAll(nativeLayer, desktopLayer, ResourceAttribution.layer)),
  );
  return Layer.merge(telemetryLayer, nativeLayer);
}

describe("ProcessDiagnostics", () => {
  it.effect("coalesces registered-project discovery and evicts expired root-set entries", () =>
    Effect.gen(function* () {
      const discoveryStarted = yield* Deferred.make<void>();
      const releaseDiscovery = yield* Deferred.make<void>();
      const discoveredRootSets: string[][] = [];
      let discoveryCalls = 0;
      const telemetryLayer = makeTelemetryLayer(makeNativeSnapshot([]), undefined, {
        discoverProcesses: (roots) =>
          Effect.gen(function* () {
            discoveryCalls += 1;
            discoveredRootSets.push([...roots]);
            if (discoveryCalls === 1) {
              yield* Deferred.succeed(discoveryStarted, undefined);
              yield* Deferred.await(releaseDiscovery);
            }
            return [];
          }),
      });
      const layer = ProcessDiagnostics.layer.pipe(Layer.provideMerge(telemetryLayer));
      const read = (roots: ReadonlyArray<string>) =>
        Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
          Effect.flatMap((processDiagnostics) => processDiagnostics.read({ roots })),
        );

      return yield* Effect.gen(function* () {
        const first = yield* Effect.forkChild(read(["C:\\Workspace\\project", "c:/workspace"]));
        yield* Deferred.await(discoveryStarted);
        yield* TestClock.adjust("2 seconds");
        const second = yield* Effect.forkChild(read(["C:/WORKSPACE", "c:\\workspace\\project\\"]));
        yield* Effect.yieldNow;

        expect(discoveryCalls).toBe(1);
        yield* Deferred.succeed(releaseDiscovery, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(discoveredRootSets).toEqual([["c:/workspace", "c:/workspace/project"]]);
        yield* read(["c:/workspace", "c:/workspace/project"]);
        expect(discoveryCalls).toBe(1);

        yield* read(["/workspace/other"]);
        expect(discoveryCalls).toBe(2);
        expect(discoveredRootSets[1]).toEqual(["/workspace/other"]);

        yield* TestClock.adjust("2 seconds");
        yield* read(["c:/workspace", "c:/workspace/project"]);
        expect(discoveryCalls).toBe(3);
        expect(discoveredRootSets[2]).toEqual(["c:/workspace", "c:/workspace/project"]);
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())));
    }),
  );

  it.effect("aggregates a large test-process sibling set", () =>
    Effect.gen(function* () {
      const root: ResourceMonitorDiscoveredProcessSample = {
        pid: 1,
        ppid: 0,
        startTimeMs: 1_000,
        runTimeMs: 1_000,
        name: "pnpm",
        command: "pnpm test",
        argv: ["pnpm", "test"],
        cwd: "/workspace",
        status: "Running",
        cpuPercent: 0,
        cpuTimeMs: 1,
        residentBytes: 1,
        virtualBytes: 1,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioSemantics: "storage",
      };
      const children = Array.from(
        { length: 4_096 },
        (_, index) =>
          ({
            pid: index + 2,
            ppid: root.pid,
            startTimeMs: index + 2_000,
            runTimeMs: 1_000,
            name: "node",
            command: "node worker.js",
            argv: ["node", "worker.js"],
            cwd: "/workspace",
            status: "Running",
            cpuPercent: 0,
            cpuTimeMs: 1,
            residentBytes: 1,
            virtualBytes: 1,
            ioReadBytes: 0,
            ioWriteBytes: 0,
            ioSemantics: "storage" as const,
          }) satisfies ResourceMonitorDiscoveredProcessSample,
      );
      const telemetryLayer = makeTelemetryLayer(makeNativeSnapshot([]), undefined, {
        discoverProcesses: () => Effect.succeed([root, ...children]),
      });
      const layer = Layer.effect(
        ProcessDiagnostics.ProcessDiagnostics,
        ProcessDiagnostics.make({ logicalCpuCount: 1 }),
      ).pipe(Layer.provideMerge(telemetryLayer));
      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) => processDiagnostics.read({ roots: ["/workspace"] })),
        Effect.provide(layer),
      );

      expect(diagnostics.processes).toMatchObject([
        {
          pid: root.pid,
          cpuTimeMs: 4_097,
          rssBytes: 4_097,
        },
      ]);
      expect(diagnostics.processCount).toBe(1);
      expect(diagnostics.totalRssBytes).toBe(4_097);
    }),
  );

  it.effect("projects live process data from resource telemetry", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: process.pid,
          ppid: 1,
          startTimeMs: 1_000,
          runTimeMs: 60_000,
          name: "node",
          command: "t3 server",
          status: "Running",
          cpuPercent: 0,
          cpuTimeMs: 100,
          residentBytes: 1_024,
          virtualBytes: 2_048,
          ioReadBytes: 100,
          ioWriteBytes: 200,
          ioSemantics: "storage",
        },
        {
          pid: 4_242,
          ppid: process.pid,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "agent",
          command: "codex app-server",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const telemetryLayer = makeTelemetryLayer(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provideMerge(telemetryLayer));

      const diagnostics = yield* Effect.gen(function* () {
        const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
        return yield* processDiagnostics.read({});
      }).pipe(Effect.provide(layer));

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([4242]);
      expect(diagnostics.processes[0]?.startTimeMs).toBe(2_000);
      expect(diagnostics.processes[0]?.cpuPercent).toBe(1.5);
      expect(diagnostics.processes[0]?.rssBytes).toBe(2_048);
      expect(diagnostics.processes[0]).not.toHaveProperty("argv");
      expect(diagnostics.processes[0]).not.toHaveProperty("cwd");
    }),
  );

  it.effect(
    "keeps nested tests from another registered root separate without double-counting resources",
    () =>
      Effect.gen(function* () {
        const snapshot = makeNativeSnapshot([]);
        const telemetryLayer = makeTelemetryLayer(snapshot, undefined, {
          discoverProcesses: () =>
            Effect.succeed([
              {
                pid: 4_242,
                ppid: 1,
                startTimeMs: 2_000,
                runTimeMs: 4_000,
                name: "agent",
                command: "pnpm test",
                argv: ["pnpm", "test"],
                cwd: "/workspace",
                status: "Running",
                cpuPercent: 1.5,
                cpuTimeMs: 60,
                residentBytes: 2_048,
                virtualBytes: 4_096,
                ioReadBytes: 300,
                ioWriteBytes: 400,
                ioSemantics: "storage" as const,
              },
              {
                pid: 4_243,
                ppid: 4_242,
                startTimeMs: 2_001,
                runTimeMs: 3_000,
                name: "sh",
                command: "sh",
                argv: ["sh"],
                cwd: "/outside-registered-root",
                status: "Running",
                cpuPercent: 0.5,
                cpuTimeMs: 30,
                residentBytes: 1_024,
                virtualBytes: 2_048,
                ioReadBytes: 100,
                ioWriteBytes: 200,
                ioSemantics: "storage" as const,
              },
              {
                pid: 4_244,
                ppid: 4_243,
                startTimeMs: 2_002,
                runTimeMs: 2_000,
                name: "node",
                command: "vitest run",
                argv: ["vitest", "run"],
                cwd: "/workspace/process-monitor-pane",
                status: "Running",
                cpuPercent: 1,
                cpuTimeMs: 45,
                residentBytes: 1_024,
                virtualBytes: 2_048,
                ioReadBytes: 100,
                ioWriteBytes: 200,
                ioSemantics: "storage" as const,
              },
              {
                pid: 4_246,
                ppid: 4_244,
                startTimeMs: 2_004,
                runTimeMs: 1_000,
                name: "jest",
                command: "jest",
                argv: ["jest"],
                cwd: "/workspace/process-monitor-pane/src",
                status: "Running",
                cpuPercent: 0.25,
                cpuTimeMs: 20,
                residentBytes: 512,
                virtualBytes: 1_024,
                ioReadBytes: 100,
                ioWriteBytes: 200,
                ioSemantics: "storage" as const,
              },
              {
                pid: 4_245,
                ppid: 1,
                startTimeMs: 2_003,
                runTimeMs: 1_000,
                name: "node",
                command: "node app-server.js",
                argv: ["node", "app-server.js"],
                cwd: "/workspace",
                status: "Running",
                cpuPercent: 0.5,
                cpuTimeMs: 15,
                residentBytes: 1_024,
                virtualBytes: 2_048,
                ioReadBytes: 100,
                ioWriteBytes: 200,
                ioSemantics: "storage" as const,
              },
            ]),
        });
        const layer = Layer.effect(
          ProcessDiagnostics.ProcessDiagnostics,
          ProcessDiagnostics.make({ logicalCpuCount: 4 }),
        ).pipe(Layer.provideMerge(telemetryLayer));
        const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
          Effect.flatMap((processDiagnostics) =>
            processDiagnostics.read({ roots: ["/workspace", "/workspace/process-monitor-pane"] }),
          ),
          Effect.provide(layer),
        );

        expect(diagnostics.processes).toMatchObject([
          {
            pid: 4_242,
            argv: ["pnpm", "test"],
            cwd: "/workspace",
            cpuPercent: 0.5,
            cpuTimeMs: 90,
            rssBytes: 3_072,
            depth: 0,
            childPids: [],
          },
          {
            pid: 4_244,
            cwd: "/workspace/process-monitor-pane",
            cpuPercent: 0.3125,
            cpuTimeMs: 65,
            rssBytes: 1_536,
            depth: 0,
            childPids: [],
          },
        ]);
        expect(diagnostics.processCount).toBe(2);
        expect(diagnostics.totalCpuPercent).toBe(0.8125);
        expect(diagnostics.totalRssBytes).toBe(4_608);

        const signalResult = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
          Effect.flatMap((processDiagnostics) =>
            processDiagnostics.signal({
              pid: 4_242,
              startTimeMs: 2_000,
              signal: "SIGINT",
            }),
          ),
          Effect.provide(layer),
        );
        expect(signalResult.signaled).toBe(false);
      }),
  );

  it("normalizes discovered CPU usage to machine share and clamps it to 100%", () => {
    expect(ProcessDiagnostics.normalizeMachineCpuPercent(3, 4)).toBe(0.75);
    expect(ProcessDiagnostics.normalizeMachineCpuPercent(1_000, 4)).toBe(100);
  });

  it("matches the deepest registered root with platform-correct path casing", () => {
    expect(
      ProcessDiagnostics.registeredRootForCwd("c:/CODE/worktree/src", [
        "C:\\code",
        "C:\\code\\worktree",
      ]),
    ).toBe("c:/code/worktree");
    expect(
      ProcessDiagnostics.registeredRootForCwd("/workspace/feature/src", [
        "/workspace",
        "/workspace/feature",
      ]),
    ).toBe("/workspace/feature");
    expect(
      ProcessDiagnostics.registeredRootForCwd("/workspace/Feature/src", ["/workspace/feature"]),
    ).toBeUndefined();
  });

  it("derives machine-relative host CPU and memory metrics from injected OS samples", () => {
    expect(
      ProcessDiagnostics.hostCpuPercent({ idle: 100, total: 400 }, { idle: 160, total: 600 }),
    ).toBe(70);
    expect(ProcessDiagnostics.hostCpuPercent(undefined, { idle: 160, total: 600 })).toBe(0);
    expect(ProcessDiagnostics.hostMemoryUsage(1_024, 256)).toEqual({
      totalBytes: 1_024,
      usedBytes: 768,
    });
  });

  it("keeps ordinary and registered-project host CPU sampling baselines independent", () => {
    const samples = [
      { idle: 100, total: 400 },
      { idle: 160, total: 600 },
      { idle: 220, total: 800 },
      { idle: 260, total: 1_000 },
    ];
    const sampler = ProcessDiagnostics.createHostMetricsSampler({
      readCpuTicks: () => {
        const sample = samples.shift();
        if (!sample) throw new Error("Missing CPU tick sample.");
        return sample;
      },
      readFreeMemory: () => 256,
      readTotalMemory: () => 1_024,
    });

    expect(sampler.read("t3").hostCpuPercent).toBe(0);
    expect(sampler.read("discovery").hostCpuPercent).toBe(0);
    expect(sampler.read("t3").hostCpuPercent).toBe(70);
    expect(sampler.read("discovery").hostCpuPercent).toBe(75);
  });

  it.effect("rejects stale process identities before signaling", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([]);
      const telemetryLayer = makeTelemetryLayer(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(telemetryLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: 4_242,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4242,
        signal: "SIGINT",
        signaled: false,
        message: Option.some("Process 4242 no longer matches the selected process identity."),
      });
    }),
  );

  it.effect("refuses to signal when a fresh identity check cannot be collected", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: 4_242,
          ppid: process.pid,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "agent",
          command: "codex app-server",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const staleTelemetry = yield* Effect.service(ResourceTelemetry.ResourceTelemetry).pipe(
        Effect.flatMap((telemetry) => telemetry.latest),
        Effect.provide(makeTelemetryLayer(snapshot)),
      );
      const telemetryLayer = Layer.succeed(
        ResourceTelemetry.ResourceTelemetry,
        ResourceTelemetry.ResourceTelemetry.of({
          latest: Effect.succeed(staleTelemetry),
          changes: Stream.empty,
          subscribe: Effect.die("unused"),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.fail(
            new ResourceTelemetry.ResourceTelemetryRefreshFailed({
              operation: "refresh",
              cause: new Error("collector unavailable"),
            }),
          ),
          validateProcessIdentity: () => Effect.die("unused"),
          retry: Effect.die("unused"),
        }),
      );
      const layer = ProcessDiagnostics.layer.pipe(
        Layer.provide(Layer.merge(telemetryLayer, NativeTelemetryClient.layerTest())),
      );

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: 4_242,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4_242,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          "Could not refresh process 4242; refusing to signal a stale identity.",
        ),
      });
    }),
  );

  it.effect("rejects Electron processes as signal targets", () =>
    Effect.gen(function* () {
      const sampledAtUnixMs = DateTime.toEpochMillis(
        DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
      );
      const snapshot = makeNativeSnapshot([
        {
          pid: 4_242,
          ppid: 1,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "electron",
          command: "electron",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
      const telemetryLayer = makeTelemetryLayer(snapshot, {
        version: 1,
        type: "desktopTelemetry",
        sequence: 1,
        sampledAtUnixMs,
        electronPid: 4_242,
        power: {
          source: "electron-main",
          idle: "false",
          idleSeconds: 0,
          locked: "false",
          suspended: false,
          onBattery: "false",
          lowPowerMode: "unknown",
          thermalState: "nominal",
          stale: false,
          updatedAt: sampledAt,
        },
        speedLimitPercent: Option.none(),
        electronProcesses: [
          {
            pid: 4_242,
            creationTimeMs: 2_000,
            type: "Browser",
            name: "electron",
            cpuPercent: 1.5,
            idleWakeupsPerSecond: 0,
            workingSetBytes: 2_048,
            peakWorkingSetBytes: 2_048,
          },
        ],
      });
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(telemetryLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: 4_242,
            startTimeMs: 2_000,
            signal: "SIGKILL",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4_242,
        signal: "SIGKILL",
        signaled: false,
        message: Option.some("Process 4242 is not a signalable T3 backend descendant."),
      });

      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) => processDiagnostics.read({})),
        Effect.provide(layer),
      );
      expect(diagnostics.processes).toEqual([]);
      expect(diagnostics.processCount).toBe(0);
      expect(diagnostics.totalCpuPercent).toBe(0);
      expect(diagnostics.totalRssBytes).toBe(0);
    }),
  );
});
