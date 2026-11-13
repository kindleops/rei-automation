import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractOutboundDollarAmounts,
  evaluateManualOfferAuthority,
  buildManualOfferBounds,
  validateManualOfferOverride,
  resolveManualOfferGuardMode,
  runManualOfferGuard,
  manualOfferOverrideProvenance,
  MANUAL_OFFER_GUARD_MODE_KEY,
  MANUAL_OFFER_VIOLATIONS as V,
} from "@/lib/domain/inbox/manual-offer-guard.js";
import { createInboxSendNowQueueRow, executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";

// P0 2026-10-16: the Hartford $315K went out from the inbox composer on a
// property whose authorized ceiling was $126.1K. These fixtures are the prod
// Decision Engine row for property 225438557 (read-only, 2026-10-16), no PII.
const HARTFORD_PROPERTY = "225438557";
const HARTFORD_SCORE = {
  property_id: HARTFORD_PROPERTY,
  computed_at: "2026-09-25T16:22:10.805Z",
  decision_tier: "CREATIVE_TERMS",
  recommended_cash_offer: 106400,
  minimum_acceptable_offer: 97500,
  valuation_low: 208500,
  valuation_mid: 298100,
  valuation_high: 320300,
  valuation_confidence: 77,
  mao: "126100",
  evidence: { offer_calculation: { effective_authorized_ceiling: "126100" } },
};
const BODY_0925_A = "I’d be at around $315K, close in 10 days.";
const BODY_0925_B = "I’m good to move forward at $315,000. I can send over the purchase agreement today and get everything moving toward closing. What’s your best email?";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const OVERRIDE = { reason: "owner approved above-ceiling after walkthrough", approval_ref: "OWNER-2026-10-16-01", operator_id: "op-123" };

const modeIs = (mode) => async (key) => (key === MANUAL_OFFER_GUARD_MODE_KEY ? mode : null);
const scoreLoader = (score, calls = []) => async (args) => { calls.push(args); return score; };

// ── pure detection ─────────────────────────────────────────────────────────

test("extracts the Hartford amounts from both 09-25 composer bodies", () => {
  assert.deepEqual(extractOutboundDollarAmounts(BODY_0925_A), [315000]);
  assert.deepEqual(extractOutboundDollarAmounts(BODY_0925_B), [315000]);
});

test("extracts suffix, million and range forms; ignores EMD-sized amounts, sqft, years and phone digits", () => {
  assert.deepEqual(extractOutboundDollarAmounts("we could do 315k cash"), [315000]);
  assert.deepEqual(extractOutboundDollarAmounts("around $1.2M"), [1200000]);
  assert.deepEqual(extractOutboundDollarAmounts("you said $380K to $390K"), [380000, 390000]);
  assert.deepEqual(extractOutboundDollarAmounts("$1,500 earnest money, close in 2026"), []);
  assert.deepEqual(extractOutboundDollarAmounts("it shows 2,528 sqft and 12,000 sq ft lot"), []);
  assert.deepEqual(extractOutboundDollarAmounts("call me at 2145550199"), []);
  assert.deepEqual(extractOutboundDollarAmounts("Do you have an asking price in mind?"), []);
  assert.deepEqual(extractOutboundDollarAmounts("we can pay 120,000 as-is"), [120000]);
});

test("Hartford $315K violates the authorized ceiling (126.1K); valuation high and confidence pass", () => {
  const bounds = buildManualOfferBounds(HARTFORD_SCORE, { now: NOW });
  assert.equal(bounds.authorized_ceiling, 126100);
  assert.equal(bounds.offer_ready, false); // CREATIVE_TERMS is not offer-authoritative
  const r = evaluateManualOfferAuthority({ amounts: [315000], bounds, property_id: HARTFORD_PROPERTY });
  assert.deepEqual(r, { max_amount: 315000, violations: [V.EXCEEDS_CEILING] });
});

test("an amount within the ceiling has no violation; above valuation high and weak confidence each count", () => {
  const bounds = buildManualOfferBounds(HARTFORD_SCORE, { now: NOW });
  assert.deepEqual(evaluateManualOfferAuthority({ amounts: [120000], bounds, property_id: "p" }).violations, []);
  assert.deepEqual(
    evaluateManualOfferAuthority({ amounts: [330000], bounds, property_id: "p" }).violations,
    [V.EXCEEDS_CEILING, V.EXCEEDS_VALUATION_HIGH],
  );
  const weak = buildManualOfferBounds({ ...HARTFORD_SCORE, valuation_confidence: 30 }, { now: NOW });
  assert.deepEqual(evaluateManualOfferAuthority({ amounts: [100000], bounds: weak, property_id: "p" }).violations, [V.LOW_VALUATION_CONFIDENCE]);
  const noCeiling = buildManualOfferBounds({ ...HARTFORD_SCORE, mao: null, evidence: {} }, { now: NOW });
  assert.deepEqual(evaluateManualOfferAuthority({ amounts: [100000], bounds: noCeiling, property_id: "p" }).violations, [V.NO_CEILING]);
  assert.deepEqual(evaluateManualOfferAuthority({ amounts: [100000], bounds: null, property_id: "" }).violations, [V.NO_PROPERTY]);
  assert.deepEqual(evaluateManualOfferAuthority({ amounts: [100000], bounds: null, property_id: "p" }).violations, [V.SCORE_UNAVAILABLE]);
});

test("override must be complete; booleans are never an override", () => {
  assert.equal(validateManualOfferOverride(null).reason, "override_missing");
  assert.equal(validateManualOfferOverride(true).reason, "override_missing");
  const partial = validateManualOfferOverride({ reason: "short", approval_ref: "", operator_id: "op" });
  assert.equal(partial.reason, "override_incomplete");
  assert.deepEqual(partial.missing, ["reason", "approval_ref"]);
  assert.deepEqual(validateManualOfferOverride(OVERRIDE), { ok: true, override: OVERRIDE });
});

test("mode resolution: only 'enforce' and 'shadow' are on", () => {
  for (const raw of [null, "", "off", "live", "true", "ENFORCE ", "Shadow"]) {
    const expected = /^enforce$/i.test(String(raw ?? "").trim()) ? "enforce" : /^shadow$/i.test(String(raw ?? "").trim()) ? "shadow" : "off";
    assert.equal(resolveManualOfferGuardMode(raw), expected, String(raw));
  }
});

// ── runManualOfferGuard ────────────────────────────────────────────────────

test("OFF (absent / garbage / throwing control value): no score read, no record", async () => {
  for (const getSystemValue of [async () => null, async () => "live", async () => { throw new Error("down"); }]) {
    const calls = [];
    const r = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue, loadScoreImpl: scoreLoader(HARTFORD_SCORE, calls), now: NOW });
    assert.equal(r.decision, "off");
    assert.equal(r.record, null);
    assert.equal(calls.length, 0);
  }
});

