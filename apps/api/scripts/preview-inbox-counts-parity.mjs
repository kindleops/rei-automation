import pg from "pg";

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL");
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const currentSql = `
SELECT priority, new_replies, needs_review, waiting, all_messages
FROM canonical_inbox_counts;
`;

const proposedSql = `
WITH active_threads AS (
  SELECT *
  FROM canonical_inbox_threads
  WHERE COALESCE(is_archived, false) = false
),
waiting_facts AS (
  SELECT thread_key
  FROM active_threads t
  WHERE t.latest_message_direction = 'outbound'
    AND COALESCE(t.last_outbound_at, t.latest_message_at) >= NOW() - INTERVAL '24 hours'
    AND (
      t.last_inbound_at IS NULL
      OR t.last_inbound_at < COALESCE(t.last_outbound_at, t.latest_message_at)
    )
    AND COALESCE(t.opt_out, false) = false
    AND COALESCE(t.wrong_number, false) = false
    AND COALESCE(t.not_interested, false) = false
    AND COALESCE(t.latest_delivery_status, '') NOT ILIKE '%fail%'
    AND COALESCE(t.latest_delivery_status, '') NOT IN ('cancelled', 'canceled')
    AND COALESCE(t.latest_delivery_status, '') IN ('', 'sent', 'delivered', 'accepted', 'queued', 'pending', 'sending', 'submitted', 'delivery_unknown')
),
new_replies_facts AS (
  SELECT thread_key
  FROM active_threads t
  WHERE t.inbox_bucket NOT IN ('dead', 'suppressed')
    AND COALESCE(t.opt_out, false) = false
    AND COALESCE(t.wrong_number, false) = false
    AND COALESCE(t.not_interested, false) = false
    AND t.inbox_bucket NOT IN ('priority', 'needs_review', 'waiting', 'cold')
    AND COALESCE(t.needs_review, false) = false
    AND (
      (
        t.inbox_bucket = 'new_replies'
        AND t.latest_message_direction = 'inbound'
        AND t.last_inbound_at IS NOT NULL
        AND (
          t.last_outbound_at IS NULL
          OR t.last_inbound_at >= t.last_outbound_at
        )
      )
      OR (
        t.latest_message_direction = 'inbound'
        AND t.last_inbound_at IS NOT NULL
        AND (
          t.last_outbound_at IS NULL
          OR t.last_inbound_at >= t.last_outbound_at
        )
      )
    )
)
SELECT
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority') AS priority,
  (SELECT COUNT(*) FROM new_replies_facts) AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review' OR needs_review = true) AS needs_review,
  (SELECT COUNT(*) FROM waiting_facts) AS waiting,
  COUNT(*) FILTER (WHERE thread_key NOT IN (SELECT thread_key FROM waiting_facts)) AS all_messages
FROM active_threads;
`;

const gapSql = `
WITH active_threads AS (
  SELECT *
  FROM canonical_inbox_threads
  WHERE COALESCE(is_archived, false) = false
),
sql_broad AS (
  SELECT thread_key
  FROM active_threads t
  WHERE t.inbox_bucket NOT IN ('dead', 'suppressed')
    AND t.latest_message_direction = 'inbound'
    AND (
      t.last_inbound_at IS NULL
      OR t.last_outbound_at IS NULL
      OR t.last_inbound_at >= t.last_outbound_at
    )
    AND COALESCE(t.needs_review, false) = false
    AND COALESCE(t.opt_out, false) = false
    AND COALESCE(t.wrong_number, false) = false
    AND COALESCE(t.not_interested, false) = false
),
js_like AS (
  SELECT thread_key
  FROM active_threads t
  WHERE t.inbox_bucket NOT IN ('dead', 'suppressed')
    AND COALESCE(t.opt_out, false) = false
    AND COALESCE(t.wrong_number, false) = false
    AND COALESCE(t.not_interested, false) = false
    AND t.inbox_bucket NOT IN ('priority', 'needs_review', 'waiting', 'cold')
    AND COALESCE(t.needs_review, false) = false
    AND t.latest_message_direction = 'inbound'
    AND t.last_inbound_at IS NOT NULL
    AND (
      t.last_outbound_at IS NULL
      OR t.last_inbound_at >= t.last_outbound_at
    )
)
SELECT
  (SELECT COUNT(*) FROM sql_broad) AS sql_broad,
  (SELECT COUNT(*) FROM js_like) AS js_like,
  (SELECT COUNT(*) FROM sql_broad b WHERE b.thread_key IN (
    SELECT thread_key FROM active_threads WHERE inbox_bucket = 'priority'
  )) AS priority_overlay,
  (SELECT COUNT(*) FROM sql_broad b WHERE b.thread_key IN (
    SELECT thread_key FROM active_threads WHERE inbox_bucket = 'needs_review' OR needs_review = true
  )) AS needs_review_overlay;
`;

const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${proposedSql}`;

await client.connect();
try {
  const started = Date.now();
  const [current, proposed, gap, explain] = await Promise.all([
    client.query(currentSql),
    client.query(proposedSql),
    client.query(gapSql),
    client.query(explainSql),
  ]);
  const elapsedMs = Date.now() - started;

  const cur = current.rows[0];
  const prop = proposed.rows[0];
  const categories = ["priority", "new_replies", "needs_review", "waiting", "all_messages"];

  console.log("PREVIEW_TABLE");
  console.log("| Category | Current SQL | Proposed SQL | Difference |");
  console.log("|---|---:|---:|---:|");
  for (const key of categories) {
    const currentVal = Number(cur[key] || 0);
    const proposedVal = Number(prop[key] || 0);
    console.log(`| ${key} | ${currentVal} | ${proposedVal} | ${proposedVal - currentVal} |`);
  }

  console.log("\nGAP_BREAKDOWN", gap.rows[0]);
  console.log("\nQUERY_MS", elapsedMs);
  console.log("\nQUERY_PLAN");
  for (const line of explain.rows) {
    console.log(line["QUERY PLAN"]);
  }
} finally {
  await client.end();
}