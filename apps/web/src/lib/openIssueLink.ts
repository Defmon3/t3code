import { sourceControlHostOf, type SourceControlProviderKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

export function findProjectForIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly host: string; readonly repository: string },
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    if (kind === "azure-devops") {
      const checkout = `${sourceControlClients.canonicalRepositoryKey(identity.canonicalKey.toLowerCase())}/`;
      const linkKey = `${link.host}/${link.repository}`.toLowerCase();
      return [
        sourceControlClients.canonicalRepositoryKey(linkKey),
        sourceControlClients
          .canonicalRepositoryKey(`${linkKey}/_git/_`)
          .slice(0, -"/_git/_".length),
      ].some((prefix) => checkout.startsWith(`${prefix}/`));
    }
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    if (repository === null || sourceControlHostOf(identity, kind) !== link.host.toLowerCase()) {
      return false;
    }
    return repository.toLowerCase() === link.repository.toLowerCase();
  });
}

export function repositoryForProjectLink(project: EnvironmentProject, fallback: string): string {
  return project.repositoryIdentity?.displayName ?? fallback;
}

export function linkedPullRequestTarget(
  project: EnvironmentProject,
  link: { readonly repository: string; readonly number: number; readonly url: string },
) {
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url)?.link;
  return {
    projectId: project.id,
    ...(parsed === undefined ? {} : { host: parsed.authority ?? parsed.host }),
    repository: repositoryForProjectLink(project, link.repository),
    number: link.number,
  };
}

export function findProjectForLink(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly repository: string; readonly number: number; readonly url: string },
): EnvironmentProject | undefined {
  let host: string;
  try {
    host = new URL(link.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return findProjectForIssue(projects, { host, repository: link.repository });
}

export function relatedIssueTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  current: { readonly projectId: string; readonly repository: string },
  relative: {
    readonly repository?: string | undefined;
    readonly number: number;
    readonly url: string;
  },
): { projectId: string; repository: string; number: number } | null {
  const repository = relative.repository;
  if (repository === undefined || repository.toLowerCase() === current.repository.toLowerCase()) {
    return {
      projectId: current.projectId,
      repository: current.repository,
      number: relative.number,
    };
  }
  const project = findProjectForLink(projects, { ...relative, repository });
  return project === undefined
    ? null
    : {
        projectId: project.id,
        repository: repositoryForProjectLink(project, repository),
        number: relative.number,
      };
}

/**
 * Hands a link to the system browser, which is where one this workspace cannot place belongs, and
 * says so when the desktop bridge is missing rather than swallowing the press.
 */
export function openLinkInBrowser(targetUrl: string): void {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  const protocol = URL.canParse(targetUrl) ? new URL(targetUrl).protocol : null;
  const opened =
    protocol === "https:" || protocol === "http:"
      ? api.shell.openExternal(targetUrl)
      : Promise.reject(new Error("Issue links must use HTTP or HTTPS."));
  void opened.catch((error) => {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open issue link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
