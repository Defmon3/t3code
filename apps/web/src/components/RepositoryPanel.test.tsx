import { describe, expect, it } from "vite-plus/test";

import { repositoryViewFromKey } from "./RepositoryPanel";

describe("RepositoryPanel", () => {
  it("moves through repository views with the tablist keys", () => {
    expect(repositoryViewFromKey("history", "ArrowRight")).toBe("pull-requests");
    expect(repositoryViewFromKey("pull-requests", "ArrowLeft")).toBe("history");
    expect(repositoryViewFromKey("pull-requests", "Home")).toBe("history");
    expect(repositoryViewFromKey("history", "End")).toBe("pull-requests");
  });

  it("leaves unrelated keys to the browser", () => {
    expect(repositoryViewFromKey("history", "Enter")).toBeNull();
  });
});
