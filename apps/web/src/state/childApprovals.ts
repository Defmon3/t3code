import { createChildApprovalAtoms } from "@t3tools/client-runtime/state/hook-approvals";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { pendingHookApprovalRequestsAtom } from "./hookApprovals";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const childApprovals = createChildApprovalAtoms(connectionAtomRuntime, {
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  hookRequestsAtom: pendingHookApprovalRequestsAtom,
  capabilitiesAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
    ),
  ),
  connectedAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))))
          ?.phase === "connected",
    ),
  ),
});
