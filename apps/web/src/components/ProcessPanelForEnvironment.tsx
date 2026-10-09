import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironment } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { ProcessPanel } from "./ProcessPanel";

export function ProcessPanelForEnvironment({
  environmentId,
  active = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly active?: boolean;
}) {
  return active ? <ActiveProcessPanel environmentId={environmentId} /> : null;
}

function ActiveProcessPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const threads = useMemo(
    () => allThreads.filter((thread) => thread.environmentId === environmentId),
    [allThreads, environmentId],
  );
  if (!environment) {
    return <p role="alert">The process environment is unavailable.</p>;
  }
  return (
    <ProcessPanel
      environmentId={environmentId}
      environmentConnectionPhase={environment.connection.phase}
      projects={projects}
      threads={threads}
    />
  );
}
