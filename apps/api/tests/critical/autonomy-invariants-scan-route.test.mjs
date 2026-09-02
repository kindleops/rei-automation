import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleAutonomyInvariantsScanRequest,
  clampPositiveInt,
} from "@/app/api/internal/ops/autonomy-invariants-scan/route.js";
import { INVARIANT_CODES } from "@/lib/domain/seller-flow/autonomy-invariants.js";

// The read-only §18 watchdog route. Proves: auth is enforced; an unconfigured
// client never reads as clean; the report is machine-readable; fatal findings
// set fail_closed; read errors degrade the report instead of hiding it; the
// route performs NO writes.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100777";
const authOk = () => ({ ok: true });
const authNo = () => ({ ok: false, error: "unauthorized", status: 401 });
const req = (qs = "") => new Request(`http://localhost/api/internal/ops/autonomy-invariants-scan${qs}`);

// Read-only Supabase stub: every write method throws so a write would fail loudly.
function makeSupabase(tables = {}, { failTable = null } = {}) {
  const writes = [];
  return {
    _writes: writes,
    from(name) {
      const rows = tables[name] || [];
      const q = {
        select: () => q,
        gte: () => q, in: () => q, eq: () => q, order: () => q, or: () => q,
        limit: async () => (failTable === name ? { data: null, error: { message: `${name} unavailable` } } : { data: rows, error: null }),
        insert: () => { writes.push(name); throw new Error("read-only scan must not write"); },
        update: () => { writes.push(name); throw new Error("read-only scan must not write"); },
        upsert: () => { writes.push(name); throw new Error("read-only scan must not write"); },
        delete: () => { writes.push(name); throw new Error("read-only scan must not write"); },
      };
      return q;
    },
  };
}

test("clampPositiveInt bounds window and row limits", () => {
  assert.equal(clampPositiveInt("abc", 72, 720), 72);
  assert.equal(clampPositiveInt("-5", 72, 720), 72);
  assert.equal(clampPositiveInt("99999", 72, 720), 720);
  assert.equal(clampPositiveInt("0.4", 72, 720), 1);
  assert.equal(clampPositiveInt("48", 72, 720), 48);
});

test("unauthorized requests are rejected before any read", async () => {
  const supabase = makeSupabase();
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authNo, supabase });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("an unconfigured client never reads as clean", async () => {
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authOk, resolveSupabase: async () => null });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.scanned, false);
  assert.equal(body.reason, "supabase_unconfigured");
});

test("a clean estate reports ok with zero violations and performs no writes", async () => {
  const supabase = makeSupabase({
    acquisition_opportunities: [{ id: OPP, primary_thread_key: THREAD, primary_property_id: "prop-1", acquisition_stage: "offer", next_action: "generate_offer" }],
    seller_offers: [{ offer_id: `offer:${OPP}:v1`, opportunity_id: OPP, status: "accepted", direction: "outbound", purchase_price: 250000, accepted_price: 250000, authorized_ceiling: 260000, ade_snapshot_id: "ade:1", metadata: {} }],
    closing_cases: [{ closing_case_id: `closing:${OPP}`, opportunity_id: OPP, offer_id: `offer:${OPP}:v1`, seller_contract_price: 250000 }],
    send_queue: [],
  });
  const res = await handleAutonomyInvariantsScanRequest(req("?window_hours=24"), { requireInternalSecret: authOk, supabase, now: () => Date.parse("2026-09-01T12:00:00Z") });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.scanned, true);
  assert.equal(body.summary.total, 0);
  assert.equal(body.summary.fail_closed, false);
  assert.equal(body.window_hours, 24);
  assert.deepEqual(supabase._writes, []);
});

test("fatal violations set fail_closed and are listed separately", async () => {
  const supabase = makeSupabase({
    seller_offers: [{ offer_id: `offer:${OPP}:v1`, opportunity_id: OPP, status: "active", direction: "outbound", purchase_price: 300000, authorized_ceiling: 260000, ade_snapshot_id: "ade:1", metadata: {} }],
  });
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authOk, supabase });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.summary.fail_closed, true);
  assert.ok(body.fatal.some((v) => v.code === INVARIANT_CODES.OFFER_EXCEEDS_CEILING));
  assert.ok(body.violations.length >= body.fatal.length);
  assert.deepEqual(supabase._writes, []);
});

test("a table read error degrades the report instead of hiding it", async () => {
  const supabase = makeSupabase({ seller_offers: [] }, { failTable: "closing_cases" });
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authOk, supabase });
  const body = await res.json();
  assert.equal(body.ok, false, "a read error must not read as clean");
  assert.ok(body.read_errors.closing_cases);
  assert.equal(body.scanned, true);
});

test("the report is machine-readable: version, counts, summary by code", async () => {
  const supabase = makeSupabase({
    acquisition_opportunities: [{ id: OPP, primary_thread_key: THREAD, acquisition_stage: "offer", next_action: null }],
  });
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authOk, supabase });
  const body = await res.json();
  assert.ok(body.version);
  // counts are keyed by the evaluator window names, not raw table names
  assert.equal(typeof body.counts.opportunities, "number");
  assert.equal(body.summary.by_code[INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION], 1);
  assert.equal(body.summary.fail_closed, false, "a missing next action is an error, not fatal");
});


test("the scan loads suppressed/archived thread states so terminal threads are not reported as dead ends", async () => {
  const supabase = makeSupabase({
    acquisition_opportunities: [
      { id: OPP, primary_thread_key: THREAD, acquisition_stage: "offer", next_action: null },
    ],
    inbox_thread_state: [{ thread_key: THREAD, is_suppressed: true }],
  });
  const res = await handleAutonomyInvariantsScanRequest(req(), { requireInternalSecret: authOk, supabase });
  const body = await res.json();
  assert.equal(typeof body.counts.thread_states, "number");
  assert.equal(body.summary.by_code[INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION], undefined, "suppressed thread must be exempt");
});
