import {
  HookApprovalRequestId,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
  type HookApprovalDecision,
  type HookApprovalGrant,
  type HookApprovalHttpResponse,
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
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

interface Credential {
  readonly nativeThreadId?: string;
  readonly runtimeSessionId?: ProviderSessionId | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}
interface SuspendedSession extends Credential {
  readonly nativeThreadId: string;
  readonly allowances: ReadonlyMap<string, HookApprovalGrant>;
}
interface Pending {
  readonly runtimeSessionId?: ProviderSessionId | undefined;
  readonly request: HookApprovalRequest;
  readonly providerSessionId: string;
  readonly completion: Deferred.Deferred<HookApprovalHttpResponse>;
}
interface State {
  readonly suspendedSessions: ReadonlyMap<ThreadId, SuspendedSession>;
  readonly credentials: ReadonlyMap<string, Credential>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly sessionAllowances: ReadonlyMap<string, HookApprovalGrant>;
}
type RequestState =
  | { readonly _tag: "denied" }
  | { readonly _tag: "allowed"; readonly credential: Credential }
  | { readonly _tag: "pending"; readonly credential: Credential };
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
  readonly resetThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly bindConversation: (input: {
    readonly providerSessionId: string;
    readonly threadId: ThreadId;
    readonly runtimeSessionId: ProviderSessionId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly nativeThreadId: string;
  }) => Effect.Effect<void>;
  readonly suspendProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeRuntimeSession: (runtimeSessionId: ProviderSessionId) => Effect.Effect<void>;
  readonly revokeProviderInstance: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  readonly issue: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly runtimeSessionId?: ProviderSessionId;
  }) => Effect.Effect<HookApprovalCredential>;
  readonly isTokenActive: (token: string) => Effect.Effect<boolean>;
  readonly request: (
    token: string,
    input: HookApprovalRequestInput,
  ) => Effect.Effect<HookApprovalHttpResponse>;
  readonly respond: (input: HookApprovalRespondInput) => Effect.Effect<boolean>;
  readonly subscribe: () => Stream.Stream<ReadonlyArray<HookApprovalRequest>>;
  readonly subscribeGrants: () => Stream.Stream<ReadonlyArray<HookApprovalGrant>>;
  readonly revokeGrant: (grantId: string) => Effect.Effect<void>;
  readonly getPending: (requestId: string) => Effect.Effect<HookApprovalRequest | undefined>;
  readonly subscribePending: () => Stream.Stream<ReadonlyArray<HookApprovalPending>>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}
export interface HookApprovalPending {
  readonly request: HookApprovalRequest;
  readonly runtimeSessionId?: ProviderSessionId | undefined;
}
export class HookApprovalRegistry extends Context.Service<
  HookApprovalRegistry,
  HookApprovalRegistryShape
>()("t3/hooks/HookApprovalRegistry") {}

const requestTimeout = Duration.seconds(300);
const tokenFromBytes = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const allowanceKey = (sessionId: string, scope: HookApprovalScope | undefined) =>
  `${sessionId}\u0000${scope ? `scope:${scope.key}` : "unscoped"}`;
const endpointHost = (hostname: string) => {
  const host =
    hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]" ? "127.0.0.1" : hostname;
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};
const grantIsActive = (grant: HookApprovalGrant, now: DateTime.Utc) =>
  grant.expiresAt === null || DateTime.toEpochMillis(grant.expiresAt) > DateTime.toEpochMillis(now);
const snapshot = (state: State) => Array.from(state.pending.values(), ({ request }) => request);
export interface HookApprovalRegistryOptions {
  readonly timeout?: Duration.Input;
}

