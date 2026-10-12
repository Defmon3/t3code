import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import IssueLinks from "./062_ProjectionThreadIssues.ts";
import WorkItemLinks from "./063_WorkItemLinks.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades custom migration 61 without changing saved project shortcuts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, skill_shortcuts_json, skill_shortcut_colors_json)
      VALUES ('project', 'Project', '/workspace', '[]', '2026-10-07', '2026-10-07', '["review"]', '{"review":"violet"}')`;
    const projects = yield* sql`SELECT * FROM projection_projects`;
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

    assert.deepEqual(yield* runMigrations(), [
      [62, "ProjectionThreadIssues"],
      [63, "WorkItemLinks"],
      [64, "PullRequestReviewGuides"],
    ]);

    assert.deepEqual(yield* sql`SELECT * FROM projection_projects`, projects);
    assert.deepEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 61 ORDER BY migration_id`,
      history,
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds an issue link column with an empty default", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* runMigrations({ toMigrationInclusive: 62 });
    const columns = yield* sql<{
      readonly name: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
    }>`PRAGMA table_info(projection_threads)`;
    const column = columns.find((entry) => entry.name === "issue_links_json");
    assert.equal(column?.notnull, 1);
    assert.equal(column?.dflt_value, "'[]'");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("upgrades the issue preview ledger without losing saved links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 53 });
    yield* IssueLinks;
    yield* WorkItemLinks;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectionThreadIssues'), (55, 'WorkItemLinks')`;
    yield* sql`INSERT INTO work_item_links VALUES
          ('github', 'issue-url', 'team/repo', 1, 'Issue',
           'github', 'pr-url', 'team/repo', 2, 'Pull request')`;
    yield* runMigrations();
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 54 ORDER BY migration_id`;
    assert.deepEqual(history, [
      { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
      { migration_id: 55, name: "OrchestrationV2" },
      { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
      { migration_id: 57, name: "ScheduledTaskWebhooks" },
      { migration_id: 58, name: "WebhookRelayDeliveries" },
      { migration_id: 59, name: "McpAppModelContext" },
      { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
      { migration_id: 61, name: "ProjectSkillShortcuts" },
      { migration_id: 62, name: "ProjectionThreadIssues" },
      { migration_id: 63, name: "WorkItemLinks" },
      { migration_id: 64, name: "PullRequestReviewGuides" },
    ]);
    const links = yield* sql<{
      readonly issue_title: string;
    }>`SELECT issue_title FROM work_item_links`;
    assert.deepEqual(links, [{ issue_title: "Issue" }]);
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`;
    assert.equal(tables.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
