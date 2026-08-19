import type {
  PreviewAutomationObservationEvent,
  PreviewAutomationObservationRead,
} from "@t3tools/contracts";

export const PREVIEW_OBSERVATION_BUFFER_LIMIT = 500;
const MAX_OBSERVATION_TEXT_LENGTH = 8_000;
const MAX_OBSERVATION_URL_LENGTH = 4_096;

interface ObservedRequest {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly startedAt: string;
  readonly monotonicStartedAt: number | null;
  readonly resourceType?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly protocol?: string;
  readonly encodedDataLength?: number;
  readonly durationMs?: number;
  readonly failed?: boolean;
  readonly errorText?: string;
}

export interface PreviewObservationState {
  readonly startedAt: string;
  readonly nextCursor: number;
  readonly readCursor: number;
  readonly events: ReadonlyArray<PreviewAutomationObservationEvent>;
  readonly requests: ReadonlyMap<string, ObservedRequest>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const bounded = (value: unknown, maximum = MAX_OBSERVATION_TEXT_LENGTH): string =>
  String(value ?? "").slice(0, maximum);

const sensitiveQueryKey =
  /(?:token|secret|password|passwd|authorization|auth|api[-_]?key|signature|sig|credential|session|code|x-amz-.+)/i;

export const sanitizeObservedUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    for (const key of url.searchParams.keys()) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString().slice(0, MAX_OBSERVATION_URL_LENGTH);
  } catch {
    return (value.split("#", 1)[0] ?? value).slice(0, MAX_OBSERVATION_URL_LENGTH);
  }
};

const sanitizeInitiator = (value: unknown): unknown => {
  const initiator = record(value);
  const stack = record(initiator["stack"]);
  const callFrames = Array.isArray(stack["callFrames"])
    ? stack["callFrames"].slice(0, 20).map((item) => {
        const frame = record(item);
        return {
          functionName: bounded(frame["functionName"], 512),
          url: sanitizeObservedUrl(String(frame["url"] ?? "")),
          lineNumber: Number(frame["lineNumber"] ?? 0),
          columnNumber: Number(frame["columnNumber"] ?? 0),
        };
      })
    : [];
  return {
    type: bounded(initiator["type"] ?? "other", 64),
    ...(initiator["url"] ? { url: sanitizeObservedUrl(String(initiator["url"])) } : {}),
    ...(callFrames.length > 0 ? { stack: { callFrames } } : {}),
  };
};

const consoleText = (params: Record<string, unknown>): string =>
  (Array.isArray(params["args"]) ? params["args"] : [])
    .map((item) => {
      const arg = record(item);
      return bounded(arg["value"] ?? arg["description"]);
    })
    .join(" ");

const appendEvent = (
  state: PreviewObservationState,
  event: Omit<PreviewAutomationObservationEvent, "cursor">,
): PreviewObservationState => {
  const entry = { ...event, cursor: state.nextCursor };
  return {
    ...state,
    nextCursor: state.nextCursor + 1,
    events: [...state.events, entry].slice(-PREVIEW_OBSERVATION_BUFFER_LIMIT),
  };
};

