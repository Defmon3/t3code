import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { resolveLinkPullRequestInput } from "@t3tools/client-runtime/pull-request-link-input";
import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { expect, it } from "vite-plus/test";

const project = {
  id: ProjectId.make("project"),
  environmentId: EnvironmentId.make("environment"),
  repositoryIdentity: {
    provider: SourceControlProviderKind.make("github"),
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    host: "github.com",
    owner: "acme",
    name: "web",
  },
};

it.each([
  ["https://github.com/acme/web/issues/42", true],
  ["https://github.com/acme/web/issues/42#issuecomment-5", true],
  ["https://github.com/acme/web/pull/42", false],
  ["https://github.com.lookalike.test/acme/web/issues/42", false],
] as const)("routes %s to the issue tracker only if recognized", (url, issue) => {
  const found = resolveIssueLinkTarget({ url, projects: [project] });
  if (issue) {
    expect(found?.ref).toMatchObject({
      tracker: "github",
      scope: "acme/web",
      key: "42",
      projectId: project.id,
    });
  } else {
    expect(found).toBeNull();
  }
});

it("keeps a bare number scoped to the thread's change request host", () => {
  expect(
    resolveLinkPullRequestInput({
      reference: "#42",
      project: {
        host: "github.com",
        repository: "acme/web",
        terminology: sourceControlClients.get("github").changeRequest,
        webUrl: (number) => `https://github.com/acme/web/pull/${number}`,
      },
      hasProject: () => true,
    }),
  ).toMatchObject({ link: { host: "github.com", repository: "acme/web", number: 42 } });
});
