import { useAtomValue } from "@effect/atom-react";
import { isStandaloneIssueLink } from "@t3tools/client-runtime/issue-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  normalizeWorkItemLinkKey,
  type EnvironmentId,
  type ScopedThreadRef,
  type WorkItemLink,
  type WorkItemLinkInput,
  type WorkItemLinkKey,
  type WorkItemMatch,
  type WorkItemMatchRelationship,
  type WorkItemTaskSourceRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useOpenIssueLink } from "~/lib/openIssueLink";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import { issueTrackerEnvironment } from "~/state/issueTrackers";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { workItemLinks } from "~/state/workItems";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Item = WorkItemLinkKey & { readonly title: string; readonly displayKey: string };

interface Props {
  readonly environmentId: EnvironmentId;
  readonly panelRef?: ScopedThreadRef | undefined;
  readonly item: WorkItemLinkKey;
  readonly source: WorkItemTaskSourceRef;
  readonly reported?: ReadonlyArray<Item> | undefined;
}

export function WorkItemRelations(props: Props) {
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.workItemLinks === true;
  if (!supported && !props.reported?.length) return null;
  return (
    <Relations key={`${props.environmentId}:${props.item.url}`} {...props} supported={supported} />
  );
}

function Relations({
  environmentId,
  panelRef,
  item,
  source,
  reported = [],
  supported,
}: Props & {
  readonly supported: boolean;
}) {
  const gt = useGT();
  const sourceKey = normalizeWorkItemLinkKey({ provider: item.provider, url: item.url });
  const saved = useEnvironmentQuery(
    supported ? workItemLinks.list({ environmentId, input: { source: sourceKey } }) : null,
  );
  const canLink = useAtomValue(workItemLinks.link.permissionAtom(environmentId));
  const canUnlink = useAtomValue(workItemLinks.unlink.permissionAtom(environmentId));
  const canFind = useAtomValue(workItemLinks.findMatches.permissionAtom(environmentId));
  const link = useAtomCommand(workItemLinks.link, { reportFailure: false });
  const unlink = useAtomCommand(workItemLinks.unlink, { reportFailure: false });
  const find = useAtomCommand(workItemLinks.findMatches, { reportFailure: false });
  const openIssue = useOpenIssueLink(undefined, panelRef);
  const openPullRequest = useOpenChangeRequestLink(undefined, panelRef);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<{
    readonly relationship: WorkItemMatchRelationship;
    readonly matches: ReadonlyArray<WorkItemMatch>;
  } | null>(null);
  const readsStandalone =
    reported.some(({ url }) => isStandaloneIssueLink(url)) ||
    saved.data?.links.some(({ issue }) => isStandaloneIssueLink(issue.url)) ||
    search?.matches.some(({ url }) => isStandaloneIssueLink(url));
  const trackers = useEnvironmentQuery(
    readsStandalone ? issueTrackerEnvironment.connections({ environmentId, input: {} }) : null,
  ).data;

  const issueSource = source.kind === "issue";
  const opposite = (pair: WorkItemLink): Item =>
    issueSource ? { ...pair.pullRequest, displayKey: `#${pair.pullRequest.number}` } : pair.issue;
  const refresh = (pair: WorkItemLink) => {
    for (const { provider, url } of [pair.issue, pair.pullRequest]) {
      appAtomRegistry.refresh(
        workItemLinks.list({ environmentId, input: { source: { provider, url } } }),
      );
    }
  };
  const save = async (input: WorkItemLinkInput) => {
    setPending(true);
    setError(null);
    const result = await link({ environmentId, input });
    setPending(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    refresh(result.value);
    setSearch((current) =>
      current === null
        ? null
        : {
            ...current,
            matches: current.matches.filter(
              (match) => normalizeWorkItemLinkKey(match).url !== opposite(result.value).url,
            ),
          },
    );
    setDraft(null);
  };
  const remove = async (pair: WorkItemLink) => {
    setPending(true);
    setError(null);
    const result = await unlink({
      environmentId,
      input: {
        issue: { provider: pair.issue.provider, url: pair.issue.url },
        pullRequest: { provider: pair.pullRequest.provider, url: pair.pullRequest.url },
      },
    });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else refresh(pair);
  };
  const suggest = async (relationship: WorkItemMatchRelationship) => {
    setPending(true);
    setError(null);
    const result = await find({ environmentId, input: { source, relationship } });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setSearch({ relationship, matches: result.value.matches });
  };
  const saveUrl = (url: string) => {
    if (source.kind === "pull-request") {
      void save({
        issue: { projectId: source.reference.projectId, url },
        pullRequest: source.reference,
      });
      return;
    }
    const parsed = sourceControlClients.parseChangeRequestUrl(url);
    if (parsed === null) {
      setError(gt("Enter a valid pull request URL."));
      return;
    }
    const { host, repository, number } = parsed.link;
    void save({
      issue: source.reference,
      pullRequest: { projectId: source.reference.projectId, host, repository, number },
    });
  };
  const openItem = (entry: Item, kind: WorkItemTaskSourceRef["kind"]) => (
    <a
      href={entry.url}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 text-sm hover:underline"
      onClick={(event) => {
        if (kind === "issue") openIssue(event, entry.url, environmentId, trackers ?? undefined);
        else openPullRequest(event, entry.url, undefined, environmentId);
      }}
    >
      {entry.displayKey} {entry.title}
    </a>
  );
  const displayed = new Set<string>();
  const rows = (saved.data?.links ?? []).map((pair) => {
    const target = opposite(pair);
    displayed.add(target.url);
    return (
      <div key={target.url} className="flex items-center justify-between gap-2">
        {openItem(target, issueSource ? "pull-request" : "issue")}
        {canUnlink ? (
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => void remove(pair)}>
            {gt("Unlink")}
          </Button>
        ) : null}
      </div>
    );
  });

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">
        {issueSource ? gt("Saved pull requests") : gt("Related issues")}
      </h3>
      {rows}
      {reported
        .filter((entry) => !displayed.has(normalizeWorkItemLinkKey(entry).url))
        .map((entry) => (
          <div key={entry.url}>{openItem(entry, "issue")}</div>
        ))}
      {saved.data?.truncated ? (
        <p className="text-xs text-muted-foreground">{gt("More saved links are available.")}</p>
      ) : null}
      {saved.error !== null ? (
        <Button size="xs" variant="ghost" onClick={saved.refresh}>
          {gt("Retry loading saved links")}
        </Button>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {supported ? (
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" disabled={saved.isPending} onClick={saved.refresh}>
            {gt("Refresh")}
          </Button>
          {canLink ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => setDraft("")}>
              {issueSource ? gt("Link pull request") : gt("Link issue")}
            </Button>
          ) : null}
          {canFind ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => void suggest("related")}
              >
                {gt("Find related items")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => void suggest("duplicate")}
              >
                {gt("Find possible duplicates")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {draft !== null ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canLink && !pending && draft.trim()) saveUrl(draft.trim());
          }}
        >
          <Input
            type="url"
            required
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={issueSource ? gt("Pull request URL") : gt("Issue URL")}
          />
          <Button type="submit" size="xs" disabled={pending || !canLink}>
            {gt("Save link")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => setDraft(null)}
          >
            {gt("Cancel")}
          </Button>
        </form>
      ) : null}
      {search?.matches.length === 0 ? (
        <p className="text-xs text-muted-foreground">{gt("No likely matches found.")}</p>
      ) : null}
      {search?.matches.map((match) => (
        <div key={match.url} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {openItem(match, match.source.kind)}
            <p className="text-xs text-muted-foreground">
              {match.confidence === "high" ? gt("High confidence") : gt("Medium confidence")} ·{" "}
              {match.reason}
            </p>
          </div>
          {canLink && search.relationship === "related" ? (
            <Button size="xs" variant="ghost" disabled={pending} onClick={() => saveUrl(match.url)}>
              {gt("Save link")}
            </Button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
