import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ProjectFavicon } from "./ProjectFavicon";
import {
  deriveProcessPanelGroups,
  formatTestCommand,
  processPanelNotice,
  processPanelStatus,
  type ProcessPanelEntry,
  type ProcessPanelProject,
  type ProcessPanelThread,
} from "./ProcessPanel.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureLocalApi } from "~/localApi";
import { formatDuration } from "~/session-logic";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { toastManager } from "./ui/toast";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function CopyValueButton({ target, value }: { readonly target: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target });
  const label = isCopied ? `Copied ${target}` : `Copy ${target}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="opacity-60 hover:opacity-100 focus-visible:opacity-100"
            onClick={() => copyToClipboard(value)}
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
  readonly onBack?: (() => void) | undefined;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.processDiscovery({
      environmentId: input.environmentId,
      input: { scope: "registered-project-tests" },
    }),
  );
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingProcessKeys, setSignalingProcessKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const signalingProcessKeysRef = useRef<ReadonlySet<string>>(new Set());
  const refresh = query.refresh;
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
    hasStaleData: query.data?.stale === true,
  });
  const diagnosticsError = query.data ? Option.getOrNull(query.data.error) : null;
  const notice = processPanelNotice({
    queryError: query.error,
    diagnosticsError: diagnosticsError?.message ?? null,
    hasStaleData: query.data?.stale === true,
  });
  const killProcess = useCallback(
    async (process: ProcessPanelEntry) => {
      const processKey = `${process.pid}:${process.startTimeMs}`;
      if (signalingProcessKeysRef.current.has(processKey)) return;

      const nextSignalingKeys = new Set(signalingProcessKeysRef.current).add(processKey);
      signalingProcessKeysRef.current = nextSignalingKeys;
      setSignalingProcessKeys(nextSignalingKeys);
      const clearSignaling = () => {
        const next = new Set(signalingProcessKeysRef.current);
        next.delete(processKey);
        signalingProcessKeysRef.current = next;
        setSignalingProcessKeys(next);
      };

      try {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          `Kill test process ${process.pid}? This cannot be handled by the process.`,
          { variant: "destructive" },
        );
        if (!confirmed) return;

        const result = await signalServerProcess({
          environmentId: input.environmentId,
          input: { pid: process.pid, startTimeMs: process.startTimeMs, signal: "SIGKILL" },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not kill test process",
            description:
              error instanceof Error ? error.message : "Failed to kill the test process.",
          });
          return;
        }
        if (!result.value.signaled) {
          toastManager.add({
            type: "error",
            title: "Could not kill test process",
            description: Option.getOrElse(
              result.value.message,
              () => "The test process may have already exited.",
            ),
          });
          refresh();
          return;
        }
        refresh();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not kill test process",
          description: error instanceof Error ? error.message : "Failed to kill the test process.",
        });
      } finally {
        clearSignaling();
      }
    },
    [input.environmentId, refresh, signalServerProcess],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto" aria-label="Running tests">
      <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          {input.onBack ? (
            <Button onClick={input.onBack} size="xs" type="button" variant="ghost">
              Back to pull requests
            </Button>
          ) : null}
          <h2 className="font-medium text-sm">Running tests</h2>
        </div>
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
                  : status.tone === "warning"
                    ? "flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
                    : "flex items-center gap-1 text-[11px] text-muted-foreground"
            }
          >
            <span
              className={
                status.tone === "live"
                  ? "size-1.5 rounded-full bg-emerald-500"
                  : status.tone === "error"
                    ? "size-1.5 rounded-full bg-destructive"
                    : status.tone === "warning"
                      ? "size-1.5 rounded-full bg-amber-500"
                      : "size-1.5 rounded-full bg-muted-foreground/60"
              }
              aria-hidden
            />
            {status.label}
          </span>
        </div>
      </header>
      {notice ? (
        <p
          className={
            notice.tone === "warning"
              ? "px-3 py-2 text-amber-700 text-xs dark:text-amber-300"
              : "px-3 py-2 text-destructive text-xs"
          }
          role={notice.tone === "warning" ? "status" : undefined}
        >
          {notice.message}
        </p>
      ) : null}
      {notice?.tone === "error" ? null : query.isPending && !query.data ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">Loading tests…</p>
      ) : groups.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">No tests detected.</p>
      ) : (
        <div className="py-1">
          {groups.map((group) => (
            <div key={`${group.project.id}:${group.cwd}`}>
              <div className="flex min-h-7 items-center gap-2 px-3 py-1 text-sm">
                <ProjectFavicon
                  project={{ ...group.project, environmentId: input.environmentId }}
                />
                <span className="min-w-0 truncate font-medium">{group.project.title}</span>
                <span className="min-w-0 break-all font-mono text-muted-foreground text-xs">
                  {group.cwd}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
                  CPU {group.cpuPercent.toFixed(1)}% · {formatDuration(group.cpuTimeMs)} CPU
                </span>
                <CopyValueButton target="working directory" value={group.cwd} />
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
                          <span className="shrink-0 font-mono text-muted-foreground">
                            PID {process.pid}
                          </span>
                          {test.args.length > 0 ? (
                            <span className="min-w-0 text-muted-foreground">
                              {test.args.join(" ")}
                            </span>
                          ) : null}
                          <CopyValueButton
                            target={`PID ${process.pid}`}
                            value={String(process.pid)}
                          />
                          <Button
                            aria-label={`Kill test process ${process.pid}`}
                            disabled={signalingProcessKeys.has(
                              `${process.pid}:${process.startTimeMs}`,
                            )}
                            onClick={() => void killProcess(process)}
                            size="micro"
                            type="button"
                            variant="destructive-outline"
                          >
                            {signalingProcessKeys.has(`${process.pid}:${process.startTimeMs}`)
                              ? "Killing…"
                              : "Kill"}
                          </Button>
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
