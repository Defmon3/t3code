import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo } from "react";

import { ProjectFavicon } from "./ProjectFavicon";
import {
  deriveProcessPanelGroups,
  formatTestCommand,
  processPanelStatus,
  type ProcessPanelProject,
  type ProcessPanelThread,
} from "./ProcessPanel.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { formatDuration } from "~/session-logic";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function CopyWorkingDirectoryButton({ cwd }: { readonly cwd: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "working directory" });
  const label = isCopied ? "Copied working directory" : "Copy working directory";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="opacity-60 hover:opacity-100 focus-visible:opacity-100"
            onClick={() => copyToClipboard(cwd)}
            size="icon-micro"
            title={label}
            type="button"
            variant="ghost-muted"
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ProcessPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentConnectionPhase: EnvironmentConnectionPhase;
  readonly projects: readonly ProcessPanelProject[];
  readonly threads: readonly ProcessPanelThread[];
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.processDiscovery({
      environmentId: input.environmentId,
      input: { scope: "registered-project-tests" },
    }),
  );
  const groups = useMemo(
    () =>
      deriveProcessPanelGroups({
        processes: query.data?.processes ?? [],
        projects: input.projects,
        threads: input.threads,
        worktrees: query.data?.registeredProjectWorktrees ?? [],
      }),
    [input.projects, input.threads, query.data?.processes, query.data?.registeredProjectWorktrees],
  );
  const status = processPanelStatus({
    environmentConnectionPhase: input.environmentConnectionPhase,
    hasData: query.data !== null && query.data !== undefined,
    hasQueryError: query.error !== null && query.error !== undefined,
    hasDataError: query.data ? Option.isSome(query.data.error) : false,
  });
  const diagnosticsError = query.data ? Option.getOrNull(query.data.error) : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto" aria-label="Running tests">
      <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="font-medium text-sm">Running tests</h2>
        <div className="flex items-center gap-2">
          {query.data ? (
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
              CPU {query.data.hostCpuPercent.toFixed(1)}% · RAM{" "}
              {formatBytes(query.data.hostMemoryUsedBytes)}/
              {formatBytes(query.data.hostMemoryTotalBytes)}
            </span>
          ) : null}
          <span
            className={
              status.tone === "live"
                ? "flex items-center gap-1 text-[11px] text-muted-foreground"
                : status.tone === "error"
                  ? "flex items-center gap-1 text-[11px] text-destructive"
                  : "flex items-center gap-1 text-[11px] text-muted-foreground"
            }
          >
            <span
              className={
                status.tone === "live"
                  ? "size-1.5 rounded-full bg-emerald-500"
                  : status.tone === "error"
                    ? "size-1.5 rounded-full bg-destructive"
                    : "size-1.5 rounded-full bg-muted-foreground/60"
              }
              aria-hidden
            />
            {status.label}
          </span>
        </div>
      </header>
      {query.error || diagnosticsError ? (
        <p className="px-3 py-2 text-destructive text-xs">
          {query.error ?? diagnosticsError?.message ?? "Tests unavailable."}
        </p>
      ) : query.isPending && !query.data ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">Loading tests…</p>
      ) : groups.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">No tests detected.</p>
      ) : (
        <div className="py-1">
          {groups.map((group) => (
            <div key={`${group.project.id}:${group.cwd}`}>
              <div className="flex min-h-7 items-center gap-2 px-3 py-1 text-sm">
                <ProjectFavicon
                  environmentId={input.environmentId}
                  cwd={group.project.workspaceRoot}
                  faviconPath={group.project.faviconPath}
                />
                <span className="min-w-0 truncate font-medium">{group.project.title}</span>
                <span className="min-w-0 break-all font-mono text-muted-foreground text-xs">
                  {group.cwd}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
                  CPU {group.cpuPercent.toFixed(1)}% · {formatDuration(group.cpuTimeMs)} CPU
                </span>
                <CopyWorkingDirectoryButton cwd={group.cwd} />
              </div>
              <div className="border-border/60 border-t">
                {group.processes.map((process, index) => {
                  const test = formatTestCommand(process.command, process.argv);
                  if (!test) return null;
                  return (
                    <div
                      key={process.pid}
                      className="flex min-h-9 gap-1.5 px-3 py-1.5 pl-6 text-xs"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground" aria-hidden>
                        {index === group.processes.length - 1 ? "└─" : "├─"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 font-medium text-foreground">{test.label}</span>
                          {test.args.length > 0 ? (
                            <span className="min-w-0 text-muted-foreground">
                              {test.args.join(" ")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-muted-foreground">
                          {process.cpuPercent.toFixed(1)}% CPU · {formatBytes(process.rssBytes)} RSS
                          · CPU time {formatDuration(process.cpuTimeMs)} · Running {process.elapsed}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
