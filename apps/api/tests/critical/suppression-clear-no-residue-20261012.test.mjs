/**
 * An operator suppression clear leaves NO 'suppressed' residue (2026-10-12).
 * Releasing the false opt-out on d4b295dd took separate hand writes: the
 * thread tuple, the sms_suppression_list row, the message's is_opt_out /
 * opt_out_keyword (send-now isHardComplianceBlocked reads the last 50), and
 * inbox_bucket / disposition / last_intent (v_inbox_thread_state_buckets
 * prefers the STORED bucket). One operator clear now does all of it, with
 * clearance provenance.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { detectSuppressionContradictions, isBindingSuppressionShape, normalizeSuppressionShape } from "@/lib/domain/lead-state/suppression-evidence.js";

const THREAD = "+16125550142";
const EVENT_ID = "d4b295dd-1fe7-4e6c-8708-313dc3c82933";

function memory(tables) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const from = (table) => {
    db[table] ||= [];
    const filters = [];
    let op = "select";
    let payload = null;
    let upsertConflict = null;
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      const rows = db[table];
      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, payload);
        return hit.map((r) => ({ ...r }));
      }
      if (op === "upsert") {
        const key = upsertConflict;
        const existing = rows.find((r) => r[key] === payload[key]);
        if (existing) Object.assign(existing, payload); else rows.push({ ...payload });
        return [{ ...(existing || payload) }];
      }
      if (op === "insert") { const list = Array.isArray(payload) ? payload : [payload]; for (const r of list) rows.push({ id: `id-${rows.length + 1}`, ...r }); return list; }
      return rows.filter(match).map((r) => ({ ...r }));
    };
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      neq: (c, v) => { filters.push((r) => r[c] !== v); return q; },
      in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
      is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: () => q, or: () => q, order: () => q, limit: () => q, range: () => q, gte: () => q, lte: () => q, gt: () => q, lt: () => q,
      update: (p) => { op = "update"; payload = p; return q; },
      upsert: (p, o = {}) => { op = "upsert"; payload = p; upsertConflict = o.onConflict || "id"; return q; },
      insert: (p) => { op = "insert"; payload = p; return q; },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return q;
  };
  return { db, from, rpc: async () => ({ data: null, error: null }) };
}

const SUPPRESSED_THREAD = {
  thread_key: THREAD, canonical_e164: THREAD, is_suppressed: true, contactability_status: "opted_out",
  suppressed_at: "2026-10-12T21:31:40.000Z", inbox_bucket: "suppressed", disposition: "suppressed", last_intent: "opt_out",
};

test("an operator clear leaves no 'suppressed' residue in any field — thread, list row, or the named message", async () => {
  const store = memory({
    inbox_thread_state: [SUPPRESSED_THREAD],
    sms_suppression_list: [
      { id: "sup-1", phone_e164: THREAD, is_active: true, source: "inbound_opt_out", suppression_reason: "opt_out" },
      { id: "sup-other", phone_e164: "+16125559999", is_active: true, source: "inbound_opt_out" },
    ],
    message_events: [{ id: EVENT_ID, is_opt_out: true, opt_out_keyword: "STOP IT.... MAKE A TRUE OFFER OR STOP TE", detected_intent: "opt_out", metadata: { source: "textgrid_inbound_webhook" } }],
  });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "contactable" },
    supabase: store,
    meta: {
      change_source: "manual",
      operator_id: "operator:ryan",
      reason: "false opt-out: conditional ultimatum",
      suppression_clearance: { type: "operator_release", actor: "operator:ryan", source_event_id: EVENT_ID },
    },
  });
  assert.notEqual(result.blocked, true, JSON.stringify(result));

  const row = store.db.inbox_thread_state.find((r) => r.thread_key === THREAD);
  assert.equal(row.is_suppressed, false);
  assert.equal(row.contactability_status, "contactable");
  assert.equal(row.suppressed_at, null);
  assert.equal(row.inbox_bucket, null, "stored bucket reset: the view derives it");
  assert.equal(row.disposition, null);
  assert.equal(row.last_intent, null);
  assert.equal(isBindingSuppressionShape(normalizeSuppressionShape(row)), false);
  assert.deepEqual(detectSuppressionContradictions(row), []);
  for (const field of ["inbox_bucket", "disposition", "contactability_status", "last_intent"]) {
    assert.doesNotMatch(String(row[field] ?? ""), /suppressed|opt_out|opted_out/, field);
  }

  assert.equal(store.db.sms_suppression_list.find((r) => r.id === "sup-1").is_active, false);
  assert.equal(store.db.sms_suppression_list.find((r) => r.id === "sup-other").is_active, true, "another phone is untouched");

  const event = store.db.message_events.find((r) => r.id === EVENT_ID);
  assert.equal(event.is_opt_out, false);
  assert.equal(event.opt_out_keyword, null);
  assert.equal(event.metadata.source, "textgrid_inbound_webhook", "existing metadata kept");
  assert.equal(event.metadata.suppression_clearance.actor, "operator:ryan");
  assert.equal(event.metadata.suppression_clearance.source_event_id, EVENT_ID);
  assert.equal(event.metadata.suppression_clearance.prior_is_opt_out, true);

  assert.equal(result.suppression_release.ok, true);
  assert.equal(result.suppression_release.suppression_list_released, 1);
  assert.equal(result.suppression_release.message_event_cleared, true);
});

test("an automated (non-operator) write clears nothing, anywhere", async () => {
  const store = memory({
    inbox_thread_state: [SUPPRESSED_THREAD],
    sms_suppression_list: [{ id: "sup-1", phone_e164: THREAD, is_active: true }],
    message_events: [{ id: EVENT_ID, is_opt_out: true, opt_out_keyword: "STOP", metadata: {} }],
  });
  await patchUniversalLeadState({ threadKey: THREAD, patch: { contactability_status: "contactable" }, supabase: store, meta: { change_source: "automation" } });
  const row = store.db.inbox_thread_state.find((r) => r.thread_key === THREAD);
  assert.equal(row.is_suppressed, true);
  assert.equal(row.inbox_bucket, "suppressed");
  assert.equal(store.db.sms_suppression_list[0].is_active, true);
  assert.equal(store.db.message_events[0].is_opt_out, true);
});
