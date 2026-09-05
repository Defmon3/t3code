import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("custom-main nightly migration upgrade", (it) => {
  it.effect(
    "preserves existing migration history and quick slots while adding nightly fields",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 47 });
        const previousHistory =
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, skill_shortcuts_json, skill_shortcut_colors_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'upgrade-project', 'Upgrade', 'G:/project', NULL,
          '[]', '["review"]', '{"review":"blue"}',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;

        const applied = yield* runMigrations();
        assert.deepEqual(
          applied.map(([id]) => id),
          [48, 49, 50, 51],
        );
        const retainedHistory = yield* sql`
        SELECT * FROM effect_sql_migrations WHERE migration_id <= 47 ORDER BY migration_id
      `;
        assert.deepEqual(retainedHistory, previousHistory);
        const projects = yield* sql`
        SELECT skill_shortcuts_json, skill_shortcut_colors_json, auto_pull, project_icon_json
        FROM projection_projects WHERE project_id = 'upgrade-project'
      `;
        assert.deepEqual(
          [...projects],
          [
            {
              skill_shortcuts_json: '["review"]',
              skill_shortcut_colors_json: '{"review":"blue"}',
              auto_pull: 0,
              project_icon_json: null,
            },
          ],
        );
        assert.deepEqual(yield* runMigrations(), []);
      }),
  );
});
