import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import ProjectSkillShortcuts from "./Migrations/061_ProjectSkillShortcuts.ts";
import ProjectionThreadIssues from "./Migrations/062_ProjectionThreadIssues.ts";
import WorkItemLinks from "./Migrations/063_WorkItemLinks.ts";

type MigrationRow = { readonly id: number; readonly name: string };

const NIGHTLY_MIGRATION_REBASE: ReadonlyArray<readonly [number, number, string]> = [
  [61, 64, "PullRequestReviewGuides"],
  [62, 65, "ThreadFailureLookupIndex"],
  [63, 66, "DropUnusedV1Projections"],
  [64, 67, "CanonicalizeThreadPullRequestLinks"],
  [65, 68, "CodexUsageNativeTurnIndex"],
  [66, 69, "RepairClientSettlementTimestamps"],
  [67, 70, "WebhookDedupe"],
  [68, 71, "ShellStopRequestIndex"],
  [69, 72, "ThreadMessageSearch"],
  [70, 73, "PeerLinks"],
  [71, 74, "PeerLinkFence"],
  [72, 75, "WaitingLinkRequestIndex"],
  [73, 76, "ActiveTurnItemIndexes"],
  [74, 77, "ExcludeAttachmentPlaceholdersFromSearch"],
  [75, 78, "SubagentDeliveryState"],
  [76, 79, "ProjectionProjectsPinArchive"],
  [77, 80, "RepairBooleanSettledOverride"],
  [78, 81, "DropOrchestrationEventCorrelationIndex"],
  [79, 82, "DelegatedRecoveryIndexes"],
  [80, 83, "ScheduledTaskThreadMode"],
  [81, 84, "ProjectionMessageSearchText"],
  [82, 85, "TurnItemConversationIndex"],
  [83, 86, "CommandReadIndexes"],
  [84, 87, "LastExecutedRunIndex"],
  [85, 88, "TurnItemCounts"],
];

function nightlyMigrationPrefix(history: ReadonlyArray<MigrationRow>) {
  const nightly = history.filter((row) => row.id >= 61);
  return nightly.length > 0 &&
    nightly.length <= NIGHTLY_MIGRATION_REBASE.length &&
    nightly.every(
      (row, index) =>
        row.id === NIGHTLY_MIGRATION_REBASE[index]?.[0] &&
        row.name === NIGHTLY_MIGRATION_REBASE[index]?.[2],
    )
    ? NIGHTLY_MIGRATION_REBASE.slice(0, nightly.length)
    : [];
}

const rebaseNightlyMigrationSequence = Effect.fn("rebaseNightlyMigrationSequence")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id
  `;
  if (
    history.length === 1 &&
    history[0]?.migration_id === 61 &&
    history[0].name === "PullRequestReviewGuides"
  ) {
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 61 AND name = 'PullRequestReviewGuides'`;
    return [] as const;
  }
  const prefix = nightlyMigrationPrefix(
    history.map((row) => ({ id: row.migration_id, name: row.name })),
  );
  if (prefix.length < 2) {
    return [] as const;
  }
  const prefixEnd = 60 + prefix.length;
  yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id + 100
    WHERE migration_id BETWEEN 61 AND ${prefixEnd}`;
  yield* ProjectSkillShortcuts;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'ProjectSkillShortcuts')`;
  yield* ProjectionThreadIssues;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'ProjectionThreadIssues')`;
  yield* WorkItemLinks;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'WorkItemLinks')`;
  for (const [fromId, toId, name] of prefix) {
    yield* sql`
      UPDATE effect_sql_migrations SET migration_id = ${toId}, name = ${name}
      WHERE migration_id = ${fromId + 100} AND name = ${name}
    `;
  }
  return [
    [61, "ProjectSkillShortcuts"],
    [62, "ProjectionThreadIssues"],
    [63, "WorkItemLinks"],
  ] as const;
});

