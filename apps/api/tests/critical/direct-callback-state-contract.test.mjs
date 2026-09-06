/**
 * direct-callback-state-contract.test.mjs
 *
 * A ratchet over callback-originated provider state.
 *
 * The Slice 1 analogue is DIRECT_PROVIDER_BYPASS: there, the question was "who
 * can put a message in front of a seller". Here it is "who can change what we
 * believe the provider did". Both must have exactly one answer.
 *
 * This file MEASURES the remaining bypass rather than asserting it is already
 * zero. Pinning an aspirational zero would either fail forever or tempt someone
 * to weaken the check; pinning the real number makes the gap visible and makes
 * any NEW bypass fail loudly.
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

test("DIRECT_CALLBACK_STATE_BYPASS is exactly the known legacy SID stamp", () => {
  // The one place a callback can still bind a provider SID outside canonical
  // authority: the legacy RPC coalesces the incoming SID onto an unbound queue
  // row.
  //
  //   textgrid_message_id = coalesce(v_queue.textgrid_message_id, p_provider_message_sid)
  //
  // It is NOT merely cosmetic projection, which is why it is measured rather
  // than deleted in passing: find-recent-outbound-pair and
  // enrich-message-event-context both correlate INBOUND seller replies on
  // textgrid_message_id. Removing the stamp without replacing that correlation
  // would degrade reply attribution, so fencing it needs its own migration and
  // its own proof.
  const migrations = walk(path.join(ROOT, "supabase/migrations"), ".sql");
  const stamps = migrations
    .filter((f) => /coalesce\(\s*v_queue\.textgrid_message_id\s*,\s*p_provider_message_sid\s*\)/i
      .test(fs.readFileSync(f, "utf8")))
    .map((f) => path.basename(f))
    .sort();

  // It appears in TWO files: the original and the later CREATE OR REPLACE that
  // supersedes it. 20260701193000 is the LIVE definition; 20260624230000 is
  // historical and no longer the installed body. Both are pinned so a third
  // occurrence -- a new migration reintroducing the stamp -- fails here.
  assert.deepEqual(stamps, [
    "20260624230000_atomic_delivery_receipt_reconciliation.sql",
    "20260701193000_restore_delivery_receipt_rpc.sql",
  ], "the unfenced SID stamp must remain confined to the two known migrations");
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
