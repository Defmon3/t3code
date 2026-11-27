import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { resolveLinkPullRequestInput } from "@t3tools/client-runtime/pull-request-link-input";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
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

const linearTracker = IssueTrackerKind.make("linear");
const linearProjects = {
  a: { ...project, id: ProjectId.make("a"), repositoryIdentity: null },
  b: { ...project, id: ProjectId.make("b"), repositoryIdentity: null },
  c: { ...project, id: ProjectId.make("c"), repositoryIdentity: null },
};
const linearConnections = {
  trackers: [
    {
      tracker: linearTracker,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
      connected: true,
      account: "member",
      detail: null,
      workspace: "workspace-b",
      scopes: [],
    },
  ],
  bindings: {
    [linearProjects.a.id]: { tracker: linearTracker, scope: "ENG" },
    [linearProjects.b.id]: { tracker: linearTracker, scope: "eng" },
    [linearProjects.c.id]: { tracker: linearTracker, scope: "OPS" },
  },
} satisfies IssueTrackerConnectionList;

it.each([
  [["a", "b"], "b", "b"],
  [["b", "a"], "b", "b"],
  [["a", "b"], "a", "a"],
  [["b", "a"], "a", "a"],
  [["a", "b", "c"], "c", "a"],
  [["b", "a", "c"], "c", "b"],
] as const)(
  "routes Linear projects %j from thread project %s through %s",
  (ids, current, expected) => {
    const target = resolveIssueLinkTarget({
      url: "https://linear.app/workspace-b/issue/ENG-5/title",
      projects: ids.map((id) => linearProjects[id]),
      preferredProjectId: linearProjects[current].id,
      trackers: linearConnections,
    });
    expect(target?.ref.projectId).toBe(linearProjects[expected].id);
  },
);
