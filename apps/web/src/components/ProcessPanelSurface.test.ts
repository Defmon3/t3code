import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { ProcessPanelInput } from "./ProcessPanelSurface";
import { useProcessPanelSurfaceStore } from "./ProcessPanelSurface";

const environmentId = "environment-1" as EnvironmentId;
const input: ProcessPanelInput = {
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

  it("does not notify equivalent slot updates while publishing changed presentations", () => {
    const owner = Symbol("owner");
    const store = useProcessPanelSurfaceStore;
    store.getState().claim(input, owner);

    const presentations: unknown[] = [];
    const unsubscribe = store.subscribe((state) => presentations.push(state.byEnvironmentId));

    store.getState().update({ ...input }, owner, false);

    expect(presentations).toEqual([]);

    const projects = [{ id: "project-1", title: "Project", workspaceRoot: "C:/project" }];
    const threads = [{ projectId: "project-1", worktreePath: "C:/project/worktree" }];
    store.getState().update(
      {
        ...input,
        environmentConnectionPhase: "connecting",
        projects,
        threads,
      },
      owner,
      true,
    );

    expect(presentations).toHaveLength(1);
    expect(store.getState().byEnvironmentId[environmentId]).toMatchObject({
      environmentConnectionPhase: "connecting",
      projects,
      threads,
      visible: true,
    });

    unsubscribe();
  });
});
