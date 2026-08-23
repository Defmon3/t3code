import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  RESOURCE_MONITOR_DISCOVERY_MAX_PROCESSES,
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorErrorEvent,
  ResourceMonitorProcessDiscoveryEvent,
} from "./resourceTelemetry.ts";

const decodeDiscoveryEvent = Schema.decodeUnknownSync(ResourceMonitorProcessDiscoveryEvent);
const decodeErrorEvent = Schema.decodeUnknownSync(ResourceMonitorErrorEvent);

const process = (pid: number) => ({
  pid,
  ppid: 1,
  startTimeMs: 0,
  runTimeMs: 0,
  name: "vitest",
  command: "vp test",
  status: "Run",
  cpuPercent: 0,
  cpuTimeMs: 0,
  residentBytes: 0,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioSemantics: "storage" as const,
});

describe("resource monitor discovery protocol", () => {
  it("accepts bounded chunks and an empty completion chunk", () => {
    const event = decodeDiscoveryEvent({
      version: RESOURCE_MONITOR_PROTOCOL_VERSION,
      type: "processDiscovery",
      requestId: "discovery-1",
      done: false,
      processes: Array.from({ length: RESOURCE_MONITOR_DISCOVERY_MAX_PROCESSES }, (_, index) =>
        process(index + 1),
      ),
    });
    const completion = decodeDiscoveryEvent({
      version: RESOURCE_MONITOR_PROTOCOL_VERSION,
      type: "processDiscovery",
      requestId: "discovery-1",
      done: true,
      processes: [],
    });

    expect(event.processes).toHaveLength(RESOURCE_MONITOR_DISCOVERY_MAX_PROCESSES);
    expect(completion.done).toBe(true);
  });

  it("rejects an oversized chunk and accepts a request-scoped discovery error", () => {
    expect(() =>
      decodeDiscoveryEvent({
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "processDiscovery",
        requestId: "discovery-1",
        done: true,
        processes: Array.from(
          { length: RESOURCE_MONITOR_DISCOVERY_MAX_PROCESSES + 1 },
          (_, index) => process(index + 1),
        ),
      }),
    ).toThrow();
    expect(
      decodeErrorEvent({
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "error",
        code: "discovery-limit-exceeded",
        message: "narrow the requested roots",
        recoverable: true,
        requestId: "discovery-1",
      }).requestId,
    ).toBe("discovery-1");
  });
});