const replaceRequest = (
  requests: ReadonlyMap<string, ObservedRequest>,
  requestId: string,
  update: (current: ObservedRequest | undefined) => ObservedRequest,
): ReadonlyMap<string, ObservedRequest> => {
  const next = new Map(requests);
  next.set(requestId, update(next.get(requestId)));
  while (next.size > PREVIEW_OBSERVATION_BUFFER_LIMIT) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

export const startPreviewObservation = (startedAt: string): PreviewObservationState => ({
  startedAt,
  nextCursor: 1,
  readCursor: 0,
  events: [],
  requests: new Map(),
});

export const capturePreviewObservationEvent = (
  state: PreviewObservationState,
  method: string,
  params: Record<string, unknown>,
  timestamp: string,
): PreviewObservationState => {
  const requestId = typeof params["requestId"] === "string" ? params["requestId"] : undefined;
  if (method === "Runtime.consoleAPICalled") {
    return appendEvent(state, {
      kind: "console",
      timestamp,
      level: typeof params["type"] === "string" ? params["type"] : "log",
      text: bounded(consoleText(params)),
    });
  }
  if (method === "Runtime.exceptionThrown") {
    const details = record(params["exceptionDetails"]);
    const exception = record(details["exception"]);
    return appendEvent(state, {
      kind: "exception",
      timestamp,
      level: "error",
      text: bounded(exception["description"] ?? details["text"] ?? "Uncaught exception"),
    });
  }
  if (method === "Log.entryAdded") {
    const entry = record(params["entry"]);
    return appendEvent(state, {
      kind: "log",
      timestamp,
      level: String(entry["level"] ?? "info"),
      text: bounded(entry["text"]),
      ...(entry["url"] ? { url: sanitizeObservedUrl(String(entry["url"])) } : {}),
    });
  }
  if (!requestId) return state;
  if (method === "Network.requestWillBeSent") {
    const request = record(params["request"]);
    const url = sanitizeObservedUrl(String(request["url"] ?? ""));
    const requestRecord: ObservedRequest = {
      requestId,
      method: String(request["method"] ?? "GET"),
      url,
      startedAt: timestamp,
      monotonicStartedAt: typeof params["timestamp"] === "number" ? params["timestamp"] : null,
      ...(typeof params["type"] === "string" ? { resourceType: params["type"] } : {}),
    };
    return appendEvent(
      { ...state, requests: replaceRequest(state.requests, requestId, () => requestRecord) },
      {
        kind: "request",
        timestamp,
        requestId,
        url,
        method: requestRecord.method,
        ...(requestRecord.resourceType ? { resourceType: requestRecord.resourceType } : {}),
        initiator: sanitizeInitiator(params["initiator"]),
      },
    );
  }
  const current = state.requests.get(requestId);
  if (method === "Network.responseReceived") {
    const response = record(params["response"]);
    const updated: ObservedRequest = {
      ...(current ?? {
        requestId,
        method: "GET",
        url: sanitizeObservedUrl(String(response["url"] ?? "")),
        startedAt: timestamp,
        monotonicStartedAt: null,
      }),
      ...(typeof response["status"] === "number" ? { status: response["status"] } : {}),
      ...(typeof response["statusText"] === "string" ? { statusText: response["statusText"] } : {}),
      ...(typeof response["mimeType"] === "string" ? { mimeType: response["mimeType"] } : {}),
      ...(typeof response["protocol"] === "string" ? { protocol: response["protocol"] } : {}),
    };
    return appendEvent(
      { ...state, requests: replaceRequest(state.requests, requestId, () => updated) },
      {
        kind: "response",
        timestamp,
        requestId,
        url: updated.url,
        method: updated.method,
        ...(updated.status !== undefined ? { status: updated.status } : {}),
        ...(updated.statusText ? { statusText: updated.statusText } : {}),
        ...(updated.mimeType ? { mimeType: updated.mimeType } : {}),
        ...(updated.protocol ? { protocol: updated.protocol } : {}),
      },
    );
  }
  if (method === "Network.loadingFailed") {
    const failed: ObservedRequest = {
      ...(current ?? {
        requestId,
        method: "GET",
        url: "",
        startedAt: timestamp,
        monotonicStartedAt: null,
      }),
      failed: true,
      errorText: bounded(params["errorText"] ?? "Network request failed"),
    };
    return appendEvent(
      { ...state, requests: replaceRequest(state.requests, requestId, () => failed) },
      {
        kind: "loadingFailed",
        timestamp,
        requestId,
        url: failed.url,
        method: failed.method,
        failed: true,
        canceled: params["canceled"] === true,
        errorText: failed.errorText,
      },
    );
  }
  if (method === "Network.loadingFinished") {
    const ended = typeof params["timestamp"] === "number" ? params["timestamp"] : null;
    const durationMs =
      current?.monotonicStartedAt != null && ended != null
        ? Math.max(0, (ended - current.monotonicStartedAt) * 1000)
        : undefined;
    const encodedDataLength =
      typeof params["encodedDataLength"] === "number" ? params["encodedDataLength"] : undefined;
    const finished: ObservedRequest = {
      ...(current ?? {
        requestId,
        method: "GET",
        url: "",
        startedAt: timestamp,
        monotonicStartedAt: null,
      }),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(encodedDataLength !== undefined ? { encodedDataLength } : {}),
    };
    return appendEvent(
      { ...state, requests: replaceRequest(state.requests, requestId, () => finished) },
      {
        kind: "loadingFinished",
        timestamp,
        requestId,
        url: finished.url,
        method: finished.method,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(encodedDataLength !== undefined ? { encodedDataLength } : {}),
      },
    );
  }
  return state;
};

export const readPreviewObservation = (
  tabId: string,
  state: PreviewObservationState,
): readonly [PreviewAutomationObservationRead, PreviewObservationState] => {
  const events = state.events.filter((event) => event.cursor > state.readCursor);
  const cursor = events.at(-1)?.cursor ?? state.readCursor;
  const firstRetainedCursor = state.events[0]?.cursor ?? state.nextCursor;
  const droppedEvents = Math.max(0, firstRetainedCursor - state.readCursor - 1);
  return [
    {
      tabId,
      observing: true,
      cursor,
      startedAt: state.startedAt,
      droppedEvents,
      events,
    },
    { ...state, readCursor: cursor },
  ];
};

export const makeSanitizedHar = (state: PreviewObservationState): object => ({
  log: {
    version: "1.2",
    creator: { name: "T3 Code", version: "1" },
    entries: Array.from(state.requests.values()).map((request) => ({
      startedDateTime: request.startedAt,
      time: request.durationMs ?? 0,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: "",
        headers: [],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: request.status ?? 0,
        statusText: request.statusText ?? request.errorText ?? "",
        httpVersion: request.protocol ?? "",
        headers: [],
        cookies: [],
        content: { size: request.encodedDataLength ?? 0, mimeType: request.mimeType ?? "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: request.encodedDataLength ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: request.durationMs ?? 0, receive: 0 },
    })),
  },
});
