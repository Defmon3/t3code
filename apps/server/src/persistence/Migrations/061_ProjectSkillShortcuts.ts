import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "skill_shortcuts_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN skill_shortcuts_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!columns.some((column) => column.name === "skill_shortcut_colors_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN skill_shortcut_colors_json TEXT NOT NULL DEFAULT '{}'`;
  }
});
