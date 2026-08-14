import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GitHubIssueListInput } from "@t3tools/contracts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";
const receivedInputs: GitHubIssueListInput[] = [];
let pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};
const list = ({
  input,
}: {
  readonly input: GitHubIssueListInput;
  readonly after: string | null;
}) => {
  receivedInputs.push(input);
  return Effect.succeed({
    repository: {
      nameWithOwner: "o/r",
      url: "https://github.com/o/r",
      canCreateIssue: false as const,
      newIssueUrl: null,
    },
    items: [],
    openCount: 0,
    closedCount: 0,
    totalCount: 0,
    pageInfo,
    searchCapReached: false,
    input,
  });
};
const invalidatedCwds: string[] = [];
it.effect("preserves omitted input options while invalidating both workspace caches", () =>
  Effect.gen(function* () {
    invalidatedCwds.length = 0;
    receivedInputs.length = 0;
    pageInfo = { hasNextPage: false, endCursor: null };
    const service = yield* GitHubIssueService.GitHubIssueService;
    yield* service.list({ cwd: "x", state: "open", sort: "newest" });
    assert.deepStrictEqual(receivedInputs, [{ cwd: "x", state: "open", sort: "newest" }]);
    yield* service.invalidate({ cwd: "x" });
    const result = yield* service.list({ cwd: "x", state: "open", sort: "newest" });
    assert.strictEqual(result.hasMore, false);
    assert.deepStrictEqual(invalidatedCwds, ["x"]);
  }).pipe(
    Effect.provide(
      GitHubIssueService.layer.pipe(
        Layer.provide(
          Layer.succeed(
            GitHubIssueCli.GitHubIssueCli,
            GitHubIssueCli.GitHubIssueCli.of({
              list,
              invalidate: (cwd) =>
                Effect.sync(() => {
                  invalidatedCwds.push(cwd);
                }),
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("does not expose or retain a cursor without an end cursor", () =>
  Effect.gen(function* () {
    pageInfo = { hasNextPage: true, endCursor: null };
    const service = yield* GitHubIssueService.GitHubIssueService;
    const result = yield* service.list({ cwd: "x", state: "open", sort: "newest" });
    assert.strictEqual(result.hasMore, false);
    assert.strictEqual(result.nextCursor, null);
  }).pipe(
    Effect.provide(
      GitHubIssueService.layer.pipe(
        Layer.provide(
          Layer.succeed(
            GitHubIssueCli.GitHubIssueCli,
            GitHubIssueCli.GitHubIssueCli.of({ list, invalidate: () => Effect.void }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("removes workspace cursors during invalidation", () =>
  Effect.gen(function* () {
    pageInfo = { hasNextPage: true, endCursor: "after" };
    const service = yield* GitHubIssueService.GitHubIssueService;
    const first = yield* service.list({ cwd: "x", state: "open", sort: "newest" });
    if (first.nextCursor === null) throw new Error("Expected a cursor.");
    yield* service.invalidate({ cwd: "x" });
    const error = yield* service
      .list({ cwd: "x", state: "open", sort: "newest", cursor: first.nextCursor })
      .pipe(Effect.flip);
    if (error._tag !== "GitHubIssuesOperationError")
      throw new Error("Expected an operation error.");
    assert.strictEqual(error.operation, "list");
  }).pipe(
    Effect.provide(
      GitHubIssueService.layer.pipe(
        Layer.provide(
          Layer.succeed(
            GitHubIssueCli.GitHubIssueCli,
            GitHubIssueCli.GitHubIssueCli.of({ list, invalidate: () => Effect.void }),
          ),
        ),
      ),
    ),
  ),
);
