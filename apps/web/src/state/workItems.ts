import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const workItemLinks = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "work-items:links",
    tag: WS_METHODS.workItemsListLinks,
    staleTimeMs: 30_000,
  }),
  link: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "work-items:link",
    tag: WS_METHODS.workItemsLink,
  }),
  unlink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "work-items:unlink",
    tag: WS_METHODS.workItemsUnlink,
  }),
  findMatches: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "work-items:find-matches",
    tag: WS_METHODS.workItemsFindMatches,
  }),
};
