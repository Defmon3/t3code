import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE work_item_links_by_url (
      issue_provider TEXT NOT NULL,
      issue_url TEXT NOT NULL,
      issue_display_key TEXT NOT NULL,
      issue_title TEXT NOT NULL,
      pull_request_provider TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      pull_request_repository TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL,
      pull_request_title TEXT NOT NULL,
      PRIMARY KEY (issue_provider, issue_url, pull_request_provider, pull_request_url)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO work_item_links_by_url
    SELECT issue_provider, issue_url,
      CASE WHEN lower(issue_provider) = 'linear' THEN issue_repository || '-' ELSE '#' END
        || issue_number,
      issue_title, pull_request_provider, pull_request_url, pull_request_repository,
      pull_request_number, pull_request_title
    FROM work_item_links
  `;
  yield* sql`DROP TABLE work_item_links`;
  yield* sql`ALTER TABLE work_item_links_by_url RENAME TO work_item_links`;
  yield* sql`
    CREATE INDEX idx_work_item_links_pull_request
    ON work_item_links(pull_request_provider, pull_request_url)
  `;
});
