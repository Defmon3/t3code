import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { create } from "zustand";

import { ProcessPanel } from "./ProcessPanel";
import type { ProcessPanelProject, ProcessPanelThread } from "./ProcessPanel.logic";

export interface ProcessPanelInput {
  readonly environmentId: EnvironmentId;
  readonly environmentConnectionPhase: EnvironmentConnectionPhase;
  readonly projects: readonly ProcessPanelProject[];
  readonly threads: readonly ProcessPanelThread[];
}

interface ProcessPanelPresentation extends ProcessPanelInput {
  readonly owner: symbol | null;
  readonly rect: DOMRect | null;
  readonly visible: boolean;
}

interface ProcessPanelSurfaceState {
  readonly byEnvironmentId: Record<string, ProcessPanelPresentation>;
  readonly claim: (input: ProcessPanelInput, owner: symbol) => void;
  readonly update: (input: ProcessPanelInput, owner: symbol, visible: boolean) => void;
  readonly present: (environmentId: EnvironmentId, owner: symbol, rect: DOMRect) => void;
  readonly release: (environmentId: EnvironmentId, owner: symbol) => void;
}

export const useProcessPanelSurfaceStore = create<ProcessPanelSurfaceState>()((set) => ({
  byEnvironmentId: {},
  claim: (input, owner) =>
    set((state) => {
      const current = state.byEnvironmentId[input.environmentId];
      return {
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [input.environmentId]: {
            ...input,
            owner,
            rect: current?.rect ?? null,
            visible: false,
          },
        },
      };
    }),
  update: (input, owner, visible) =>
    set((state) => {
      const current = state.byEnvironmentId[input.environmentId];
      if (!current || current.owner !== owner) return state;
      if (
        current.environmentConnectionPhase === input.environmentConnectionPhase &&
        current.projects === input.projects &&
        current.threads === input.threads &&
        current.visible === visible
      ) {
        return state;
      }
      return {
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [input.environmentId]: { ...current, ...input, visible },
        },
      };
    }),
  present: (environmentId, owner, rect) =>
    set((state) => {
      const current = state.byEnvironmentId[environmentId];
      if (!current || current.owner !== owner) return state;
      return {
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: { ...current, rect },
        },
      };
    }),
  release: (environmentId, owner) =>
    set((state) => {
      const current = state.byEnvironmentId[environmentId];
      if (!current || current.owner !== owner) return state;
      return {
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: { ...current, owner: null, visible: false },
        },
      };
    }),
}));

export function ProcessPanelSurfaceSlot({
  input,
  visible,
}: {
  readonly input: ProcessPanelInput;
  readonly visible: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef(input);
  const visibleRef = useRef(visible);
  const ownerRef = useRef<symbol | null>(null);
  inputRef.current = input;
  visibleRef.current = visible;

  useLayoutEffect(() => {
    const owner = Symbol(`process-panel:${input.environmentId}`);
    ownerRef.current = owner;
    const element = elementRef.current;
    const present = () => {
      if (!element) return;
      const currentInput = inputRef.current;
      const store = useProcessPanelSurfaceStore.getState();
      store.update(currentInput, owner, visibleRef.current);
      store.present(currentInput.environmentId, owner, element.getBoundingClientRect());
    };

    useProcessPanelSurfaceStore.getState().claim(inputRef.current, owner);
    present();
    let observer: ResizeObserver | null = null;
    if (element) {
      observer = new ResizeObserver(present);
      observer.observe(element);
    }
    window.addEventListener("resize", present);
    window.addEventListener("scroll", present, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", present);
      window.removeEventListener("scroll", present, true);
      useProcessPanelSurfaceStore.getState().release(input.environmentId, owner);
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [input.environmentId]);

  useLayoutEffect(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    useProcessPanelSurfaceStore.getState().update(input, owner, visible);
  }, [input, visible]);

  return (
    <div
      ref={elementRef}
      className="flex min-h-0 flex-1"
      data-process-panel-slot={input.environmentId}
    />
  );
}

export function PersistentProcessPanelHosts({
  environmentIds,
}: {
  readonly environmentIds: readonly string[];
}) {
  const presentations = useProcessPanelSurfaceStore((state) => state.byEnvironmentId);
  return environmentIds.flatMap((environmentId) => {
    const presentation = presentations[environmentId];
    if (!presentation?.rect) return [];
    return [
      <div
        key={environmentId}
        className="fixed z-40 flex min-h-0"
        style={{
          display: presentation.visible ? undefined : "none",
          left: presentation.rect.x,
          top: presentation.rect.y,
          width: presentation.rect.width,
          height: presentation.rect.height,
        }}
      >
        <ProcessPanel {...presentation} />
      </div>,
    ];
  });
}
