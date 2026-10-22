import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentSupportsWorkItemLinking } from "./entities";

describe("readEnvironmentSupportsWorkItemLinking", () => {
  it.each([
    { capabilities: undefined, supported: false },
    { capabilities: {}, supported: false },
    { capabilities: { issues: false }, supported: false },
    { capabilities: { issues: true }, supported: true },
    { capabilities: { threadPullRequests: true }, supported: true },
    { capabilities: { threadPullRequestLinking: true }, supported: true },
    { capabilities: { issues: true, threadPullRequests: true }, supported: true },
  ])("reads issue or PR linking support: %j", ({ capabilities, supported }) => {
    const environmentId = EnvironmentId.make("work-item-linking-test");
    const config = capabilities === undefined ? undefined : { environment: { capabilities } };
    using _read = vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(new Map(config === undefined ? [] : [[environmentId, config]]));
    expect(readEnvironmentSupportsWorkItemLinking(environmentId)).toBe(supported);
  });
});
