import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createGitHubIssuesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:list",
      tag: WS_METHODS.githubIssuesList,
      staleTimeMs: 30_000,
    }),
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:github-issues:invalidate",
      tag: WS_METHODS.githubIssuesInvalidate,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}
