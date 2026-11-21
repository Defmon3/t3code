import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadIssueKeysEqual, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { readThreadShell, useProjects, useServerConfigs } from "~/state/entities";
import { issueTrackerEnvironment } from "~/state/issueTrackers";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import type { EnvironmentId } from "@t3tools/contracts";

export function useIssueLinking(
  environmentId: EnvironmentId | undefined,
  readsStandalone: boolean,
) {
  const gt = useGT();
  const projects = useProjects();
  const configs = useServerConfigs();
  const capabilities =
    environmentId === undefined ? undefined : configs.get(environmentId)?.environment.capabilities;
  const trackers = useEnvironmentQuery(
    environmentId !== undefined && capabilities?.issues && readsStandalone
      ? issueTrackerEnvironment.connections({ environmentId, input: {} })
      : null,
  ).data;
  const detail = useAtomQueryRunner(issueEnvironment.detail, { reportFailure: false });
  const link = useAtomCommand(threadEnvironment.linkIssue, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: false });
  const target = (threadRef: ScopedThreadRef, url: string) =>
    environmentId !== threadRef.environmentId || capabilities?.issueLinkedThreads !== true
      ? null
      : resolveIssueLinkTarget({
          url,
          projects: projects.filter((project) => project.environmentId === environmentId),
          trackers: trackers ?? undefined,
          preferredProjectId: readThreadShell(threadRef)?.projectId,
        });

  const linkedIssueFor = (threadRef: ScopedThreadRef, url: string) => {
    const ref = target(threadRef, url)?.ref;
    if (ref === undefined) return null;
    const host = ref.host ?? new URL(url).host;
    return (
      readThreadShell(threadRef)?.issues?.find((issue) =>
        threadIssueKeysEqual(issue, { ...ref, host }),
      ) ?? null
    );
  };

  return {
    canLink: (threadRef: ScopedThreadRef, url: string) => target(threadRef, url) !== null,
    linkedIssueFor,
    changeLink: async (threadRef: ScopedThreadRef, url: string, linked: boolean) => {
      const ref = target(threadRef, url)?.ref;
      if (ref === undefined) throw new Error(gt("This issue is unavailable in this environment."));
      if (!linked) {
        const existing = linkedIssueFor(threadRef, url);
        if (existing === null) return;
        const { tracker, host, scope, key } = existing;
        const result = await unlink({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            tracker,
            host,
            scope,
            key,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return;
      }
      const issueResult = await detail({ environmentId: threadRef.environmentId, input: ref });
      if (issueResult._tag === "Failure") throw squashAtomCommandFailure(issueResult);
      const { tracker, host, scope, key, projectId, displayKey, title } = issueResult.value;
      const result = await link({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tracker,
          host,
          scope,
          key,
          projectId,
          displayKey,
          title,
          url: issueResult.value.url,
          source: "manual",
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  };
}
