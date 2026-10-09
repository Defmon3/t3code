import type { VcsHistoryRef } from "@t3tools/contracts";

export type GitHistorySyncAction = "fetch" | "pull" | "push";

export interface GitHistorySyncActionState {
  readonly action: GitHistorySyncAction;
  readonly disabled: boolean;
  readonly tooltip: string;
  readonly count: number;
}

export function resolveGitHistorySyncActions(
  selectedRef: VcsHistoryRef | null,
): ReadonlyArray<GitHistorySyncActionState> {
  if (selectedRef === null) {
    return (["fetch", "pull", "push"] as const).map((action) => ({
      action,
      disabled: true,
      tooltip: "Select a branch to sync.",
      count: 0,
    }));
  }

  const isLocalBranch = !selectedRef.isRemote && !selectedRef.isTag;
  const hasUpstream = selectedRef.upstreamName !== undefined;
  const aheadCount = selectedRef.aheadCount ?? 0;
  const behindCount = selectedRef.behindCount ?? 0;
  const unavailable = (
    action: GitHistorySyncAction,
    tooltip: string,
  ): GitHistorySyncActionState => ({
    action,
    disabled: true,
    tooltip,
    count: 0,
  });

  const fetch = selectedRef.isTag
    ? unavailable("fetch", "Select a branch or remote ref to fetch.")
    : isLocalBranch && !hasUpstream
      ? unavailable("fetch", "The selected branch has no upstream remote.")
      : { action: "fetch" as const, disabled: false, tooltip: "Fetch selected remote.", count: 0 };
  if (!isLocalBranch) {
    return [
      fetch,
      unavailable("pull", "Pull is available only for local branches with an upstream."),
      unavailable("push", "Push is available only for local branches with an upstream."),
    ];
  }
  if (!hasUpstream) {
    return [
      fetch,
      unavailable("pull", "The selected branch has no upstream configured."),
      unavailable("push", "Publish is not available for branches without an upstream."),
    ];
  }
  return [
    fetch,
    behindCount > 0
      ? {
          action: "pull",
          disabled: false,
          tooltip: "Fast-forward selected branch.",
          count: behindCount,
        }
      : unavailable("pull", "The selected branch is up to date."),
    aheadCount > 0
      ? { action: "push", disabled: false, tooltip: "Push selected branch.", count: aheadCount }
      : unavailable("push", "No commits to push."),
  ];
}

export function selectedHistoryRef(
  selectedRevision: { readonly revision: string } | null | undefined,
  refs: ReadonlyArray<VcsHistoryRef>,
): VcsHistoryRef | null {
  if (selectedRevision === null || selectedRevision === undefined) return null;
  const prefix = selectedRevision.revision.startsWith("refs/heads/")
    ? "refs/heads/"
    : selectedRevision.revision.startsWith("refs/remotes/")
      ? "refs/remotes/"
      : "refs/tags/";
  return refs.find((ref) => `${prefix}${ref.name}` === selectedRevision.revision) ?? null;
}

export function isGitHistorySolveOffer(error: string): boolean {
  return /diverg|not possible to fast-forward|non-fast-forward|fetch first/i.test(error);
}

export function gitHistorySolvePrompt(input: {
  readonly cwd: string;
  readonly action: "pull" | "push";
  readonly refName: string;
  readonly upstreamName: string;
  readonly error: string;
}): string {
  return `Resolve the Git ${input.action} failure.\n\ncwd: ${input.cwd}\nbranch: ${input.refName}\nupstream: ${input.upstreamName}\naction: ${input.action}\nerror: ${input.error.replace(/[\r\n]+/g, " ").trim()}`;
}
