import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useProcessPanelSurfaceStore } from "./ProcessPanelSurface";

const environmentId = "environment-1" as EnvironmentId;
const input = {
  environmentId,
  environmentConnectionPhase: "connected" as EnvironmentConnectionPhase,
  projects: [],
  threads: [],
};
const rect = { x: 20, y: 30, width: 200, height: 300 } as DOMRect;

describe("ProcessPanelSurface", () => {
  beforeEach(() => {
    useProcessPanelSurfaceStore.setState({ byEnvironmentId: {} });
  });

  it("retains host presentation across a same-environment slot handoff", () => {
    const firstOwner = Symbol("first");
    useProcessPanelSurfaceStore.getState().claim(input, firstOwner);
    useProcessPanelSurfaceStore.getState().present(environmentId, firstOwner, rect);
    useProcessPanelSurfaceStore.getState().release(environmentId, firstOwner);

    const replacementOwner = Symbol("replacement");
    useProcessPanelSurfaceStore.getState().claim({ ...input, projects: [] }, replacementOwner);

    expect(useProcessPanelSurfaceStore.getState().byEnvironmentId[environmentId]).toMatchObject({
      owner: replacementOwner,
      rect,
    });
  });

  it("releases query ownership when the process surface host is removed", () => {
    const owner = Symbol("owner");
    useProcessPanelSurfaceStore.getState().claim(input, owner);
    useProcessPanelSurfaceStore.getState().release(environmentId, owner);

    expect(useProcessPanelSurfaceStore.getState().byEnvironmentId[environmentId]?.owner).toBeNull();
  });
});