// Previews used V2 ids 53/54; preserve their schema and import progress while reserving main's ids.
function v2PreviewId(history: ReadonlyArray<MigrationRow>): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 53);
  const legacy = later.find(
    (row) => row.name === "OrchestrationV2" && (row.id === 53 || row.id === 54),
  );
  if (!legacy) return undefined;
  const valid = later.every(
    (row) =>
      row === legacy ||
      (legacy.id === 54 &&
        ((row.id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
  );
  return valid ? legacy.id : "invalid";
}

/** The history as startup's preview reconciliation leaves it, or null when startup rejects it. */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const prefix = nightlyMigrationPrefix(history);
  if (prefix.length === 1) return history.filter((row) => row.id < 61);
  if (prefix.length > 1) {
    return [
      ...history.filter((row) => row.id < 61),
      { id: 61, name: "ProjectSkillShortcuts" },
      { id: 62, name: "ProjectionThreadIssues" },
      { id: 63, name: "WorkItemLinks" },
      ...prefix.map(([, id, name]) => ({ id, name })),
    ];
  }
  const issuePreview = history.find(
    (row) => row.name === "ProjectionThreadIssues" && [54, 57, 59, 60, 61].includes(row.id),
  );
  if (issuePreview) {
    const issueId = issuePreview.id;
    const valid =
      issueId === 54
        ? history
            .filter((row) => row.id >= 53)
            .every(
              (row) =>
                (row.id === 53 && row.name === "PullRequestFilesViewed") ||
                (row.id === 54 && row.name === "ProjectionThreadIssues") ||
                (row.id === 55 && row.name === "WorkItemLinks"),
            )
        : history.every(
            (row) => row.id <= issueId || (row.id === issueId + 1 && row.name === "WorkItemLinks"),
          );
    return valid
      ? history.filter(
          (row) =>
            !(row.id === issueId && row.name === "ProjectionThreadIssues") &&
            !(row.id === issueId + 1 && row.name === "WorkItemLinks"),
        )
      : null;
  }
  const previewId = v2PreviewId(history);
  if (previewId === undefined) return history;
  if (previewId === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 53),
    { id: 53, name: "PullRequestFilesViewed" },
    { id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    { id: 55, name: "OrchestrationV2" },
    ...(history.some((row) => row.id === 55)
      ? [{ id: 56, name: "RemoveRedundantProjectionIndexes" }]
      : []),
  ];
}

export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      const nightlyReviewGuides = history.some(
        (row) => row.migration_id === 61 && row.name === "PullRequestReviewGuides",
      );
      if (nightlyReviewGuides && history.length === 1) {
        yield* sql`DELETE FROM effect_sql_migrations
          WHERE migration_id = 61 AND name = 'PullRequestReviewGuides'`;
        return [];
      }
      const rebasedNightly = yield* rebaseNightlyMigrationSequence();
      if (rebasedNightly.length > 0) return rebasedNightly;
      const rebasedIssuePreview = history.find(
        (row) =>
          (row.migration_id === 57 ||
            row.migration_id === 59 ||
            row.migration_id === 60 ||
            row.migration_id === 61) &&
          row.name === "ProjectionThreadIssues",
      );
      if (rebasedIssuePreview) {
        const issueId = rebasedIssuePreview.migration_id;
        if (
          history.some(
            (row) =>
              row.migration_id > issueId &&
              !(row.migration_id === issueId + 1 && row.name === "WorkItemLinks"),
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade issue preview with unexpected later migrations.",
          });
        }
        yield* sql`DELETE FROM effect_sql_migrations
          WHERE (migration_id = ${issueId} AND name = 'ProjectionThreadIssues')
          OR (migration_id = ${issueId + 1} AND name = 'WorkItemLinks')`;
        return [];
      }
      const issuePreview = history.some(
        (row) => row.migration_id === 54 && row.name === "ProjectionThreadIssues",
      );
      if (issuePreview) {
        if (
          !history.every(
            (row) =>
              (row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
              (row.migration_id === 54 && row.name === "ProjectionThreadIssues") ||
              (row.migration_id === 55 && row.name === "WorkItemLinks"),
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade issue preview with unexpected later migrations.",
          });
        }
        yield* sql`DELETE FROM effect_sql_migrations
          WHERE (migration_id = 54 AND name = 'ProjectionThreadIssues')
          OR (migration_id = 55 AND name = 'WorkItemLinks')`;
        return [];
      }
      const previewId = v2PreviewId(
        history.map((row) => ({ id: row.migration_id, name: row.name })),
      );
      if (previewId === undefined) return [];
      if (previewId === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (previewId === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${previewId} AND name = 'OrchestrationV2'`;
      if (previewId === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
