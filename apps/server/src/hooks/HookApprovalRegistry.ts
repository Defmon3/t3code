import {
  HookApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type HookApprovalDecision,
  type HookApprovalRequest,
  type HookApprovalRespondInput,
  type HookApprovalScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/unstable/http";

interface Credential {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}
interface Pending {
  readonly request: HookApprovalRequest;
  readonly providerSessionId: string;
  readonly completion: Deferred.Deferred<HookApprovalDecision>;
}
interface State {
  readonly credentials: ReadonlyMap<string, Credential>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly sessionAllowances: ReadonlySet<string>;
}
type RequestState =
  | { readonly _tag: "denied" }
  | { readonly _tag: "allowed" }
  | { readonly _tag: "pending" };
export interface HookApprovalCredential {
  readonly endpoint: string;
  readonly token: string;
  readonly providerSessionId: string;
}
export interface HookApprovalRequestInput {
  readonly command: string;
  readonly reason: string;
  readonly cwd: string;
  readonly scope?: HookApprovalScope;
}
export interface HookApprovalRegistryShape {
  readonly issue: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<HookApprovalCredential>;
  readonly isTokenActive: (token: string) => Effect.Effect<boolean>;
  readonly request: (
    token: string,
    input: HookApprovalRequestInput,
  ) => Effect.Effect<HookApprovalDecision>;
  readonly respond: (input: HookApprovalRespondInput) => Effect.Effect<boolean>;
  readonly subscribe: () => Stream.Stream<ReadonlyArray<HookApprovalRequest>>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}
export class HookApprovalRegistry extends Context.Service<
  HookApprovalRegistry,
  HookApprovalRegistryShape
>()("t3/hooks/HookApprovalRegistry") {}

const requestTimeout = Duration.seconds(300);
const tokenFromBytes = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const allowanceKey = (sessionId: string, scope: HookApprovalScope) =>
  `${sessionId}\u0000${scope.key}`;
const endpointHost = (hostname: string) => {
  const host =
    hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]" ? "127.0.0.1" : hostname;
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};
const snapshot = (state: State) => Array.from(state.pending.values(), ({ request }) => request);
export interface HookApprovalRegistryOptions {
  readonly timeout?: Duration.Input;
}

