import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import ProjectionThreadIssues from "./Migrations/062_ProjectionThreadIssues.ts";
import WorkItemLinks from "./Migrations/063_WorkItemLinks.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import PullRequestReviewGuides from "./Migrations/064_PullRequestReviewGuides.ts";
import ThreadFailureLookupIndex from "./Migrations/065_ThreadFailureLookupIndex.ts";
import DropUnusedV1Projections from "./Migrations/063_DropUnusedV1Projections.ts";
import CanonicalizeThreadPullRequestLinks from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import CodexUsageNativeTurnIndex from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import RepairClientSettlementTimestamps from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import WebhookDedupe from "./Migrations/067_WebhookDedupe.ts";
import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";
import ThreadMessageSearch from "./Migrations/069_ThreadMessageSearch.ts";
import PeerLinks from "./Migrations/070_PeerLinks.ts";
import PeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import WaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";
import ActiveTurnItemIndexes from "./Migrations/073_ActiveTurnItemIndexes.ts";
import ExcludeAttachmentPlaceholdersFromSearch from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import SubagentDeliveryState from "./Migrations/075_SubagentDeliveryState.ts";
import ProjectionProjectsPinArchive from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import RepairBooleanSettledOverride from "./Migrations/077_RepairBooleanSettledOverride.ts";
import DropOrchestrationEventCorrelationIndex from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import DelegatedRecoveryIndexes from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import ScheduledTaskThreadMode from "./Migrations/080_ScheduledTaskThreadMode.ts";
import ProjectionMessageSearchText from "./Migrations/081_ProjectionMessageSearchText.ts";
import TurnItemConversationIndex from "./Migrations/082_TurnItemConversationIndex.ts";
import CommandReadIndexes from "./Migrations/083_CommandReadIndexes.ts";
import LastExecutedRunIndex from "./Migrations/084_LastExecutedRunIndex.ts";
import TurnItemCounts from "./Migrations/085_TurnItemCounts.ts";
import QueuedTurnInputIndex from "./Migrations/086_QueuedTurnInputIndex.ts";
import ProjectionProjectsCustomTitle from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import TurnItemTypeStatusIndex from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import ShellThreadReadIndexes from "./Migrations/089_ShellThreadReadIndexes.ts";
import AuthConnectDevices from "./Migrations/090_AuthConnectDevices.ts";
import AuthConnectDeniedRequests from "./Migrations/091_AuthConnectDeniedRequests.ts";
import QueuedTurnInputIndexJsonValid from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import ProviderTurnAttemptIndex from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import TurnItemMessageOrdinalIndex from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import TurnItemInlineWorkOutput from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import RepairStaleTitleRegeneration from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import IssueTrackerBindings from "./Migrations/097_IssueTrackerBindings.ts";
import ActiveShellIndexIndexes from "./Migrations/098_ActiveShellIndexIndexes.ts";
import BackgroundRecoveryIndexes from "./Migrations/099_BackgroundRecoveryIndexes.ts";
import TurnStartReadIndexes from "./Migrations/100_TurnStartReadIndexes.ts";
import DelegatedTaskReadIndexes from "./Migrations/101_DelegatedTaskReadIndexes.ts";
import ThreadItemCounts from "./Migrations/102_ThreadItemCounts.ts";
import IssueTrackerAdditionalScopes from "./Migrations/103_IssueTrackerAdditionalScopes.ts";
import ProjectionProjectsTrackedFolders from "./Migrations/104_ProjectionProjectsTrackedFolders.ts";
import TaskFolders from "./Migrations/105_TaskFolders.ts";
import WorktreePathKeyIndex from "./Migrations/106_WorktreePathKeyIndex.ts";
import DeferredSlashCommandIndex from "./Migrations/107_DeferredSlashCommandIndex.ts";
import AgentFeedback from "./Migrations/108_AgentFeedback.ts";
import IssueTrackerAccounts from "./Migrations/109_IssueTrackerAccounts.ts";
import Workflows from "./Migrations/110_Workflows.ts";
import SupersededRunAttemptIndex from "./Migrations/111_SupersededRunAttemptIndex.ts";
import LayoutCommandApprovals from "./Migrations/112_LayoutCommandApprovals.ts";
import WorkflowSkippedRuns from "./Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunIndexes from "./Migrations/114_WorkflowRunIndexes.ts";
import WorkflowRunTags from "./Migrations/115_WorkflowRunTags.ts";
import ForkHistoryMembership from "./Migrations/116_ForkHistoryMembership.ts";
import WorkflowMailSender from "./Migrations/117_WorkflowMailSender.ts";
import WorkflowPools from "./Migrations/118_WorkflowPools.ts";
import WorkflowRunSubject from "./Migrations/119_WorkflowRunSubject.ts";
import { reconciledV2PreviewHistory } from "./reconcileV2PreviewMigration.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

