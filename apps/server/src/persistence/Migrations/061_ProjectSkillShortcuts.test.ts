import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import migration from "./061_ProjectSkillShortcuts.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("Project quick slot migration", (it) => {
  it.effect("adds empty defaults and preserves existing customized columns on repeat", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_projects (project_id) VALUES ('project')`;
      yield* migration;
      const defaults = yield* sql<{
        skill_shortcuts_json: string;
        skill_shortcut_colors_json: string;
      }>`SELECT * FROM projection_projects`;
      assert.equal(defaults[0]?.skill_shortcuts_json, "[]");
      assert.equal(defaults[0]?.skill_shortcut_colors_json, "{}");
      yield* sql`UPDATE projection_projects SET skill_shortcuts_json = '["review"]', skill_shortcut_colors_json = '{"review":"violet"}'`;
      yield* migration;
      const preserved = yield* sql<{
        skill_shortcuts_json: string;
        skill_shortcut_colors_json: string;
      }>`SELECT * FROM projection_projects`;
      assert.equal(preserved[0]?.skill_shortcuts_json, '["review"]');
      assert.equal(preserved[0]?.skill_shortcut_colors_json, '{"review":"violet"}');
    }),
  );
});