const makeWithOptions = Effect.fn("HookApprovalRegistry.make")(function* (
  options: HookApprovalRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag !== "TcpAddress")
    return yield* Effect.die(new Error("Hook approval endpoint requires a TCP HTTP server"));
  const endpoint = `http://${endpointHost(server.address.hostname)}:${server.address.port}/hook-approvals`;
  const state = yield* SubscriptionRef.make<State>({
    credentials: new Map(),
    pending: new Map(),
    sessionAllowances: new Set(),
  });
  const hash = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);
  const finish = (pending: Pending | undefined, decision: HookApprovalDecision) =>
    pending ? Deferred.succeed(pending.completion, decision).pipe(Effect.asVoid) : Effect.void;
  const removePending = (requestId: string) =>
    SubscriptionRef.modify(state, (current) => {
      const pending = current.pending.get(requestId);
      if (!pending) return [undefined, current] as const;
      const next = new Map(current.pending);
      next.delete(requestId);
      return [pending, { ...current, pending: next }] as const;
    });
  const revoke = (
    predicate: (credential: Credential) => boolean,
    pendingPredicate: (pending: Pending) => boolean,
  ) =>
    SubscriptionRef.modify(state, (current) => {
      const sessions = new Set(
        Array.from(current.credentials.values())
          .filter(predicate)
          .map((credential) => credential.providerSessionId),
      );
      const credentials = new Map(
        Array.from(current.credentials).filter(([, credential]) => !predicate(credential)),
      );
      const pending = new Map(current.pending);
      const removed = Array.from(pending.entries()).flatMap(([requestId, entry]) =>
        pendingPredicate(entry)
          ? (pending.delete(requestId), sessions.add(entry.providerSessionId), [entry])
          : [],
      );
      return [
        removed,
        {
          credentials,
          pending,
          sessionAllowances: new Set(
            Array.from(current.sessionAllowances).filter(
              (key) =>
                !Array.from(sessions).some((sessionId) => key.startsWith(`${sessionId}\u0000`)),
            ),
          ),
        },
      ] as const;
    });
  return HookApprovalRegistry.of({
    issue: Effect.fn("HookApprovalRegistry.issue")(function* ({ threadId, providerInstanceId }) {
      const token = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hash(token);
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const removed = yield* SubscriptionRef.modify(state, (current) => {
        const sessions = new Set(
          Array.from(current.credentials.values())
            .filter((credential) => credential.threadId === threadId)
            .map((credential) => credential.providerSessionId),
        );
        const credentials = new Map(
          Array.from(current.credentials).filter(
            ([, credential]) => credential.threadId !== threadId,
          ),
        );
        credentials.set(tokenHash, { threadId, providerSessionId, providerInstanceId });
        const pending = new Map(current.pending);
        const removed = Array.from(pending.entries()).flatMap(([requestId, entry]) =>
          entry.request.threadId === threadId
            ? (pending.delete(requestId), sessions.add(entry.providerSessionId), [entry])
            : [],
        );
        return [
          removed,
          {
            credentials,
            pending,
            sessionAllowances: new Set(
              Array.from(current.sessionAllowances).filter(
                (key) =>
                  !Array.from(sessions).some((sessionId) => key.startsWith(`${sessionId}\u0000`)),
              ),
            ),
          },
        ] as const;
      });
      yield* Effect.uninterruptible(
        Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true }),
      );
      return { endpoint, token, providerSessionId };
    }, Effect.uninterruptible),
    isTokenActive: Effect.fn("HookApprovalRegistry.isTokenActive")(function* (token) {
      if (token.length === 0) return false;
      return (yield* SubscriptionRef.get(state)).credentials.has(yield* hash(token));
    }),
    request: Effect.fn("HookApprovalRegistry.request")(function* (token, input) {
      if (token.length === 0) return "deny";
      const tokenHash = yield* hash(token);
      const requestId = HookApprovalRequestId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const completion = yield* Deferred.make<HookApprovalDecision>();
      const createdAt = yield* DateTime.now;
      const result: RequestState = yield* SubscriptionRef.modify(
        state,
        (current): readonly [RequestState, State] => {
          const credential = current.credentials.get(tokenHash);
          if (!credential) return [{ _tag: "denied" as const }, current] as const;
          if (
            input.scope &&
            current.sessionAllowances.has(allowanceKey(credential.providerSessionId, input.scope))
          )
            return [{ _tag: "allowed" as const }, current] as const;
          const request: HookApprovalRequest = {
            requestId,
            threadId: credential.threadId,
            command: input.command,
            reason: input.reason,
            cwd: input.cwd,
            ...(input.scope ? { scope: input.scope } : {}),
            createdAt,
          };
          return [
            { _tag: "pending" as const },
            {
              ...current,
              pending: new Map(current.pending).set(requestId, {
                request,
                providerSessionId: credential.providerSessionId,
                completion,
              }),
            },
          ] as const;
        },
      );
      if (result._tag === "denied") return "deny";
      if (result._tag === "allowed") return "allow";
      const timeout = Effect.sleep(options.timeout ?? requestTimeout).pipe(
        Effect.andThen(removePending(requestId)),
        Effect.flatMap((pending) => finish(pending, "deny")),
        Effect.andThen(Deferred.await(completion)),
      );
      return yield* Effect.acquireUseRelease(
        Effect.void,
        () => Effect.interruptible(Effect.raceFirst(Deferred.await(completion), timeout)),
        () =>
          Effect.uninterruptible(
            removePending(requestId).pipe(Effect.flatMap((pending) => finish(pending, "deny"))),
          ),
      );
    }, Effect.uninterruptible),
    respond: Effect.fn("HookApprovalRegistry.respond")(function* ({ requestId, decision }) {
      const pending = yield* SubscriptionRef.modify(state, (current) => {
        const entry = current.pending.get(requestId);
        if (!entry || (decision === "allow-session" && !entry.request.scope))
          return [undefined, current] as const;
        const nextPending = new Map(current.pending);
        nextPending.delete(requestId);
        const allowances =
          decision === "allow-session"
            ? new Set(current.sessionAllowances).add(
                allowanceKey(entry.providerSessionId, entry.request.scope!),
              )
            : current.sessionAllowances;
        return [
          entry,
          { ...current, pending: nextPending, sessionAllowances: allowances },
        ] as const;
      });
      if (!pending) return false;
      yield* finish(pending, decision);
      return true;
    }, Effect.uninterruptible),
    subscribe: () => SubscriptionRef.changes(state).pipe(Stream.map(snapshot)),
    revokeThread: Effect.fn("HookApprovalRegistry.revokeThread")(function* (threadId) {
      const removed = yield* revoke(
        (credential) => credential.threadId === threadId,
        (pending) => pending.request.threadId === threadId,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
    }, Effect.uninterruptible),
    revokeAll: SubscriptionRef.modify(
      state,
      (current) =>
        [
          Array.from(current.pending.values()),
          { credentials: new Map(), pending: new Map(), sessionAllowances: new Set<string>() },
        ] as const,
    ).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, (entry) => finish(entry, "deny"), { discard: true }),
      ),
      Effect.uninterruptible,
    ),
  });
});
let active: HookApprovalRegistryShape | undefined;
const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((service) =>
      Effect.sync(() => {
        active = service;
      }),
    ),
  ),
  (service) =>
    service.revokeAll.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (active === service) active = undefined;
        }),
      ),
    ),
);
export const layer = Layer.effect(HookApprovalRegistry, make);
export const issueActiveHookApprovalCredential = (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}): Effect.Effect<HookApprovalCredential | undefined> =>
  active ? active.issue(input) : Effect.succeed(undefined);
export const revokeActiveHookApprovalThread = (threadId: ThreadId): Effect.Effect<void> =>
  active ? active.revokeThread(threadId) : Effect.void;
export const revokeAllActiveHookApprovalCredentials = (): Effect.Effect<void> =>
  active ? active.revokeAll : Effect.void;
export const __testing = { make: makeWithOptions };