const nightlyMigrations = [
  ["PullRequestReviewGuides", PullRequestReviewGuides],
  ["ThreadFailureLookupIndex", ThreadFailureLookupIndex],
  ["DropUnusedV1Projections", DropUnusedV1Projections],
  ["CanonicalizeThreadPullRequestLinks", CanonicalizeThreadPullRequestLinks],
  ["CodexUsageNativeTurnIndex", CodexUsageNativeTurnIndex],
  ["RepairClientSettlementTimestamps", RepairClientSettlementTimestamps],
  ["WebhookDedupe", WebhookDedupe],
  ["ShellStopRequestIndex", ShellStopRequestIndex],
  ["ThreadMessageSearch", ThreadMessageSearch],
  ["PeerLinks", PeerLinks],
  ["PeerLinkFence", PeerLinkFence],
  ["WaitingLinkRequestIndex", WaitingLinkRequestIndex],
  ["ActiveTurnItemIndexes", ActiveTurnItemIndexes],
  ["ExcludeAttachmentPlaceholdersFromSearch", ExcludeAttachmentPlaceholdersFromSearch],
  ["SubagentDeliveryState", SubagentDeliveryState],
  ["ProjectionProjectsPinArchive", ProjectionProjectsPinArchive],
  ["RepairBooleanSettledOverride", RepairBooleanSettledOverride],
  ["DropOrchestrationEventCorrelationIndex", DropOrchestrationEventCorrelationIndex],
  ["DelegatedRecoveryIndexes", DelegatedRecoveryIndexes],
  ["ScheduledTaskThreadMode", ScheduledTaskThreadMode],
  ["ProjectionMessageSearchText", ProjectionMessageSearchText],
  ["TurnItemConversationIndex", TurnItemConversationIndex],
  ["CommandReadIndexes", CommandReadIndexes],
  ["LastExecutedRunIndex", LastExecutedRunIndex],
  ["TurnItemCounts", TurnItemCounts],
  ["QueuedTurnInputIndex", QueuedTurnInputIndex],
  ["ProjectionProjectsCustomTitle", ProjectionProjectsCustomTitle],
  ["TurnItemTypeStatusIndex", TurnItemTypeStatusIndex],
  ["ShellThreadReadIndexes", ShellThreadReadIndexes],
  ["AuthConnectDevices", AuthConnectDevices],
  ["AuthConnectDeniedRequests", AuthConnectDeniedRequests],
  ["QueuedTurnInputIndexJsonValid", QueuedTurnInputIndexJsonValid],
  ["ProviderTurnAttemptIndex", ProviderTurnAttemptIndex],
  ["TurnItemMessageOrdinalIndex", TurnItemMessageOrdinalIndex],
  ["TurnItemInlineWorkOutput", TurnItemInlineWorkOutput],
  ["RepairStaleTitleRegeneration", RepairStaleTitleRegeneration],
  ["IssueTrackerBindings", IssueTrackerBindings],
  ["ActiveShellIndexIndexes", ActiveShellIndexIndexes],
  ["BackgroundRecoveryIndexes", BackgroundRecoveryIndexes],
  ["TurnStartReadIndexes", TurnStartReadIndexes],
  ["DelegatedTaskReadIndexes", DelegatedTaskReadIndexes],
  ["ThreadItemCounts", ThreadItemCounts],
  ["IssueTrackerAdditionalScopes", IssueTrackerAdditionalScopes],
  ["ProjectionProjectsTrackedFolders", ProjectionProjectsTrackedFolders],
  ["TaskFolders", TaskFolders],
  ["WorktreePathKeyIndex", WorktreePathKeyIndex],
  ["DeferredSlashCommandIndex", DeferredSlashCommandIndex],
  ["AgentFeedback", AgentFeedback],
  ["IssueTrackerAccounts", IssueTrackerAccounts],
  ["Workflows", Workflows],
  ["SupersededRunAttemptIndex", SupersededRunAttemptIndex],
  ["LayoutCommandApprovals", LayoutCommandApprovals],
  ["WorkflowSkippedRuns", WorkflowSkippedRuns],
  ["WorkflowRunIndexes", WorkflowRunIndexes],
  ["WorkflowRunTags", WorkflowRunTags],
  ["ForkHistoryMembership", ForkHistoryMembership],
  ["WorkflowMailSender", WorkflowMailSender],
  ["WorkflowPools", WorkflowPools],
  ["WorkflowRunSubject", WorkflowRunSubject],
] as const;

