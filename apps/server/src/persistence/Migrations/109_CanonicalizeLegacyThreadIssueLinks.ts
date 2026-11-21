import {
  IssueTrackerKind,
  ProjectId,
  ThreadIssueLink,
  TrimmedNonEmptyString,
  threadIssueKeyOf,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// why: custom builds before the upstream issue trackers stored links keyed by provider/repository/number.
const LegacyThreadIssueLink = Schema.Struct({
  provider: IssueTrackerKind,
  repository: TrimmedNonEmptyString,
  number: Schema.Int,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optionalKey(ProjectId),
  linkId: Schema.optionalKey(Schema.String),
});

const StoredLink = Schema.Union([ThreadIssueLink, LegacyThreadIssueLink]);
const decodeLinks = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(StoredLink)));
const encodeLinks = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ThreadIssueLink)));

export const decodeLegacyThreadIssueLinks = Effect.fnUntraced(function* (input: {
  readonly issuesJson: string;
  readonly projectId: string;
  readonly linkedAt: string;
}) {
  const stored = yield* decodeLinks(input.issuesJson);
  const links = new Map<string, ThreadIssueLink>();
  for (const link of stored) {
    const canonical: ThreadIssueLink =
      "key" in link
        ? link
        : {
            tracker: link.provider,
            host: TrimmedNonEmptyString.make(new URL(link.url).host.toLowerCase()),
            scope: link.repository,
            key: TrimmedNonEmptyString.make(
              link.provider === "linear"
                ? `${link.repository}-${link.number}`
                : String(link.number),
            ),
            projectId: link.projectId ?? ProjectId.make(input.projectId),
            url: link.url,
            source: link.linkId?.startsWith("server:mcp-issue:") === true ? "agent" : "manual",
            linkedAt: input.linkedAt,
            displayKey: TrimmedNonEmptyString.make(
              link.provider === "linear" ? `${link.repository}-${link.number}` : `#${link.number}`,
            ),
            title: link.title,
          };
    const key = threadIssueKeyOf(canonical);
    if (!links.has(key)) links.set(key, canonical);
  }
  return [...links.values()];
});

const canonicalIssueLinksJson = (input: Parameters<typeof decodeLegacyThreadIssueLinks>[0]) =>
  decodeLegacyThreadIssueLinks(input).pipe(Effect.map(encodeLinks));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pageSize = 500;
  let afterThreadId = "";
  while (true) {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly issues_json: string;
      readonly project_id: string;
      readonly updated_at: string;
    }>`
      SELECT thread_id, json_extract(payload_json, '$.issues') AS issues_json,
        json_extract(payload_json, '$.projectId') AS project_id, updated_at
      FROM orchestration_v2_projection_threads
      WHERE thread_id > ${afterThreadId}
        AND instr(payload_json, '"issues":[{') > 0
        AND json_valid(payload_json)
        AND EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.issues') WHERE json_type(value, '$.number') IS NOT NULL
        )
      ORDER BY thread_id
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const issues = yield* canonicalIssueLinksJson({
        issuesJson: row.issues_json,
        projectId: row.project_id,
        linkedAt: row.updated_at,
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.issues', json(${issues}))
        WHERE thread_id = ${row.thread_id}
      `;
    }
    if (rows.length < pageSize) break;
    afterThreadId = rows.at(-1)!.thread_id;
  }

  // Normalize the source events too, so rebuilding projections cannot restore the old shape.
  let afterSequence = 0;
  while (true) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly issues_json: string;
      readonly project_id: string;
      readonly updated_at: string;
    }>`
      SELECT sequence, json_extract(payload_json, '$.issues') AS issues_json,
        json_extract(payload_json, '$.projectId') AS project_id,
        json_extract(payload_json, '$.updatedAt') AS updated_at
      FROM orchestration_events
      WHERE sequence > ${afterSequence}
        AND application_event_version = 2 AND aggregate_kind = 'thread'
        AND event_type LIKE 'thread.%'
        AND instr(payload_json, '"issues":[{') > 0
        AND json_valid(payload_json)
        AND EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.issues') WHERE json_type(value, '$.number') IS NOT NULL
        )
      ORDER BY sequence
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const issues = yield* canonicalIssueLinksJson({
        issuesJson: row.issues_json,
        projectId: row.project_id,
        linkedAt: row.updated_at,
      });
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.issues', json(${issues}))
        WHERE sequence = ${row.sequence}
      `;
    }
    if (rows.length < pageSize) break;
    afterSequence = rows.at(-1)!.sequence;
  }
});
