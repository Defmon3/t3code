import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import {
  type ScopedHookApprovalRequest,
  createHookApprovalEnvironmentAtoms,
  hasHookApprovalsCapability,
  scopeHookApprovalRequests,
  sortHookApprovalRequests,
} from "@t3tools/client-runtime/state/hook-approvals";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const hookApprovalEnvironment = createHookApprovalEnvironmentAtoms(connectionAtomRuntime);

export const pendingHookApprovalRequestsAtom = Atom.make(
  (get): ReadonlyArray<ScopedHookApprovalRequest> => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    const requests = [...catalog.entries.keys()].flatMap((environmentId) => {
      const connection = Option.getOrElse(
        AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (connection.phase !== "connected") return [];
      if (
        !hasHookApprovalsCapability(
          get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
        )
      )
        return [];
      const result = get(hookApprovalEnvironment.requests({ environmentId, input: {} }));
      const pending = Option.getOrElse(AsyncResult.value(result), () => []);
      return scopeHookApprovalRequests(environmentId, pending);
    });
    return sortHookApprovalRequests(requests);
  },
).pipe(Atom.withLabel("web-pending-hook-approvals"));