const expectedWorkItemLink = (issueUrl: string, pullRequestUrl: string) => ({
  issue_provider: "github",
  issue_url: issueUrl,
  issue_display_key: "#1",
  issue_title: "Issue",
  pull_request_provider: "github",
  pull_request_url: pullRequestUrl,
  pull_request_repository: "a/b",
  pull_request_number: 2,
  pull_request_title: "Fix",
});

describe("V2 preview upgrade", () => {
  it.effect.each([
    2, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 45, 46, 59,
  ])("rebases a valid nightly migration prefix of length %s", (prefixLength) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const prefix = nightlyMigrations.slice(0, prefixLength);
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            prefix.map(([name, migration], index) => [`${61 + index}_${name}`, migration]),
          ),
        ),
      });
      yield* sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'team/repo', 1, '{}')`;
      const guides = yield* sql`SELECT * FROM pull_request_review_guides`;
      const installedHistory = yield* sql`
          SELECT * FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`;
      const recorded = yield* sql<{ readonly id: number; readonly name: string }>`
          SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id`;
      const hasRecentNightlyMigrations = prefixLength > 45;
      const rebasedEnd = prefixLength + (hasRecentNightlyMigrations ? 65 : 63);
      const rebasedHistory = migrationManifest.filter(([id]) => id <= rebasedEnd);

      assert.deepStrictEqual(
        reconciledV2PreviewHistory(recorded),
        rebasedHistory.map(([id, name]) => ({ id, name })),
      );

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [61, "ProjectSkillShortcuts"],
        [62, "ProjectionThreadIssues"],
        [63, "WorkItemLinks"],
        ...(hasRecentNightlyMigrations
          ? ([
              [109, "CanonicalizeLegacyThreadIssueLinks"],
              [110, "WorkItemLinkDisplayKeys"],
            ] as const)
          : []),
        ...migrationManifest.filter(([id]) => id > rebasedEnd),
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations
            WHERE migration_id >= 61 ORDER BY migration_id`,
        migrationManifest
          .filter(([id]) => id >= 61)
          .map(([id, name]) => ({ migration_id: id, name })),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_review_guides`, guides);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`,
        installedHistory,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    70, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 108, 109, 110,
  ])("appends nightly migrations without rewriting fork history through %s", (installedId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: installedId });
      const installedHistory =
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      if (installedId < 110) {
        yield* sql`INSERT INTO work_item_links VALUES ('github', 'issue', 'a/b', 1, 'Issue', 'github', 'pr', 'a/b', 2, 'Fix')`;
      } else {
        yield* sql`INSERT INTO work_item_links VALUES ('github', 'issue', '#1', 'Issue', 'github', 'pr', 'a/b', 2, 'Fix')`;
      }

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > installedId),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${installedId} ORDER BY migration_id`,
        installedHistory,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM work_item_links`, [
        expectedWorkItemLink("issue", "pr"),
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index'
            AND name = 'orchestration_v2_projection_turn_items_stop_request_idx'`,
        [{ name: "orchestration_v2_projection_turn_items_stop_request_idx" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index'
            AND name = 'idx_orch_events_correlation_id'`,
        [],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index'
            AND name IN (
              'orchestration_v2_projection_threads_subagent_result_idx',
              'orchestration_v2_projection_runs_delegated_delivery_idx'
            ) ORDER BY name`,
        [
          { name: "orchestration_v2_projection_runs_delegated_delivery_idx" },
          { name: "orchestration_v2_projection_threads_subagent_result_idx" },
        ],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades official nightly migration 61 without losing review guides", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* PullRequestReviewGuides;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (61, 'PullRequestReviewGuides')`;
      yield* sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'team/repo', 1, '{}')`;
      const guides = yield* sql`SELECT * FROM pull_request_review_guides`;
      const recorded = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id`;

      assert.deepStrictEqual(
        reconciledV2PreviewHistory(recorded),
        migrationManifest.filter(([id]) => id <= 60).map(([id, name]) => ({ id, name })),
      );

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 61),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_review_guides`, guides);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects unknown later nightly migrations without changing history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* PullRequestReviewGuides;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (61, 'PullRequestReviewGuides'), (62, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 53 && id !== 55),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 53 && id !== 55),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([59, 60, 61])(
    "upgrades main migration %s without losing MCP app context",
    (mainId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: mainId });
        yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-07')`;
        const context = yield* sql`SELECT * FROM mcp_app_model_context`;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > mainId),
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM mcp_app_model_context`, context);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${mainId} ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([57, 59, 60, 61, 62])(
    "upgrades issue migration %s without losing links",
    (issueId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: issueId - 1 });
        const baseHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            [`${issueId}_ProjectionThreadIssues`]: ProjectionThreadIssues,
            [`${issueId + 1}_WorkItemLinks`]: WorkItemLinks,
          }),
        });
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, created_at, updated_at, issue_links_json)
        VALUES ('thread', 'project', 'Thread', '2026-10-07', '2026-10-07', '[{"url":"https://github.com/a/b/issues/1"}]')`;
        const threads = yield* sql`SELECT * FROM projection_threads`;
        yield* sql`INSERT INTO work_item_links VALUES ('github', 'https://github.com/a/b/issues/1', 'a/b', 1, 'Issue', 'github', 'https://github.com/a/b/pull/2', 'a/b', 2, 'Fix')`;
        const issueHistory = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          reconciledV2PreviewHistory(
            issueHistory.map((row) => ({ id: row.migration_id, name: row.name })),
          ),
          migrationManifest
            .filter(([id]) => id < (issueId === 62 ? 64 : issueId))
            .map(([id, name]) => ({ id, name })),
        );
        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
          'orchestration_v2_projection_turn_items_user_message_idx',
          'orchestration_v2_projection_nodes_live_idx'
        ) ORDER BY name`,
          [
            { name: "orchestration_v2_projection_nodes_live_idx" },
            { name: "orchestration_v2_projection_turn_items_user_message_idx" },
          ],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
        assert.deepStrictEqual(yield* sql`SELECT * FROM work_item_links`, [
          expectedWorkItemLink("https://github.com/a/b/issues/1", "https://github.com/a/b/pull/2"),
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id < ${issueId} ORDER BY migration_id`,
          baseHistory,
        );
        if (issueId === 62) {
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 63 ORDER BY migration_id`,
            issueHistory,
          );
        }
        yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-07')`;
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([59, 60, 61])(
    "refuses unknown migrations after old issue migration %s without changing links",
    (issueId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: issueId - 1 });
        yield* ProjectionThreadIssues;
        yield* WorkItemLinks;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${issueId}, 'ProjectionThreadIssues'), (${issueId + 1}, 'UnknownFork')`;
        yield* sql`INSERT INTO work_item_links VALUES ('github', 'issue', 'a/b', 1, 'Issue', 'github', 'pr', 'a/b', 2, 'Fix')`;
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const links = yield* sql`SELECT * FROM work_item_links`;
        assert.isNull(
          reconciledV2PreviewHistory(
            history.map((row) => ({ id: row.migration_id, name: row.name })),
          ),
        );
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM work_item_links`, links);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
