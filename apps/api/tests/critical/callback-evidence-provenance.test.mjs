/**
 * callback-evidence-provenance.test.mjs
 *
 * Three lanes reach syncDeliveryEvent. They are NOT the same kind of evidence,
 * and the whole point of this file is that the code never forgets that.
 *
 *   live receipt      the provider pushed it to us, once, just now
 *   recovery replay   we are re-reading something we already stored
 *   poll observation  WE asked; nothing was pushed to us
 *
 * A poll answer recorded as a receipt would make the ledger claim a webhook
 * arrived when none did. A replay promoted to "authenticated" would launder an
 * unverified claim through a trusted worker.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_PROVENANCE,
  mayRecordAsCallbackReceipt,
  mayAdvanceCanonicalTruth,
  normalizeProvenance,
  trustForReplay,
} from "@/lib/domain/communications/callback-evidence-provenance.js";
import { TRUST_CLASS } from "@/lib/domain/communications/reconcile-provider-callback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

// ── the core distinction ──────────────────────────────────────────────────

test("only pushed evidence may become a callback receipt", () => {
  assert.equal(mayRecordAsCallbackReceipt(EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT), true);
  assert.equal(mayRecordAsCallbackReceipt(EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY), true);

  // We asked them. Nothing was pushed. It is not a receipt.
  assert.equal(mayRecordAsCallbackReceipt(EVIDENCE_PROVENANCE.PROVIDER_POLL_OBSERVATION), false);
  assert.equal(mayRecordAsCallbackReceipt(EVIDENCE_PROVENANCE.INTERNAL_PROBE), false);
});

test("a poll observation may NOT advance canonical provider truth", () => {
  // TextGrid's status-lookup-by-SID has never been verified as authoritative in
  // this repository, so treating a poll answer as truth would be inventing
  // provider semantics.
  assert.equal(mayAdvanceCanonicalTruth(EVIDENCE_PROVENANCE.PROVIDER_POLL_OBSERVATION), false);
  assert.equal(mayAdvanceCanonicalTruth(EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT), true);
  assert.equal(mayAdvanceCanonicalTruth(EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY), true);
});

test("an undeclared lane is treated as the most restrictive case", () => {
  // A lane that forgets to declare itself must not inherit receipt authority.
  assert.equal(normalizeProvenance(undefined), EVIDENCE_PROVENANCE.UNDECLARED);
  assert.equal(normalizeProvenance("something_new"), EVIDENCE_PROVENANCE.UNDECLARED);
  assert.equal(mayAdvanceCanonicalTruth(EVIDENCE_PROVENANCE.UNDECLARED), false);
  assert.equal(mayRecordAsCallbackReceipt(EVIDENCE_PROVENANCE.UNDECLARED), false);
});

// ── provenance is not trust ───────────────────────────────────────────────

test("a replay preserves the ORIGINAL receipt trust", () => {
  // The worker is trusted; the original claim is not. Replaying an
  // unauthenticated receipt through an internal worker authenticates nothing.
  assert.equal(trustForReplay(TRUST_CLASS.UNAUTHENTICATED), TRUST_CLASS.UNAUTHENTICATED);
  assert.equal(trustForReplay(TRUST_CLASS.AUTHENTICATED), TRUST_CLASS.AUTHENTICATED);
});

test("provenance values and trust values are disjoint vocabularies", () => {
  // If one leaked into the other's slot it would typecheck and be wrong, so
  // keep the sets provably non-overlapping.
  const provenance = new Set(Object.values(EVIDENCE_PROVENANCE));
  for (const trust of Object.values(TRUST_CLASS)) {
    assert.ok(!provenance.has(trust), `${trust} must not double as a provenance`);
  }
});

// ── the wiring itself ─────────────────────────────────────────────────────

test("each lane declares its own provenance at the call site", () => {
  const processor = read("lib/domain/webhooks/webhook-event-processor.js");
  assert.match(processor, /EVIDENCE_PROVENANCE\.LIVE_PROVIDER_RECEIPT/,
    "the live webhook lane must declare a live receipt");
  assert.match(processor, /EVIDENCE_PROVENANCE\.RECORDED_CALLBACK_REPLAY/,
    "the recovery lane must declare a replay, not a new receipt");

  const polling = read("lib/domain/delivery/delivery-polling-fallback.js");
  assert.match(polling, /EVIDENCE_PROVENANCE\.PROVIDER_POLL_OBSERVATION/,
    "the polling lane must declare an observation");
  assert.ok(!/LIVE_PROVIDER_RECEIPT/.test(polling),
    "polling must never claim to be a live receipt");
});

test("syncDeliveryEvent gates canonical truth on provenance", () => {
  const engine = read("lib/supabase/sms-engine.js");
  assert.match(engine, /mayAdvanceCanonicalTruth\(evidence_provenance\)/,
    "canonical reconciliation must be gated by provenance");
  assert.match(engine, /reconcileProviderCallback/,
    "syncDeliveryEvent must reach the canonical seam");
});

test("a canonical reconciliation failure cannot read as a transport failure", () => {
  // If reconciliation threw and propagated, a caller could mistake it for a
  // delivery problem -- the one reading that could justify a resend.
  const engine = read("lib/supabase/sms-engine.js");
  assert.match(engine, /callback\.canonical_reconciliation_failed/,
    "a reconciliation throw must be caught and recorded, not propagated");
});

// ── polling posture ───────────────────────────────────────────────────────

test("provider polling is explicit opt-in, never a default", () => {
  // Audit result: pollMissingDeliveryCallbacks has exactly ONE caller (this
  // route), and this route has exactly ONE production caller (the */5 cron),
  // which already passes false. The old `!== false` default therefore protected
  // nobody and armed every other caller.
  const route = read("app/api/internal/webhooks/recover-delivery/route.js");
  assert.match(route, /include_polling_fallback === true/,
    "polling must require explicit opt-in");
  assert.ok(!/include_polling_fallback !== false/.test(route),
    "the opt-out default must not come back");
});

test("polling has exactly one caller, and it is the audited route", () => {
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (e.name.endsWith(".js")) acc.push(full);
    }
    return acc;
  };
  const callers = walk(SRC)
    .filter((f) => /pollMissingDeliveryCallbacks/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f))
    .filter((r) => r !== "lib/domain/delivery/delivery-polling-fallback.js")
    .sort();
  assert.deepEqual(callers, ["app/api/internal/webhooks/recover-delivery/route.js"],
    "a new polling caller must be reviewed against the observation-not-receipt rule");
});
