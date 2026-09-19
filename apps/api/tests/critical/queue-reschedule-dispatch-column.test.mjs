/**
 * RESCHEDULE MUST MOVE THE COLUMN THE DISPATCHER READS (§4).
 *
 * The Queue's reschedule action wrote only `scheduled_for`. The preclaim gate
 * resolves a row's due time as `scheduled_for_utc || scheduled_for ||
 * created_at`, so `scheduled_for_utc` WINS — and leaving it stale meant
 * rescheduling a queue row had NO EFFECT on when it dispatched. The operator
 * moved a message, the Queue showed the new time, and the dispatcher kept
 * using the old one.
 *
 * Found by an actual reschedule during canary certification: the row came back
 * with `scheduled_for` due and `scheduled_for_utc` four hours out, and the
 * claim refused it as `scheduled_for_in_future`.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("THE PRECLAIM READS scheduled_for_utc IN PREFERENCE", async () => {
  // This is the fact that made the partial write a silent no-op.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/supabase/sms-engine.js", import.meta.url), "utf8");
  assert.match(
    source,
    /scheduled_ts\s*=\s*toTimestamp\(\s*normalized\.scheduled_for_utc\s*\|\|\s*normalized\.scheduled_for/,
  );
});

test("the reschedule action writes BOTH schedule columns", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/cockpit/cockpit-service.js", import.meta.url), "utf8");

  const block = source.slice(
    source.indexOf("if (action === 'reschedule')"),
    source.indexOf("if (action === 'reschedule')") + 1400,
  );
  assert.match(block, /patch\.scheduled_for\s*=\s*scheduledFor/);
  assert.match(block, /patch\.scheduled_for_utc\s*=\s*scheduledFor/,
    "rescheduling must move the column the dispatcher actually reads");
  assert.match(block, /patch\.scheduled_for_local\s*=\s*scheduledFor/);
});

test("a row cannot hold two different answers to 'when does this send'", async () => {
  /**
   * The failure was not that the write was wrong — it was that the row ended
   * up INTERNALLY INCONSISTENT, showing one time and obeying another. Writing
   * all three together is what makes that state unrepresentable.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/cockpit/cockpit-service.js", import.meta.url), "utf8");
  const block = source.slice(
    source.indexOf("if (action === 'reschedule')"),
    source.indexOf("if (action === 'reschedule')") + 1400,
  );
  const assignments = block.match(/patch\.scheduled_for\w*\s*=/g) || [];
  assert.equal(assignments.length, 3, `expected all three schedule columns written, saw ${assignments.length}`);
});
