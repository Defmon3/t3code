import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  RpcScopeAuthorization,
  WS_METHODS,
  WsCoreRpcGroup,
  WsIssueRpcGroup,
  WsRpcGroup,
} from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("keeps every method authorized when combining core and issue handlers", () => {
    const coreMethods = [...WsCoreRpcGroup.requests.keys()];
    const issueMethods = [...WsIssueRpcGroup.requests.keys()];
    const methods = [...WsRpcGroup.requests.keys()];
    const obsoleteProjectMethods: ReadonlySet<string> = new Set([
      WS_METHODS.projectsAdd,
      WS_METHODS.projectsList,
      WS_METHODS.projectsRemove,
    ]);
    const expectedMethods = [
      ...Object.values(WS_METHODS).filter((method) => !obsoleteProjectMethods.has(method)),
      ...Object.values(ORCHESTRATION_V2_WS_METHODS),
    ];

    expect(new Set([...coreMethods, ...issueMethods]).size).toBe(
      coreMethods.length + issueMethods.length,
    );
    expect(methods.toSorted()).toEqual(expectedMethods.toSorted());
    expect(
      [...WsRpcGroup.requests.values()].every((rpc) => rpc.middlewares.has(RpcScopeAuthorization)),
    ).toBe(true);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
