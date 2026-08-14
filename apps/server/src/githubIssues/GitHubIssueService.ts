import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";
import {
  GitHubIssuesOperationError,
  GitHubIssuesUnavailableError,
  type GitHubIssueInvalidateInput,
  type GitHubIssueListInput,
  type GitHubIssueListResult,
} from "@t3tools/contracts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

const LIST_CACHE_CAPACITY = 64;
const LIST_CACHE_TTL = Duration.seconds(30);
const CURSOR_CAPACITY = 256;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const SEARCH_LIMIT = 1000;
export type GitHubIssueServiceError = GitHubIssuesUnavailableError | GitHubIssuesOperationError;
type CursorEntry = {
  readonly cwd: string;
  readonly fingerprint: string;
  readonly after: string | null;
  readonly delivered: number;
  readonly expiresAt: number;
};
type CachedKey = {
  readonly generation: number;
  readonly fingerprint: string;
  readonly after: string | null;
};
function fingerprint(input: GitHubIssueListInput) {
  return JSON.stringify({
    cwd: input.cwd,
    state: input.state,
    sort: input.sort,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}
function cursorToken() {
  return NodeCrypto.randomBytes(16).toString("hex");
}
function toError(error: GitHubIssueCli.GitHubIssueCliError): GitHubIssueServiceError {
  return error.reason === "not-github" ||
    error.reason === "missing-tool" ||
    error.reason === "unauthenticated"
    ? new GitHubIssuesUnavailableError({ reason: error.reason, cause: error })
    : new GitHubIssuesOperationError({
        operation: error.operation,
        detail: error.detail,
        cause: error,
      });
}

export class GitHubIssueService extends Context.Service<
  GitHubIssueService,
  {
    readonly list: (
      input: GitHubIssueListInput,
    ) => Effect.Effect<GitHubIssueListResult, GitHubIssueServiceError>;
    readonly invalidate: (input: GitHubIssueInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/githubIssues/GitHubIssueService") {}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubIssueCli.GitHubIssueCli;
  const semaphore = yield* Semaphore.make(4);
  const generation = yield* Ref.make(0);
  const cursors = new Map<string, CursorEntry>();
  const read = (key: CachedKey) =>
    semaphore
      .withPermit(
        cli.list({ input: JSON.parse(key.fingerprint) as GitHubIssueListInput, after: key.after }),
      )
      .pipe(Effect.mapError(toError));
  const cache = yield* Cache.makeWith<
    CachedKey,
    GitHubIssueCli.GitHubIssueCliResult,
    GitHubIssueServiceError
  >(read, {
    capacity: LIST_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
  });
  const list = Effect.fn("GitHubIssueService.list")(function* (input: GitHubIssueListInput) {
    const now = yield* Clock.currentTimeMillis;
    const key = fingerprint(input);
    let after: string | null = null;
    let delivered = 0;
    if (input.cursor !== undefined) {
      const cursor = cursors.get(input.cursor);
      if (cursor === undefined || cursor.expiresAt <= now || cursor.fingerprint !== key)
        return yield* new GitHubIssuesOperationError({
          operation: "list",
          detail: "The issue cursor is invalid, expired, or belongs to another query.",
        });
      after = cursor.after;
      delivered = cursor.delivered;
    }
    if (delivered >= SEARCH_LIMIT)
      return yield* new GitHubIssuesOperationError({
        operation: "list",
        detail: "The issue cursor has reached GitHub search's 1,000-result limit.",
      });
    const currentGeneration = yield* Ref.get(generation);
    const result = yield* Cache.get(cache, {
      generation: currentGeneration,
      fingerprint: key,
      after,
    });
    const remaining = SEARCH_LIMIT - delivered;
    const items = result.items.slice(0, remaining);
    const nextDelivered = delivered + items.length;
    const hasMore =
      result.pageInfo.hasNextPage &&
      result.pageInfo.endCursor !== null &&
      nextDelivered < SEARCH_LIMIT;
    let nextCursor: string | null = null;
    if (hasMore && result.pageInfo.endCursor !== null) {
      nextCursor = cursorToken();
      cursors.set(nextCursor, {
        cwd: input.cwd,
        fingerprint: key,
        after: result.pageInfo.endCursor,
        delivered: nextDelivered,
        expiresAt: now + CURSOR_TTL_MS,
      });
      while (cursors.size > CURSOR_CAPACITY) cursors.delete(cursors.keys().next().value as string);
    }
    return {
      repository: result.repository,
      items,
      openCount: result.openCount,
      closedCount: result.closedCount,
      totalCount: result.totalCount,
      nextCursor,
      hasMore,
      searchCapReached: result.searchCapReached,
    };
  });
  const invalidate = Effect.fn("GitHubIssueService.invalidate")(function* (
    input: GitHubIssueInvalidateInput,
  ) {
    yield* cli.invalidate(input.cwd);
    yield* Ref.update(generation, (value) => value + 1);
    for (const [token, cursor] of cursors) if (cursor.cwd === input.cwd) cursors.delete(token);
  });
  return GitHubIssueService.of({ list, invalidate });
});
export const layer = Layer.effect(GitHubIssueService, make);
