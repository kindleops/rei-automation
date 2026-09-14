/**
 * Regression: the operator said "we're not getting any new responses in" while
 * 31 seller replies arrived that same day.
 *
 * Inbound was never broken. The bucket tab filters were.
 *
 * `inbox_bucket.neq.dead` compiles to `inbox_bucket <> 'dead'`, which is NULL -
 * not TRUE - when inbox_bucket IS NULL, and PostgREST keeps only rows where the
 * predicate is TRUE. So every unclassified thread was silently dropped from
 * New Replies, Waiting and Cold.
 *
 * MEASURED IN PRODUCTION 2026-09-10:
 *   inbox_bucket IS NULL          8,688 of 9,776 threads
 *   NULL bucket + inbound last      321 threads   <- invisible seller replies
 *   New Replies visible rows        281 before  ->  601 after
 * Still true 2026-09-14: NULL on 9,082 of 9,778.
 *
 * UPDATED 2026-09-14 (INBOX-COMPOSER-LOCK-1). The list no longer hand-writes
 * PostgREST exclusion strings: v_inbox_thread_state_buckets DERIVES the bucket
 * (a NULL bucket becomes new_replies / cold / follow_up / dead / suppressed by
 * the same CASE canonical_inbox_threads uses), so there is no NULL left for an
 * exclusion to mishandle. These tests therefore assert the INVARIANT -- an
 * unclassified thread with a seller reply is visible in New Replies -- against
 * the live predicate, rather than asserting on the source text of a filter
 * builder that no longer exists. applyQueryFilter survives as the degraded path
 * when the flag source is unavailable, and its null-safety is still pinned.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveInboxBucketFlags, resolveDerivedInboxBucket } from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";

const SRC = fs.readFileSync(
  new URL("../../src/lib/domain/inbox/live-inbox-service.js", import.meta.url),
  "utf8",
);

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

test("an UNCLASSIFIED thread with a seller reply is a New Reply, not nothing", () => {
  // The exact 321 threads from the incident: inbox_bucket IS NULL, last message
  // inbound. They must be visible in an operational tab.
  const flags = resolveInboxBucketFlags(
    {
      thread_key: "+15550000001",
      inbox_bucket: null,
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(2),
      latest_message_at: hoursAgo(2),
    },
    NOW,
  );
  assert.equal(flags.in_new_replies, true);
  assert.equal(flags.in_dead, false, "unclassified is not dead");
  assert.equal(flags.in_suppressed, false, "unclassified is not suppressed");
});

test("an UNCLASSIFIED outbound-only thread is Cold, not nothing", () => {
  const flags = resolveInboxBucketFlags(
    {
      thread_key: "+15550000002",
      inbox_bucket: null,
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(48),
      latest_message_at: hoursAgo(48),
    },
    NOW,
  );
  assert.equal(flags.in_cold, true);
});

test("an UNCLASSIFIED thread sent to within 24h is Waiting, not nothing", () => {
  const flags = resolveInboxBucketFlags(
    {
      thread_key: "+15550000003",
      inbox_bucket: null,
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      latest_message_at: hoursAgo(2),
    },
    NOW,
  );
  assert.equal(flags.in_waiting, true);
});

test("a NULL bucket is DERIVED, never treated as an exclusion problem", () => {
  // This is why the null-safety class of bug cannot recur on the live path:
  // there is no NULL bucket by the time any predicate looks at it.
  assert.equal(resolveDerivedInboxBucket({ inbox_bucket: null, latest_direction: "inbound" }), "new_replies");
  assert.equal(resolveDerivedInboxBucket({ inbox_bucket: null, latest_direction: "outbound" }), "cold");
  assert.equal(resolveDerivedInboxBucket({ inbox_bucket: null }), "cold");
  assert.notEqual(resolveDerivedInboxBucket({ inbox_bucket: null, latest_direction: "inbound" }), "dead");
});

test("the DEGRADED filter is still null-safe and still names the right column", () => {
  // applyQueryFilter runs against the fallback sources when the flag source is
  // unavailable. Both defects it was fixed for still apply to it.
  const sibling = SRC.slice(SRC.indexOf("function applyQueryFilter"), SRC.indexOf("function applyQueryFilter") + 4500);
  assert.ok(sibling.length > 100, "applyQueryFilter must still exist as the degraded path");

  // These two names are NOT interchangeable (information_schema, 2026-09-10):
  //   inbox_thread_state       -> latest_direction          (no latest_message_direction)
  //   canonical_inbox_threads  -> latest_message_direction  (no latest_direction)
  // Naming the wrong one does not mis-filter, it fails the WHOLE PostgREST
  // query on an unknown column, so the tab returns nothing at all.
  assert.ok(
    !/latest_message_direction\.eq\./.test(sibling) && !/latest_direction\.eq\./.test(sibling),
    "applyQueryFilter must use sourceConfig.directionColumn, not a hardcoded column",
  );
  assert.ok(sibling.includes("sourceConfig?.directionColumn"), "it must read the column from the source config");
  assert.ok(sibling.includes("bucketNotIn("), "and its exclusions must be null-safe");
  const bare = sibling.match(/inbox_bucket\.neq\.\w+/g) || [];
  assert.deepEqual(bare, [], `bucket exclusions must go through bucketNotIn(); found bare: ${bare.join(", ")}`);
});

test("bucketNotIn emits a null-safe PostgREST group", () => {
  const m = SRC.match(/function bucketNotIn\([\s\S]*?\n\}/);
  assert.ok(m, "bucketNotIn helper must exist");
  const fn = new Function(`${m[0]}; return bucketNotIn;`)();
  assert.equal(
    fn("dead", "suppressed"),
    "or(inbox_bucket.is.null,and(inbox_bucket.neq.dead,inbox_bucket.neq.suppressed))",
  );
  assert.equal(fn("dead"), "or(inbox_bucket.is.null,and(inbox_bucket.neq.dead))");
});
