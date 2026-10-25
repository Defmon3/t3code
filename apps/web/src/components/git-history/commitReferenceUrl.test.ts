import { describe, expect, it } from "vite-plus/test";
import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";
import { commitReferenceUrl } from "./commitReferenceUrl";

const repository: RepositoryIdentity = {
  canonicalKey: "git.example.test/group/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://git.example.test/group/repo.git",
  },
  provider: SourceControlProviderKind.make("gitlab"),
  webUrl: "https://git.example.test/group/repo",
};

describe("commit reference URLs", () => {
  it("uses the repository host and issues path for an ordinary numbered reference", () => {
    expect(commitReferenceUrl(repository, "Fix layout (#42)", 42)).toBe(
      "https://git.example.test/group/repo/-/issues/42",
    );
  });
  it("uses the pull request path only when the message identifies a pull request", () => {
    expect(commitReferenceUrl(repository, "Merge pull request #42", 42)).toBe(
      "https://git.example.test/group/repo/-/merge_requests/42",
    );
  });
  it("uses GitHub issue resolution without guessing whether a bare number is a pull request", () => {
    expect(
      commitReferenceUrl(
        { ...repository, provider: SourceControlProviderKind.make("github") },
        "Fix (#42)",
        42,
      ),
    ).toBe("https://git.example.test/group/repo/issues/42");
  });
  it("does not invent a URL for absent hosting metadata", () => {
    const { webUrl: _webUrl, ...unhostedRepository } = repository;
    expect(commitReferenceUrl(unhostedRepository, "Fix (#42)", 42)).toBeNull();
    expect(commitReferenceUrl(null, "Fix (#42)", 42)).toBeNull();
  });
});
