/**
 * direct-callback-state-contract.test.mjs
 *
 * A ratchet over callback-originated provider state.
 *
 * The Slice 1 analogue is DIRECT_PROVIDER_BYPASS: there, the question was "who
 * can put a message in front of a seller". Here it is "who can change what we
 * believe the provider did". Both must have exactly one answer.
 *
  * A note on what turned out NOT to be a bypass. The legacy RPC's
 * `coalesce(v_queue.textgrid_message_id, p_provider_message_sid)` was carried for
 * several passes as an orphan-SID-adoption path. Verified against the real
 * production RPC, it is not: the row must already carry that exact SID to be
 * selected, so the coalesce is a same-row backfill. The dangerous property lives
 * in the WHERE clause, and that is what is pinned below -- widening the selection
 * to correlate on recipient or time is what would create the bypass.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function walk(dir, ext, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, acc);
    else if (e.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}
const rel = (f) => path.relative(SRC, f);
const code = (f) => fs.readFileSync(f, "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
  .join("\n");

// ── the single application chokepoint ─────────────────────────────────────

test("syncDeliveryEvent is the only module invoking the legacy delivery RPC", () => {
  const callers = walk(SRC, ".js")
    .filter((f) => /rpc\(\s*["']reconcile_delivery_receipt["']/.test(code(f)))
    .map(rel)
    .sort();
  assert.deepEqual(callers, ["lib/supabase/sms-engine.js"],
    "a second RPC caller would be a second callback-state authority");
});

test("every lane that reaches syncDeliveryEvent declares a provenance", () => {
  // Detected by IMPORT, not by call-name: the webhook processor calls it through
  // a `syncFn` indirection, so a call-name regex silently matched nothing and
  // made this assertion vacuous.
  const lanes = walk(SRC, ".js")
    .filter((f) => rel(f) !== "lib/supabase/sms-engine.js")
    .filter((f) => /syncDeliveryEvent/.test(code(f)))
    .filter((f) => /from ['"]@\/lib\/supabase\/sms-engine\.js['"]/.test(code(f))
                || /syncDeliveryEvent\s*\(/.test(code(f)));

  const undeclared = lanes.filter((f) => !/evidence_provenance:/.test(code(f))).map(rel);
  assert.deepEqual(undeclared, [],
    `these reach syncDeliveryEvent without declaring a lane; they would normalize ` +
    `to UNDECLARED and be denied canonical authority -- safe, but silent`);
  assert.ok(lanes.length >= 2, `expected the live/recovery/polling lanes, found ${lanes.length}`);
});

test("canonical truth is gated on provenance, not on reaching the function", () => {
  const engine = code(path.join(SRC, "lib/supabase/sms-engine.js"));
  assert.match(engine, /mayAdvanceCanonicalTruth\(evidence_provenance\)/);
  // The gate must precede the legacy projection, or the projection would be the
  // de facto authority again.
  assert.ok(
    engine.indexOf("mayAdvanceCanonicalTruth") < engine.indexOf("reconcileDeliveryReceiptViaRpc"),
    "canonical reconciliation must run before the legacy projection");
});

// ── the measured, remaining bypass ────────────────────────────────────────

test("the legacy SID coalesce cannot adopt an orphan, by construction", () => {
  // CORRECTED FINDING. This was carried for several passes as "a callback can
  // stamp a SID onto an unbound queue row". It cannot, and the reason is the
  // row SELECTION, not the assignment:
  //
  //   FOR v_queue IN SELECT * FROM public.send_queue
  //     WHERE provider_message_id = p_provider_message_sid
  //        OR textgrid_message_id  = p_provider_message_sid
  //
  // A row must ALREADY carry that exact SID to be selected at all, so the
  // coalesce can only copy the SID from provider_message_id onto the sibling
  // textgrid_message_id ON A ROW ALREADY BOUND TO IT. An orphan row -- no SID in
  // either column -- is never in the loop.
  //
  // Proven against the REAL production RPC in a rolled-back transaction:
  //   unbound row -> textgrid_message_id NULL, provider_message_id NULL, untouched
  //   bound row   -> textgrid_message_id = provider_message_id (same-row backfill)
  //   send_queue_updated = 1
  //
  // The property therefore lives in the WHERE clause. If someone widens that
  // selection -- matching on to/from, or on a time window -- the coalesce WOULD
  // become an adoption path. That is what this test guards.
  const f = path.join(ROOT, "supabase/migrations/20260701193000_restore_delivery_receipt_rpc.sql");
  const sql = fs.readFileSync(f, "utf8");

  const loop = sql.slice(sql.indexOf("FOR v_queue IN"), sql.indexOf("LOOP", sql.indexOf("FOR v_queue IN")));
  assert.match(loop, /provider_message_id\s*=\s*p_provider_message_sid/,
    "selection must require the row to already carry the SID");
  assert.match(loop, /textgrid_message_id\s*=\s*p_provider_message_sid/,
    "selection must require the row to already carry the SID");

  // No correlation predicate may creep into the selection: matching on
  // recipient or time is what would turn a backfill into an adoption.
  for (const widening of ["to_phone_number", "from_phone_number", "scheduled_for", "created_at"]) {
    assert.ok(!loop.includes(widening),
      `the queue selection must not correlate on ${widening}; that would make the ` +
      `coalesce an orphan-adoption path`);
  }

  // And the write stays scoped to the selected row.
  assert.match(sql, /WHERE id = v_queue\.id/,
    "the update must remain scoped to the row that matched the SID");
});


test("no APPLICATION module binds a provider SID outside the canonical store", () => {
  // The database-side stamp is measured above. On the application side the
  // answer must already be zero: only the §11 store may write an attempt SID.
  // Scoped to the ATTEMPT TABLE. The previous spelling matched any object
  // literal with a provider_message_id key and so flagged four benign sites: an
  // outbound send_queue projection, two function arguments, and an adapter
  // return value. None of them binds an attempt SID.
  const offenders = walk(SRC, ".js")
    .filter((f) => !rel(f).startsWith("lib/domain/communications/"))
    .filter((f) => {
      const c = code(f);
      if (!/seller_communication_attempts/.test(c)) return false;
      return /\.update\(|\.insert\(|\.upsert\(/.test(c);
    })
    .map(rel);
  assert.deepEqual(offenders, [],
    `only the canonical store may write seller_communication_attempts:\n  ${offenders.join("\n  ")}`);
});

test("no module outside the seam writes the callback ledger", () => {
  const writers = walk(SRC, ".js")
    .filter((f) => !rel(f).startsWith("lib/domain/communications/"))
    .filter((f) => /seller_provider_callback_events/.test(code(f)))
    .map(rel);
  assert.deepEqual(writers, [],
    "callback evidence may only be recorded by the canonical seam");
});