test("ENFORCE: Hartford body is refused without an override", async () => {
  const r = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_B, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
  assert.equal(r.decision, "refused");
  assert.equal(r.override_rejection, "override_missing");
  assert.deepEqual(r.record.violations, [V.EXCEEDS_CEILING]);
  assert.equal(r.record.bounds.authorized_ceiling, 126100);
});

test("ENFORCE: generic operator_override / force booleans do not satisfy the guard", async () => {
  const r = await runManualOfferGuard({ input: { operator_override: true, force: true, offer_override: true }, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
  assert.equal(r.decision, "refused");
});

test("ENFORCE: a complete override (top-level or in metadata) is accepted and recorded", async () => {
  for (const input of [{ offer_override: OVERRIDE }, { metadata: { offer_override: OVERRIDE } }]) {
    const r = await runManualOfferGuard({ input, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
    assert.equal(r.decision, "overridden");
    assert.equal(r.warning_code, "manual_offer_override");
    assert.deepEqual(r.record.override, OVERRIDE);
    assert.equal(r.record.max_amount, 315000);
  }
});

test("ENFORCE: within authority passes; no amount is not applicable (no score read)", async () => {
  const within = await runManualOfferGuard({ input: {}, normalized: { message_body: "I could do $120,000 as-is.", property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
  assert.equal(within.decision, "within_authority");
  assert.equal(within.warning_code, undefined);
  const calls = [];
  const none = await runManualOfferGuard({ input: {}, normalized: { message_body: "Who's in this?", property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE, calls), now: NOW });
  assert.equal(none.decision, "not_applicable");
  assert.equal(calls.length, 0);
});

test("ENFORCE fails closed: score lookup error, missing score row or missing property", async () => {
  const thrown = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: async () => { throw new Error("timeout"); }, now: NOW });
  assert.equal(thrown.decision, "refused");
  assert.deepEqual(thrown.record.violations, [V.SCORE_UNAVAILABLE]);
  const missing = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(null), now: NOW });
  assert.deepEqual(missing.record.violations, [V.SCORE_UNAVAILABLE]);
  const noProp = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_A }, supabase: {}, getSystemValue: modeIs("enforce"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
  assert.deepEqual(noProp.record.violations, [V.NO_PROPERTY]);
});

test("SHADOW records the violation and never refuses", async () => {
  const r = await runManualOfferGuard({ input: {}, normalized: { message_body: BODY_0925_A, property_id: HARTFORD_PROPERTY }, supabase: {}, getSystemValue: modeIs("shadow"), loadScoreImpl: scoreLoader(HARTFORD_SCORE), now: NOW });
  assert.equal(r.decision, "shadow_flagged");
  assert.equal(r.warning_code, "manual_offer_exceeds_authority_shadow");
});

test("override provenance for a seller_offers writer only exists for an overridden send", () => {
  assert.equal(manualOfferOverrideProvenance({}), null);
  assert.equal(manualOfferOverrideProvenance({ manual_offer_guard: { decision: "refused" } }), null);
  const p = manualOfferOverrideProvenance({ manual_offer_guard: { version: "v", decision: "overridden", override: OVERRIDE, max_amount: 315000, violations: [V.EXCEEDS_CEILING], bounds: { authorized_ceiling: 126100 }, evaluated_at: "t" } });
  assert.equal(p.manual_offer_override.approval_ref, OVERRIDE.approval_ref);
  assert.equal(p.manual_offer_override.authorized_ceiling, 126100);
});

// ── send-now-service integration ───────────────────────────────────────────

const ACTIVE_FLEET_SENDER = async (phone) => ({ id: "fleet-test-sender", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 });

function harness({ mode = null, score = HARTFORD_SCORE, actionOk = true } = {}) {
  const inserted = [];
  const actions = [];
  const scoreReads = [];
  const chain = (table) => {
    const c = {
      select: () => c, eq: (k, v) => { if (table === "property_acquisition_scores") scoreReads.push(v); return c; },
      in: () => c, contains: () => c, gte: () => Promise.resolve({ count: 0, error: null }),
      maybeSingle: async () => ({ data: table === "property_acquisition_scores" ? score : null, error: null }),
    };
    return c;
  };
  const supabase = { from: (table) => chain(table) };
  const deps = {
    supabase,
    getSystemValue: async (key) => (key === MANUAL_OFFER_GUARD_MODE_KEY ? mode : null),
    loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER,
    resolveStickyThreadSenderImpl: async ({ proposed_from }) => ({ ok: true, phone: proposed_from, decision: "kept" }),
    hardComplianceCheckImpl: async () => ({ blocked: false }),
    canSendImpl: async () => ({ ok: true, reason: null }),
    checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
    recentDeliveryFailuresImpl: async () => ({ suppress: false }),
    resolveOperatorAction: async (args) => { actions.push(args); return actionOk ? { ok: true, operator_action_id: "opact-1" } : { ok: false, reason: "operator_action_store_error" }; },
    insertImpl: async (payload) => { inserted.push(payload); return { ok: true, queue_row_id: "row-1", result: { raw: payload } }; },
  };
  return { deps, inserted, actions, scoreReads };
}

const SEND_INPUT = {
  thread_key: "+15005550006",
  to_phone_number: "+15005550006",
  from_phone_number: "+15005550001",
  message_body: BODY_0925_A,
  property_id: HARTFORD_PROPERTY,
  source: "inbox",
  action: "send_now",
  client_send_id: "click-1",
  queue_key: "inbox:send_now:fixed-hartford-probe",
  template_source: "manual_composer",
};

function stableInsert(payload) {
  const { scheduled_for, scheduled_for_utc, scheduled_for_local, ...rest } = payload;
  const { transport_fingerprint, ...metadata } = rest.metadata || {};
  return { ...rest, metadata };
}

test("send-now, flag OFF: insert payload and operator action are byte-identical to the absent-guard path", async () => {
  const off = harness({ mode: null });
  const r1 = await createInboxSendNowQueueRow({ ...SEND_INPUT }, off.deps);
  const garbage = harness({ mode: "on" });
  const r2 = await createInboxSendNowQueueRow({ ...SEND_INPUT }, garbage.deps);
  const injected = harness({ mode: "enforce" });
  const r3 = await createInboxSendNowQueueRow({ ...SEND_INPUT }, { ...injected.deps, manualOfferGuardImpl: async () => ({ mode: "off", decision: "off", record: null }) });
  for (const r of [r1, r2, r3]) assert.equal(r.ok, true);
  assert.equal(off.inserted.length, 1);
  assert.equal("manual_offer_guard" in off.inserted[0].metadata, false);
  assert.deepEqual(off.inserted[0].metadata.manual_send_warning_codes, []);
  assert.deepEqual(stableInsert(off.inserted[0]), stableInsert(garbage.inserted[0]));
  assert.deepEqual(stableInsert(off.inserted[0]), stableInsert(injected.inserted[0]));
  assert.deepEqual(off.actions, garbage.actions);
  assert.equal("operator_note" in off.actions[0], false);
  assert.equal(off.scoreReads.length, 0);
});

test("send-now, ENFORCE: the Hartford 09-25 composer send is refused before any row or action exists", async () => {
  const h = harness({ mode: "enforce" });
  const r = await createInboxSendNowQueueRow({ ...SEND_INPUT, operator_override: true }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 423);
  assert.equal(r.reason, "manual_offer_exceeds_authority");
  assert.equal(r.override_required, true);
  assert.deepEqual(r.manual_offer_guard.violations, ["exceeds_authorized_ceiling"]);
  assert.equal(h.inserted.length, 0);
  assert.equal(h.actions.length, 0);
});

test("send-now, ENFORCE + override: queued with the override on the row and the operator action", async () => {
  const h = harness({ mode: "enforce" });
  const r = await createInboxSendNowQueueRow({ ...SEND_INPUT, offer_override: OVERRIDE }, h.deps);
  assert.equal(r.ok, true);
  const md = h.inserted[0].metadata;
  assert.equal(md.manual_offer_guard.decision, "overridden");
  assert.deepEqual(md.manual_offer_guard.override, OVERRIDE);
  assert.ok(md.manual_send_warning_codes.includes("manual_offer_override"));
  assert.equal(md.operator_action_id, "opact-1");
  assert.match(h.actions[0].operator_note, /manual_offer_override approval_ref=OWNER-2026-10-16-01 operator_id=op-123 max_amount=315000 violations=exceeds_authorized_ceiling/);
});

test("send-now, ENFORCE + override but the audit row cannot be written: refused", async () => {
  const h = harness({ mode: "enforce", actionOk: false });
  const r = await createInboxSendNowQueueRow({ ...SEND_INPUT, offer_override: OVERRIDE }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "manual_offer_override_not_audited");
  assert.equal(h.inserted.length, 0);
});

test("send-now, ENFORCE: within-authority amount queues with a within_authority record", async () => {
  const h = harness({ mode: "enforce" });
  const r = await createInboxSendNowQueueRow({ ...SEND_INPUT, message_body: "I could do $120,000 as-is." }, h.deps);
  assert.equal(r.ok, true);
  assert.equal(h.inserted[0].metadata.manual_offer_guard.decision, "within_authority");
  assert.deepEqual(h.inserted[0].metadata.manual_send_warning_codes, []);
});

test("executeManualInboxSendNow surfaces the refusal; the generic boolean override is not offered", async () => {
  const h = harness({ mode: "enforce" });
  let provider = false;
  const r = await executeManualInboxSendNow({ ...SEND_INPUT, force: true }, {
    ...h.deps,
    getSystemValue: async (key) => {
      if (key === MANUAL_OFFER_GUARD_MODE_KEY) return "enforce";
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    sendTextgridImpl: async () => { provider = true; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "manual_offer_exceeds_authority");
  assert.equal(r.operator_override_allowed, false);
  assert.equal(r.override_required, true);
  assert.equal(provider, false);
});
