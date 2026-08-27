import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionProjectSkillShortcuts", (it) => {
  it.effect("adds and backfills skill shortcuts with an empty array", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-before-shortcuts', 'Before shortcuts', '/tmp/before-shortcuts', NULL,
          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 44 });

      const rows = yield* sql<{ readonly skillShortcuts: string }>`
        SELECT skill_shortcuts_json AS "skillShortcuts"
        FROM projection_projects
        WHERE project_id = 'project-before-shortcuts'
      `;
      assert.deepStrictEqual(rows, [{ skillShortcuts: "[]" }]);
    }),
  );
});
