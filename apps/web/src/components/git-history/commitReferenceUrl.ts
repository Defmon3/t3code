import type { RepositoryIdentity } from "@t3tools/contracts";

export function commitReferenceUrl(
  repository: RepositoryIdentity | null | undefined,
  subject: string,
  number: number,
): string | null {
  if (!repository?.webUrl || !Number.isSafeInteger(number) || number < 1) return null;
  const base = repository.webUrl.replace(/\/$/, "");
  const pullRequest = new RegExp(`\\b(?:pull request|merge request) #${number}\\b`, "i").test(
    subject,
  );
  switch (repository.provider) {
    case "github":
    case "forgejo":
      return `${base}/${pullRequest ? "pull" : "issues"}/${number}`;
    case "gitlab":
      return `${base}/-/${pullRequest ? "merge_requests" : "issues"}/${number}`;
    case "bitbucket":
      return `${base}/${pullRequest ? "pull-requests" : "issues"}/${number}`;
    case "azure-devops": {
      if (pullRequest) return `${base}/pullrequest/${number}`;
      const project = base.split("/_git/")[0];
      return project ? `${project}/_workitems/edit/${number}` : null;
    }
    default:
      return null;
  }
}
