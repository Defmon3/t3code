import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  clearAllHookProviderSessions,
  clearHookProviderSession,
  readHookProviderSession,
  setHookProviderSession,
  withHookProviderSessionEnvironment,
} from "./HookProviderSession.ts";

describe("HookProviderSession", () => {
  it("returns hook credentials only for the matching thread", () => {
    const firstThread = ThreadId.make("hook-provider-first");
    const secondThread = ThreadId.make("hook-provider-second");
    clearAllHookProviderSessions();

    setHookProviderSession({
      threadId: firstThread,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "first-session",
      endpoint: "http://127.0.0.1:4312/hook-approvals",
      token: "first-token",
    });

    assert.deepEqual(withHookProviderSessionEnvironment({}, firstThread), {
      T3_HOOK_APPROVAL_URL: "http://127.0.0.1:4312/hook-approvals",
      T3_HOOK_APPROVAL_TOKEN: "first-token",
    });

    clearHookProviderSession(firstThread);
    assert.equal(readHookProviderSession(firstThread), undefined);
    assert.deepEqual(
      withHookProviderSessionEnvironment(
        { T3_HOOK_APPROVAL_URL: "inherited-url", T3_HOOK_APPROVAL_TOKEN: "inherited-token" },
        secondThread,
      ),
      { T3_HOOK_APPROVAL_URL: undefined, T3_HOOK_APPROVAL_TOKEN: undefined },
    );
  });
});
