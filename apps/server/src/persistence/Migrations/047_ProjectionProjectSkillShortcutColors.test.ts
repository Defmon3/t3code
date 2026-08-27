import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionProjectSkillShortcutColors", (it) => {
  it.effect("adds and backfills skill shortcut colors with an empty object", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          skill_shortcuts_json, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-before-colors', 'Before colors', '/tmp/before-colors', NULL,
          '["review"]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 47 });

      const rows = yield* sql<{ readonly skillShortcutColors: string }>`
        SELECT skill_shortcut_colors_json AS "skillShortcutColors"
        FROM projection_projects
        WHERE project_id = 'project-before-colors'
      `;
      assert.deepStrictEqual(rows, [{ skillShortcutColors: "{}" }]);
    }),
  );
});
