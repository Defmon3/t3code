import { formatIssueReference, type IssueListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerPathMenuItems,
  composerSuggestionOptionId,
  isComposerPathMenuLoading,
  serializeComposerIssueMention,
} from "./ComposerCommandMenu";

const issue = {
  provider: "github",
  referenceStyle: "hash",
  host: "github.com",
  projectId: "project-1" as IssueListEntry["projectId"],
  projectTitle: "Acme",
  repository: "acme/app",
  number: 12,
  title: "Fix session refresh",
  url: "https://github.com/acme/app/issues/12",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-20T10:00:00Z",
  updatedAt: "2026-08-20T11:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
} satisfies IssueListEntry;

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("composer issue suggestions", () => {
  it.each([
    { entry: issue, expected: "acme/app#12" },
    {
      entry: { ...issue, provider: "linear", referenceStyle: "key-number", repository: "ENG" },
      expected: "ENG-12",
    },
    {
      entry: {
        ...issue,
        provider: "another-tracker",
        referenceStyle: "key-number",
        repository: "APP",
      },
      expected: "APP-12",
    },
  ] as const)("formats host-native issue reference $expected", ({ entry, expected }) => {
    expect(formatIssueReference(entry)).toBe(expected);
  });

  it("serializes an issue mention with its exact URL", () => {
    expect(serializeComposerIssueMention(issue)).toBe(
      "[@acme/app#12](https://github.com/acme/app/issues/12) ",
    );
  });

  it("waits on issues and files only once the path query has text", () => {
    expect(isComposerPathMenuLoading({ query: "", issuesPending: true, filesPending: true })).toBe(
      false,
    );
    expect(
      isComposerPathMenuLoading({ query: "src", issuesPending: true, filesPending: false }),
    ).toBe(true);
    expect(
      isComposerPathMenuLoading({ query: "src", issuesPending: false, filesPending: true }),
    ).toBe(true);
  });

  it("keeps file results first while a new issue query is settling", () => {
    const pathItem = {
      id: "path:file:src/app.ts",
      type: "path" as const,
      path: "src/app.ts",
      pathKind: "file" as const,
      searchTarget: { environmentId: null, cwd: "/work", query: "src" },
      label: "app.ts",
      description: "src",
    };

    expect(
      buildComposerPathMenuItems({
        issues: [issue],
        pathItems: [pathItem],
        query: "src",
        settledIssueQuery: "",
      }),
    ).toEqual([pathItem]);
  });

  it("keeps issue hosts in result identity when the query is settled", () => {
    const items = buildComposerPathMenuItems({
      issues: [issue, { ...issue, host: "github.acme.test" }],
      pathItems: [],
      query: "session",
      settledIssueQuery: "session",
    });

    expect(items.map((item) => item.id)).toEqual([
      "issue:github:github.com:project-1:acme/app:12",
      "issue:github:github.acme.test:project-1:acme/app:12",
    ]);
  });
});
