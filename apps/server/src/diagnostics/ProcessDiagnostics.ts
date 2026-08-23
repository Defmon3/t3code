import type {
  ResourceTelemetryProcessCategory,
  ResourceMonitorDiscoveredProcessSample,
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from "@t3tools/contracts";
import { isTestCommand } from "@t3tools/shared/testCommand";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";

const PROCESS_DISCOVERY_CACHE_TTL = Duration.seconds(2);

interface ProcessDiscoveryCacheEntry {
  readonly expiresAtMillis: number | undefined;
  readonly read: Effect.Effect<ServerProcessDiagnosticsResult>;
}

export class ProcessSignalFailed extends Schema.TaggedErrorClass<ProcessSignalFailed>()(
  "ProcessSignalFailed",
  {
    pid: Schema.Number,
    signal: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to signal process ${this.pid} with ${this.signal}.`;
  }
}

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  {
    readonly read: (input: {
      readonly roots?: ReadonlyArray<string>;
    }) => Effect.Effect<ServerProcessDiagnosticsResult>;
    readonly unavailable: (message: string) => Effect.Effect<ServerProcessDiagnosticsResult>;
    readonly signal: (input: {
      readonly pid: number;
      readonly startTimeMs: number;
      readonly signal: ServerProcessSignal;
    }) => Effect.Effect<ServerSignalProcessResult>;
  }
>()("t3/diagnostics/ProcessDiagnostics") {}

function formatElapsed(runTimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(runTimeMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function canSignalCategory(category: ResourceTelemetryProcessCategory): boolean {
  return (
    category === "server-child" || category === "provider-root" || category === "terminal-root"
  );
}

export interface HostCpuTicks {
  readonly idle: number;
  readonly total: number;
}

export function hostCpuTicks(cpus: readonly NodeOS.CpuInfo[]): HostCpuTicks {
  return cpus.reduce(
    (ticks, cpu) => ({
      idle: ticks.idle + cpu.times.idle,
      total:
        ticks.total +
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq,
    }),
    { idle: 0, total: 0 },
  );
}

export function hostCpuPercent(previous: HostCpuTicks | undefined, current: HostCpuTicks): number {
  if (!previous) return 0;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return 0;
  const activeDelta = totalDelta - (current.idle - previous.idle);
  return Math.min(100, Math.max(0, (activeDelta / totalDelta) * 100));
}

export function hostMemoryUsage(
  totalBytes: number,
  freeBytes: number,
): {
  readonly usedBytes: number;
  readonly totalBytes: number;
} {
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes < 0 ||
    !Number.isFinite(freeBytes) ||
    freeBytes < 0
  ) {
    throw new RangeError("Host memory values must be non-negative finite numbers.");
  }
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

export function createHostMetricsSampler(input: {
  readonly readCpuTicks: () => HostCpuTicks;
  readonly readFreeMemory: () => number;
  readonly readTotalMemory: () => number;
}): {
  readonly read: (mode: "t3" | "discovery") => {
    readonly hostCpuPercent: number;
    readonly hostMemoryUsedBytes: number;
    readonly hostMemoryTotalBytes: number;
  };
} {
  let previousT3CpuTicks: HostCpuTicks | undefined;
  let previousDiscoveryCpuTicks: HostCpuTicks | undefined;
  const read = (mode: "t3" | "discovery") => {
    const currentCpuTicks = input.readCpuTicks();
    const previousCpuTicks = mode === "t3" ? previousT3CpuTicks : previousDiscoveryCpuTicks;
    const cpuPercent = hostCpuPercent(previousCpuTicks, currentCpuTicks);
    if (mode === "t3") {
      previousT3CpuTicks = currentCpuTicks;
    } else {
      previousDiscoveryCpuTicks = currentCpuTicks;
    }
    const memory = hostMemoryUsage(input.readTotalMemory(), input.readFreeMemory());
    return {
      hostCpuPercent: cpuPercent,
      hostMemoryUsedBytes: memory.usedBytes,
      hostMemoryTotalBytes: memory.totalBytes,
    };
  };
  return { read };
}

export function normalizeMachineCpuPercent(cpuPercent: number, logicalCpuCount: number): number {
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0) {
    throw new RangeError("Discovered process CPU percent must be a non-negative finite number.");
  }
  if (!Number.isInteger(logicalCpuCount) || logicalCpuCount <= 0) {
    throw new RangeError("Logical CPU count must be a positive integer.");
  }
  return Math.min(100, cpuPercent / logicalCpuCount);
}

function toDiscoveredProcessDiagnosticsEntry(
  entry: ResourceMonitorDiscoveredProcessSample,
  logicalCpuCount: number,
): ServerProcessDiagnosticsEntry {
  return {
    pid: entry.pid,
    startTimeMs: entry.startTimeMs,
    ppid: entry.ppid,
    pgid: Option.none(),
    status: entry.status || "Unknown",
    cpuPercent: normalizeMachineCpuPercent(entry.cpuPercent, logicalCpuCount),
    cpuTimeMs: entry.cpuTimeMs,
    rssBytes: entry.residentBytes,
    elapsed: formatElapsed(entry.runTimeMs),
    command: entry.command || entry.name || "unknown",
    ...(entry.argv === undefined ? {} : { argv: entry.argv }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    depth: 0,
    childPids: [],
  };
}

function processDiscoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Process discovery failed.";
}

function isWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function normalizeRegisteredPath(path: string): string {
  const slashSeparated = path.replaceAll("\\", "/");
  const normalized =
    slashSeparated.length > 1 && !/^[a-z]:\/$/i.test(slashSeparated)
      ? slashSeparated.replace(/\/+$/, "")
      : slashSeparated;
  return isWindowsPath(path) ? normalized.toLowerCase() : normalized;
}

function normalizeRegisteredRoots(roots: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(roots.map(normalizeRegisteredPath))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function isWithinRegisteredRoot(cwd: string, root: string): boolean {
  return cwd === root || (root.endsWith("/") ? cwd.startsWith(root) : cwd.startsWith(`${root}/`));
}

export function registeredRootForCwd(
  cwd: string | undefined,
  roots: ReadonlyArray<string>,
): string | undefined {
  if (!cwd) return undefined;
  const normalizedCwd = normalizeRegisteredPath(cwd);
  return roots
    .map((root) => normalizeRegisteredPath(root))
    .filter((root) => isWithinRegisteredRoot(normalizedCwd, root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
}

function rootsDiffer(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

function discoveredTestProcesses(
  discovered: ReadonlyArray<ResourceMonitorDiscoveredProcessSample>,
  roots: ReadonlyArray<string>,
): ReadonlyArray<ResourceMonitorDiscoveredProcessSample> {
  const processesByPid = new Map(discovered.map((process) => [process.pid, process]));
  const childrenByParent = new Map<number, ResourceMonitorDiscoveredProcessSample[]>();
  for (const process of discovered) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }
  const readonlyChildrenByParent: ReadonlyMap<
    number,
    ReadonlyArray<ResourceMonitorDiscoveredProcessSample>
  > = childrenByParent;
  const testPids = new Set(
    discovered
      .filter((process) => isTestCommand(process.command, process.argv))
      .map((process) => process.pid),
  );
  const rootByPid = new Map(
    discovered.map((process) => [process.pid, registeredRootForCwd(process.cwd, roots)]),
  );
  return discovered
    .filter(
      (process) =>
        testPids.has(process.pid) &&
        !hasTestProcessAncestor(process, processesByPid, testPids, rootByPid),
    )
    .map((process) =>
      aggregateTestProcessResources(process, readonlyChildrenByParent, testPids, rootByPid),
    );
}

function aggregateTestProcessResources(
  process: ResourceMonitorDiscoveredProcessSample,
  childrenByParent: ReadonlyMap<number, ReadonlyArray<ResourceMonitorDiscoveredProcessSample>>,
  testPids: ReadonlySet<number>,
  rootByPid: ReadonlyMap<number, string | undefined>,
): ResourceMonitorDiscoveredProcessSample {
  const descendants: ResourceMonitorDiscoveredProcessSample[] = [];
  const visited = new Set<number>();
  const pending = [process];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.pid)) continue;
    visited.add(current.pid);
    if (
      current.pid !== process.pid &&
      testPids.has(current.pid) &&
      rootsDiffer(rootByPid.get(process.pid), rootByPid.get(current.pid))
    ) {
      continue;
    }
    descendants.push(current);
    pending.push(...(childrenByParent.get(current.pid) ?? []));
  }
  return {
    ...process,
    cpuPercent: descendants.reduce((total, descendant) => total + descendant.cpuPercent, 0),
    cpuTimeMs: descendants.reduce((total, descendant) => total + descendant.cpuTimeMs, 0),
    residentBytes: descendants.reduce((total, descendant) => total + descendant.residentBytes, 0),
  };
}

function hasTestProcessAncestor(
  process: ResourceMonitorDiscoveredProcessSample,
  processesByPid: ReadonlyMap<number, ResourceMonitorDiscoveredProcessSample>,
  testPids: ReadonlySet<number>,
  rootByPid: ReadonlyMap<number, string | undefined>,
): boolean {
  const visited = new Set<number>();
  let parentPid = process.ppid;
  while (parentPid > 0 && !visited.has(parentPid)) {
    visited.add(parentPid);
    if (
      testPids.has(parentPid) &&
      !rootsDiffer(rootByPid.get(process.pid), rootByPid.get(parentPid))
    ) {
      return true;
    }
    const parent = processesByPid.get(parentPid);
    if (!parent || parent.ppid === parentPid) return false;
    parentPid = parent.ppid;
  }
  return false;
}

export const make = Effect.fn("makeProcessDiagnostics")(function* (
  options: {
    readonly logicalCpuCount?: number;
    readonly readCpuInfos?: () => readonly NodeOS.CpuInfo[];
    readonly readFreeMemory?: () => number;
    readonly readTotalMemory?: () => number;
  } = {},
) {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const logicalCpuCount = options.logicalCpuCount ?? NodeOS.availableParallelism();
  const readCpuInfos = options.readCpuInfos ?? NodeOS.cpus;
  const readFreeMemory = options.readFreeMemory ?? NodeOS.freemem;
  const readTotalMemory = options.readTotalMemory ?? NodeOS.totalmem;
  const processDiscoveryCache = new Map<string, ProcessDiscoveryCacheEntry>();
  const processDiscoveryCacheMutex = yield* Semaphore.make(1);
  const hostMetrics = createHostMetricsSampler({
    readCpuTicks: () => hostCpuTicks(readCpuInfos()),
    readFreeMemory,
    readTotalMemory,
  });
  const refreshedTelemetry = telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
  const readT3Diagnostics = refreshedTelemetry.pipe(
    Effect.map((snapshot) => {
      const processes = snapshot.processes
        .filter((entry) => canSignalCategory(entry.category))
        .map(
          (entry): ServerProcessDiagnosticsEntry => ({
            pid: entry.identity.pid,
            startTimeMs: entry.identity.startTimeMs,
            ppid: entry.ppid,
            pgid: Option.none(),
            status: entry.status || "Unknown",
            cpuPercent: entry.cpuPercent,
            cpuTimeMs: entry.cpuTimeMs,
            rssBytes: entry.residentBytes,
            elapsed: formatElapsed(entry.runTimeMs),
            command: entry.command || entry.name || "unknown",
            depth: Math.max(0, entry.depth - 1),
            childPids: entry.childPids,
          }),
        );
      return {
        serverPid: process.pid,
        readAt: snapshot.readAt,
        processCount: processes.length,
        totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
        totalCpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
        ...hostMetrics.read("t3"),
        processes,
        error: Option.map(snapshot.health.native.lastError, (message) => ({ message })),
      };
    }),
  );
  const unavailable: ProcessDiagnostics["Service"]["unavailable"] = (message) =>
    DateTime.now.pipe(
      Effect.map((readAt) => ({
        serverPid: process.pid,
        readAt,
        processCount: 0,
        totalRssBytes: 0,
        totalCpuPercent: 0,
        ...hostMetrics.read("discovery"),
        processes: [],
        error: Option.some({ message }),
      })),
    );
  const readRegisteredProjectDiagnostics = (roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const discovered = yield* nativeTelemetry.discoverProcesses(roots);
      const readAt = yield* DateTime.now;
      const processes = discoveredTestProcesses(discovered, roots).map((entry) =>
        toDiscoveredProcessDiagnosticsEntry(entry, logicalCpuCount),
      );
      return {
        serverPid: process.pid,
        readAt,
        processCount: processes.length,
        totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
        totalCpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
        ...hostMetrics.read("discovery"),
        processes,
        error: Option.none(),
      };
    }).pipe(Effect.catch((error) => unavailable(processDiscoveryErrorMessage(error))));
  const cachedRegisteredProjectDiagnostics = (roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const normalizedRoots = normalizeRegisteredRoots(roots);
      const cacheKey = normalizedRoots.join("\u0000");
      const selected = yield* processDiscoveryCacheMutex.withPermits(1)(
        Effect.gen(function* () {
          const nowMillis = yield* Clock.currentTimeMillis;
          for (const [key, entry] of processDiscoveryCache) {
            if (entry.expiresAtMillis !== undefined && entry.expiresAtMillis <= nowMillis) {
              processDiscoveryCache.delete(key);
            }
          }
          const cached = processDiscoveryCache.get(cacheKey);
          if (cached) return { read: cached.read };

          let cacheEntry: ProcessDiscoveryCacheEntry | undefined;
          const markCacheEntrySettled = Clock.currentTimeMillis.pipe(
            Effect.tap((settledAtMillis) =>
              Effect.sync(() => {
                if (cacheEntry && processDiscoveryCache.get(cacheKey) === cacheEntry) {
                  processDiscoveryCache.set(cacheKey, {
                    ...cacheEntry,
                    expiresAtMillis:
                      settledAtMillis + Duration.toMillis(PROCESS_DISCOVERY_CACHE_TTL),
                  });
                }
              }),
            ),
          );
          const cachedRead = yield* Effect.cachedWithTTL(
            readRegisteredProjectDiagnostics(normalizedRoots).pipe(
              Effect.ensuring(markCacheEntrySettled),
              Effect.uninterruptible,
            ),
            PROCESS_DISCOVERY_CACHE_TTL,
          );
          cacheEntry = {
            expiresAtMillis: undefined,
            read: cachedRead,
          };
          processDiscoveryCache.set(cacheKey, cacheEntry);
          return { read: cachedRead };
        }),
      );
      return yield* selected.read;
    });
  const read: ProcessDiagnostics["Service"]["read"] = (input) => {
    const roots = input.roots;
    return roots === undefined ? readT3Diagnostics : cachedRegisteredProjectDiagnostics(roots);
  };

  const signal: ProcessDiagnostics["Service"]["signal"] = Effect.fn("ProcessDiagnostics.signal")(
    function* (input) {
      if (input.pid === process.pid) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some("Refusing to signal the T3 server process."),
        };
      }
      const current = yield* telemetry.refresh.pipe(Effect.option);
      if (Option.isNone(current)) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(
            `Could not refresh process ${input.pid}; refusing to signal a stale identity.`,
          ),
        };
      }
      const selected = current.value.processes.find(
        (entry) =>
          entry.identity.pid === input.pid && entry.identity.startTimeMs === input.startTimeMs,
      );
      if (!selected) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(
            `Process ${input.pid} no longer matches the selected process identity.`,
          ),
        };
      }
      if (!canSignalCategory(selected.category)) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(`Process ${input.pid} is not a signalable T3 backend descendant.`),
        };
      }
      return yield* Effect.try({
        try: () => {
          process.kill(input.pid, input.signal);
          return {
            pid: input.pid,
            signal: input.signal,
            signaled: true,
            message: Option.none(),
          };
        },
        catch: (cause) =>
          new ProcessSignalFailed({
            pid: input.pid,
            signal: input.signal,
            cause,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some(
              error instanceof Error ? error.message : "Failed to signal process.",
            ),
          }),
        ),
      );
    },
  );

  return ProcessDiagnostics.of({ read, signal, unavailable });
});

export const layer = Layer.effect(ProcessDiagnostics, make());