const makeWithOptions = Effect.fn("HookApprovalRegistry.make")(function* (
  options: HookApprovalRegistryOptions = {},
) {
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6")
    return yield* Effect.die(new Error("Hook approval endpoint requires a TCP HTTP server"));
  const endpoint = `http://${endpointHost(NetAddress.formatIp(server.address.address))}:${server.address.port}/hook-approvals`;
  const state = yield* SubscriptionRef.make<State>({
    suspendedSessions: new Map(),
    credentials: new Map(),
    pending: new Map(),
    sessionAllowances: new Map(),
  });
  const hash = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);
  const finish = (
    pending: Pending | undefined,
    decision: HookApprovalDecision,
    feedback?: string,
  ) =>
    pending
      ? Deferred.succeed(pending.completion, {
          decision,
          ...(decision === "deny" && feedback ? { feedback } : {}),
        }).pipe(Effect.asVoid)
      : Effect.void;
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
    preserveAllowances = false,
    suspendedPredicate?: (session: SuspendedSession) => boolean,
  ) =>
    SubscriptionRef.modify(state, (current) => {
      const matched = Array.from(current.credentials.values()).filter(predicate);
      const suspendedSessions = new Map(
        Array.from(current.suspendedSessions).filter(
          ([, session]) =>
            !suspendedPredicate?.(session) &&
            !matched.some((credential) => credential.threadId === session.threadId),
        ),
      );
      if (preserveAllowances) {
        for (const credential of matched) {
          if (credential.nativeThreadId === undefined) continue;
          const prefix = `${credential.providerSessionId}\u0000`;
          suspendedSessions.set(credential.threadId, {
            ...credential,
            nativeThreadId: credential.nativeThreadId,
            allowances: new Map(
              Array.from(current.sessionAllowances)
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, grant]) => [key.slice(prefix.length), grant]),
            ),
          });
        }
      }
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
        pendingPredicate(entry) || sessions.has(entry.providerSessionId)
          ? (pending.delete(requestId), sessions.add(entry.providerSessionId), [entry])
          : [],
      );
      return [
        removed,
        {
          suspendedSessions,
          credentials,
          pending,
          sessionAllowances: new Map(
            Array.from(current.sessionAllowances).filter(
              ([key]) =>
                !Array.from(sessions).some((sessionId) => key.startsWith(`${sessionId}\u0000`)),
            ),
          ),
        },
      ] as const;
    });
  const removeGrants = Effect.fn("HookApprovalRegistry.removeGrants")(
    (predicate: (grant: HookApprovalGrant) => boolean) =>
      SubscriptionRef.update(state, (current) => ({
        ...current,
        sessionAllowances: new Map(
          Array.from(current.sessionAllowances).filter(([, grant]) => !predicate(grant)),
        ),
        suspendedSessions: new Map(
          Array.from(current.suspendedSessions, ([threadId, session]) => [
            threadId,
            {
              ...session,
              allowances: new Map(
                Array.from(session.allowances).filter(([, grant]) => !predicate(grant)),
              ),
            },
          ]),
        ),
      })),
  );
  return HookApprovalRegistry.of({
    resetThread: Effect.fn("HookApprovalRegistry.resetThread")(function* (threadId) {
      const removed = yield* SubscriptionRef.modify(state, (current) => {
        const sessions = new Set(
          Array.from(current.credentials.values())
            .filter((credential) => credential.threadId === threadId)
            .map((credential) => credential.providerSessionId),
        );
        const pending = new Map(current.pending);
        const removed = Array.from(pending.entries()).flatMap(([id, entry]) =>
          entry.request.threadId === threadId ? (pending.delete(id), [entry]) : [],
        );
        const suspendedSessions = new Map(current.suspendedSessions);
        suspendedSessions.delete(threadId);
        return [
          removed,
          {
            ...current,
            pending,
            suspendedSessions,
            sessionAllowances: new Map(
              Array.from(current.sessionAllowances).filter(
                ([key]) => !Array.from(sessions).some((id) => key.startsWith(`${id}\u0000`)),
              ),
            ),
          },
        ] as const;
      });
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
    }, Effect.uninterruptible),
    bindConversation: Effect.fn("HookApprovalRegistry.bindConversation")(function* (input) {
      yield* SubscriptionRef.update(state, (current) => {
        const credentials = new Map(current.credentials);
        const suspendedSessions = new Map(current.suspendedSessions);
        const sessionAllowances = new Map(current.sessionAllowances);
        for (const [token, credential] of credentials) {
          if (
            credential.providerSessionId !== input.providerSessionId ||
            credential.threadId !== input.threadId ||
            credential.runtimeSessionId !== input.runtimeSessionId ||
            credential.providerInstanceId !== input.providerInstanceId
          )
            continue;
          const prefix = `${credential.providerSessionId}\u0000`;
          if (
            credential.nativeThreadId !== undefined &&
            credential.nativeThreadId !== input.nativeThreadId
          ) {
            for (const key of sessionAllowances.keys())
              if (key.startsWith(prefix)) sessionAllowances.delete(key);
          }
          const suspended = suspendedSessions.get(input.threadId);
          if (
            suspended?.nativeThreadId === input.nativeThreadId &&
            suspended.providerInstanceId === input.providerInstanceId
          ) {
            for (const [key, grant] of suspended.allowances)
              sessionAllowances.set(`${prefix}${key}`, grant);
          }
          suspendedSessions.delete(input.threadId);
          credentials.set(token, { ...credential, nativeThreadId: input.nativeThreadId });
        }
        return { ...current, credentials, suspendedSessions, sessionAllowances };
      });
    }),
    suspendProviderSession: Effect.fn("HookApprovalRegistry.suspendProviderSession")(function* (
      providerSessionId,
    ) {
      const removed = yield* revoke(
        (credential) => credential.providerSessionId === providerSessionId,
        (pending) => pending.providerSessionId === providerSessionId,
        true,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
      yield* Effect.logDebug("hook-approval.conversation-suspended", { providerSessionId });
    }, Effect.uninterruptible),
    revokeRuntimeSession: Effect.fn("HookApprovalRegistry.revokeRuntimeSession")(function* (
      runtimeSessionId,
    ) {
      const removed = yield* revoke(
        (credential) => credential.runtimeSessionId === runtimeSessionId,
        (pending) => pending.runtimeSessionId === runtimeSessionId,
        false,
        (session) => session.runtimeSessionId === runtimeSessionId,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
    }, Effect.uninterruptible),
    revokeProviderInstance: Effect.fn("HookApprovalRegistry.revokeProviderInstance")(function* (
      providerInstanceId,
    ) {
      const removed = yield* revoke(
        (credential) => credential.providerInstanceId === providerInstanceId,
        () => false,
        false,
        (session) => session.providerInstanceId === providerInstanceId,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
    }, Effect.uninterruptible),
    issue: Effect.fn("HookApprovalRegistry.issue")(function* ({
      threadId,
      providerInstanceId,
      runtimeSessionId,
    }) {
      const token = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hash(token);
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const removed = yield* SubscriptionRef.modify(state, (current) => {
        const suspendedSessions = new Map(
          Array.from(current.suspendedSessions).filter(
            ([id, session]) => id !== threadId || session.providerInstanceId === providerInstanceId,
          ),
        );
        for (const credential of current.credentials.values()) {
          if (
            credential.threadId !== threadId ||
            credential.providerInstanceId !== providerInstanceId ||
            credential.nativeThreadId === undefined
          )
            continue;
          const prefix = `${credential.providerSessionId}\u0000`;
          suspendedSessions.set(threadId, {
            ...credential,
            nativeThreadId: credential.nativeThreadId,
            allowances: new Map(
              Array.from(current.sessionAllowances)
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, grant]) => [key.slice(prefix.length), grant]),
            ),
          });
        }
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
        credentials.set(tokenHash, {
          threadId,
          providerSessionId,
          providerInstanceId,
          runtimeSessionId,
        });
        const pending = new Map(current.pending);
        const removed = Array.from(pending.entries()).flatMap(([requestId, entry]) =>
          entry.request.threadId === threadId
            ? (pending.delete(requestId), sessions.add(entry.providerSessionId), [entry])
            : [],
        );
        return [
          removed,
          {
            suspendedSessions,
            credentials,
            pending,
            sessionAllowances: new Map(
              Array.from(current.sessionAllowances).filter(
                ([key]) =>
                  !Array.from(sessions).some((sessionId) => key.startsWith(`${sessionId}\u0000`)),
              ),
            ),
          },
        ] as const;
      });
      yield* Effect.uninterruptible(
        Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true }),
      );
      yield* Effect.logDebug("hook-approval.credential-issued", {
        threadId,
        providerSessionId,
        runtimeSessionId,
        providerInstanceId,
        replacedPendingCount: removed.length,
      });
      return { endpoint, token, providerSessionId };
    }, Effect.uninterruptible),
    isTokenActive: Effect.fn("HookApprovalRegistry.isTokenActive")(function* (token) {
      if (token.length === 0) return false;
      return (yield* SubscriptionRef.get(state)).credentials.has(yield* hash(token));
    }),
    request: Effect.fn("HookApprovalRegistry.request")(function* (token, input) {
      if (token.length === 0) return { decision: "deny" } as const;
      const tokenHash = yield* hash(token);
      const requestId = HookApprovalRequestId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const completion = yield* Deferred.make<HookApprovalHttpResponse>();
      const createdAt = yield* DateTime.now;
      const result: RequestState = yield* SubscriptionRef.modify(
        state,
        (current): readonly [RequestState, State] => {
          const credential = current.credentials.get(tokenHash);
          if (!credential) return [{ _tag: "denied" as const }, current] as const;
          const grant = current.sessionAllowances.get(
            allowanceKey(credential.providerSessionId, input.scope),
          );
          if (grant && grantIsActive(grant, createdAt))
            return [{ _tag: "allowed" as const, credential }, current] as const;
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
            { _tag: "pending" as const, credential },
            {
              ...current,
              pending: new Map(current.pending).set(requestId, {
                request,
                providerSessionId: credential.providerSessionId,
                runtimeSessionId: credential.runtimeSessionId,
                completion,
              }),
            },
          ] as const;
        },
      );
      yield* Effect.logDebug("hook-approval.request", {
        requestId,
        scopeKey: input.scope?.key,
        status: result._tag,
        cacheHit: result._tag === "allowed",
        ...(result._tag === "denied"
          ? {}
          : {
              threadId: result.credential.threadId,
              providerSessionId: result.credential.providerSessionId,
              runtimeSessionId: result.credential.runtimeSessionId,
              providerInstanceId: result.credential.providerInstanceId,
            }),
      });
      if (result._tag === "denied") return { decision: "deny" } as const;
      if (result._tag === "allowed") return { decision: "allow" } as const;
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
    respond: Effect.fn("HookApprovalRegistry.respond")(function* ({
      requestId,
      decision,
      feedback,
      duration = "session",
    }) {
      const now = yield* DateTime.now;
      const expiresAt =
        duration === "session"
          ? null
          : DateTime.add(now, { minutes: duration === "15-minutes" ? 15 : 60 });
      const removed = yield* SubscriptionRef.modify(state, (current) => {
        const entry = current.pending.get(requestId);
        if (!entry) return [undefined, current] as const;
        const key = allowanceKey(entry.providerSessionId, entry.request.scope);
        const nextPending = new Map(current.pending);
        const matching = Array.from(nextPending.entries()).flatMap(([id, pending]) =>
          id === requestId ||
          (decision === "allow-session" &&
            allowanceKey(pending.providerSessionId, pending.request.scope) === key)
            ? (nextPending.delete(id), [pending])
            : [],
        );
        const allowances =
          decision === "allow-session"
            ? new Map(current.sessionAllowances).set(key, {
                grantId: requestId,
                threadId: entry.request.threadId,
                ...(entry.request.scope ? { scope: entry.request.scope } : {}),
                expiresAt,
              })
            : current.sessionAllowances;
        return [
          matching,
          { ...current, pending: nextPending, sessionAllowances: allowances },
        ] as const;
      });
      if (!removed) return false;
      if (decision === "allow-session" && expiresAt !== null) {
        yield* Effect.gen(function* () {
          const currentTime = yield* DateTime.now;
          yield* Effect.sleep(
            DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(currentTime),
          );
          yield* removeGrants((grant) => grant.grantId === requestId);
        }).pipe(Effect.interruptible, Effect.forkIn(scope));
      }
      yield* Effect.logDebug("hook-approval.responded", {
        requestId,
        decision,
        threadId: removed[0]?.request.threadId,
        providerSessionId: removed[0]?.providerSessionId,
        runtimeSessionId: removed[0]?.runtimeSessionId,
        scopeKey: removed[0]?.request.scope?.key,
        resolvedCount: removed.length,
      });
      yield* Effect.forEach(
        removed,
        (pending) => finish(pending, decision === "allow-session" ? "allow" : decision, feedback),
        { discard: true },
      );
      return true;
    }, Effect.uninterruptible),
    subscribe: () => SubscriptionRef.changes(state).pipe(Stream.map(snapshot)),
    subscribeGrants: () =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((current) => [
          ...current.sessionAllowances.values(),
          ...Array.from(current.suspendedSessions.values()).flatMap((session) =>
            Array.from(session.allowances.values()),
          ),
        ]),
        Stream.changesWith(
          (previous, next) =>
            previous.length === next.length &&
            previous.every((grant, index) => grant === next[index]),
        ),
      ),
    revokeGrant: Effect.fn("HookApprovalRegistry.revokeGrant")((grantId) =>
      removeGrants((grant) => grant.grantId === grantId),
    ),
    getPending: Effect.fn("HookApprovalRegistry.getPending")((requestId) =>
      SubscriptionRef.get(state).pipe(
        Effect.map((current) => current.pending.get(requestId)?.request),
      ),
    ),
    subscribePending: () =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((current) =>
          Array.from(current.pending.values(), ({ request, runtimeSessionId }) => ({
            request,
            runtimeSessionId,
          })),
        ),
      ),
    revokeThread: Effect.fn("HookApprovalRegistry.revokeThread")(function* (threadId) {
      const removed = yield* revoke(
        (credential) => credential.threadId === threadId,
        (pending) => pending.request.threadId === threadId,
        false,
        (session) => session.threadId === threadId,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
      yield* Effect.logDebug("hook-approval.thread-revoked", { threadId });
    }, Effect.uninterruptible),
    revokeProviderSession: Effect.fn("HookApprovalRegistry.revokeProviderSession")(function* (
      providerSessionId,
    ) {
      const removed = yield* revoke(
        (credential) => credential.providerSessionId === providerSessionId,
        (pending) => pending.providerSessionId === providerSessionId,
      );
      yield* Effect.forEach(removed, (pending) => finish(pending, "deny"), { discard: true });
      yield* Effect.logDebug("hook-approval.credential-revoked", { providerSessionId });
    }, Effect.uninterruptible),
    revokeAll: SubscriptionRef.modify(
      state,
      (current) =>
        [
          Array.from(current.pending.values()),
          {
            credentials: new Map(),
            pending: new Map(),
            sessionAllowances: new Map<string, HookApprovalGrant>(),
            suspendedSessions: new Map(),
          },
        ] as const,
    ).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, (entry) => finish(entry, "deny"), { discard: true }),
      ),
      Effect.uninterruptible,
    ),
  });
});
export const layer = Layer.effect(
  HookApprovalRegistry,
  Effect.acquireRelease(makeWithOptions(), (service) => service.revokeAll),
);
export const __testing = { make: makeWithOptions };
