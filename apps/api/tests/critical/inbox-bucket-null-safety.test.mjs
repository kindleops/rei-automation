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
 *
 * A NULL bucket means "not yet classified". That is not dead and not
 * suppressed, so an exclusion filter must INCLUDE it.
 *
 * Second defect fixed here: the Cold branch filtered on
 * `latest_message_direction`, which does not exist on inbox_thread_state.
 * PostgREST fails the ENTIRE query on one unknown column, so Cold was not
 * under-filtered, it was hard-erroring.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SRC = fs.readFileSync(
  new URL("../../src/lib/domain/inbox/live-inbox-service.js", import.meta.url),
  "utf8",
);

// The filter builder is module-private, so assert on the emitted predicate text
// -- that string IS the contract with PostgREST.
const filterBody = SRC.slice(
  SRC.indexOf("function applyInboxThreadStateBucketFilter"),
  SRC.indexOf("function applyInboxThreadStateBucketFilter") + 4000,
);

test("no bucket exclusion survives in the NULL-unsafe bare form", () => {
  // Every exclusion must be produced by bucketNotIn, never hand-written as a
  // bare `inbox_bucket.neq.x,inbox_bucket.neq.y` pair inside an and(...).
  const bare = filterBody.match(/inbox_bucket\.neq\.\w+/g) || [];
  assert.deepEqual(
    bare, [],
    `bucket exclusions must go through bucketNotIn(); found bare: ${bare.join(", ")}`,
  );
  assert.ok(filterBody.includes("bucketNotIn("), "sanity: exclusions still exist, via the helper");
});

test("each filter uses the direction column that EXISTS on its own relation", () => {
  // These two names are NOT interchangeable (information_schema, 2026-09-10):
  //   inbox_thread_state       -> latest_direction          (no latest_message_direction)
  //   canonical_inbox_threads  -> latest_message_direction  (no latest_direction)
  //   inbox_threads_view       -> latest_message_direction
  // Naming the wrong one does not mis-filter, it fails the WHOLE PostgREST
  // query on an unknown column, so the tab returns nothing at all.

  // The inbox_thread_state filter must name latest_direction, never the other.
  assert.ok(
    !/latest_message_direction\.eq\./.test(filterBody),
    "applyInboxThreadStateBucketFilter queries inbox_thread_state, which has no latest_message_direction",
  );
  assert.ok(/latest_direction\.eq\./.test(filterBody), "it must use latest_direction");

  // The fallback filter must not hardcode a column at all - it takes the one
  // from its source config.
  const sibling = SRC.slice(SRC.indexOf("function applyQueryFilter"), SRC.indexOf("function applyQueryFilter") + 4500);
  assert.ok(
    !/latest_message_direction\.eq\./.test(sibling) && !/latest_direction\.eq\./.test(sibling),
    "applyQueryFilter must use sourceConfig.directionColumn, not a hardcoded column",
  );
  assert.ok(sibling.includes("sourceConfig?.directionColumn"), "it must read the column from the source config");
  assert.ok(sibling.includes("bucketNotIn("), "and its exclusions must be null-safe too");
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

test("new_replies, waiting and cold all use the null-safe form", () => {
  const newReplies = filterBody.slice(filterBody.indexOf('case "new_replies"'), filterBody.indexOf('case "needs_review"'));
  assert.ok(newReplies.includes("bucketNotIn("), "new_replies must be null-safe");
  const waiting = filterBody.slice(filterBody.indexOf('case "waiting"'), filterBody.indexOf('case "active"'));
  assert.ok(waiting.includes("bucketNotIn("), "waiting must be null-safe");
});
