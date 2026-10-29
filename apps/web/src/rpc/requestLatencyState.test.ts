import { WS_METHODS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  subscribeSlowRpcAckRequests,
  trackRpcRequestSent,
  type SlowRpcAckRequest,
} from "./requestLatencyState";

it("keeps model explanation waits local while warning about other slow requests", () => {
  vi.useFakeTimers();
  const notifications: ReadonlyArray<SlowRpcAckRequest>[] = [];
  const unsubscribe = subscribeSlowRpcAckRequests((requests) => notifications.push(requests));
  try {
    trackRpcRequestSent("explanation", WS_METHODS.approvalsExplain);
    trackRpcRequestSent("refresh", WS_METHODS.vcsRefreshStatus);

    vi.advanceTimersByTime(120_000);

    expect(notifications.at(-1)?.map((request) => request.requestId)).toEqual(["refresh"]);
  } finally {
    acknowledgeRpcRequest("explanation");
    acknowledgeRpcRequest("refresh");
    unsubscribe();
    vi.useRealTimers();
  }
});
