// NO-RESPONSE FOLLOW-UPS (owner 2026-10-06): S2 interest question or an offer,
// seller silent → FU1 +24h, FU2 +72h after FU1, nurture +30d, then stop.
// Cadence, window, cancel-on-inbound, gates, idempotency, offer extraction,
// dispatch-time rendering. No network: in-memory PostgREST-shaped fake.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_NO_RESPONSE_USE_CASES,
  NO_RESPONSE_MODE_KEY,
  OFFER_NO_NUMBER_USE_CASE,
  buildNoResponseScheduleContext,
  buildObservedOfferQuote,
  classifyNoResponseAnchor,
  confidentFirstName,
  detectOutboundOffer,
  evaluateNoResponseCandidate,
  isS2InterestQuestion,
  normalizeNoResponseMode,
  resolveNoResponseConfig,
  resolveNoResponseFollowUpMessage,
} from "@/lib/domain/seller-flow/no-response-followup.js";
import {
  scheduleFollowUp,
  STAGE_NO_REPLY_FOLLOWUP_INTENT,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { maybeScheduleNoResponseFollowUp } from "@/lib/domain/seller-flow/delivery-triggered-followup.js";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { evaluateContactWindow } from "@/lib/supabase/sms-engine.js";
import { proposedNoResponseTemplateRows } from "../../scripts/ops/no-response-followup-templates.proposed.mjs";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";

const PHONE = "+16125550123";
const HOUR = 3_600_000;
const LIVE = new Set(["queued", "ready", "runnable", "scheduled", "pending", "paused", "paused_after_hours", "processing", "approved", "approval", "held", "sending"]);

// ── In-memory fake (same shape as not-interested-nurture-rc71.test.mjs) ─────
function createDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  let nextId = 1;
  const rowsOf = (t) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t); };
  function builder(table) {
    const filters = []; let op = "select"; let payload = null; let limitN = null; let single = false;
    const match = (row) => filters.every((f) => f(row));
    const run = () => {
      const rows = rowsOf(table);
      if (op === "insert") {
        const input = Array.isArray(payload) ? payload : [payload];
        const out = [];
        for (const raw of input) {
          const row = { id: raw.id ?? `row_${nextId++}`, created_at: new Date().toISOString(), ...raw };
          if (table === "send_queue") {
            const dup = rows.some((r) => r.queue_key && r.queue_key === row.queue_key) ||
              (row.dedupe_key && rows.some((r) => r.dedupe_key === row.dedupe_key && !r.sent_at && LIVE.has(String(r.queue_status))));
            if (dup) return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          rows.push(row); out.push(row);
        }
        return { data: single ? out[0] : out, error: null };
      }
      if (op === "update") { const hit = rows.filter(match); for (const r of hit) Object.assign(r, payload); return { data: hit, error: null }; }
      let hit = rows.filter(match);
      if (limitN !== null) hit = hit.slice(0, limitN);
      return single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
    };
    const chain = {
      select() { return proxy; },
      insert(p) { op = "insert"; payload = p; return proxy; },
      upsert(p) { op = "insert"; payload = p; return proxy; },
      update(p) { op = "update"; payload = p; return proxy; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return proxy; },
      in(c, vals) { const s = new Set(vals.map(String)); filters.push((r) => s.has(String(r[c]))); return proxy; },
      gte(c, v) { filters.push((r) => Date.parse(r[c]) >= Date.parse(v)); return proxy; },
      gt(c, v) { filters.push((r) => Date.parse(r[c]) > Date.parse(v)); return proxy; },
      or(expr) {
        const parts = String(expr).split(",").map((p) => p.split(".eq."));
        filters.push((r) => parts.some(([c, v]) => String(r[c]) === v));
        return proxy;
      },
      limit(n) { limitN = n; return proxy; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    const proxy = new Proxy(chain, { get: (t, p) => (p in t ? t[p] : () => proxy) });
    return proxy;
  }
  return { from: (t) => builder(t), rows: rowsOf };
}

const S2_BODY = "Thanks for confirming. Would you consider a proposal for the property?";
const SENT_AT = "2026-10-05T18:00:00.000Z"; // 1pm Central

function baseFacts(over = {}) {
  return {
    anchor: { id: "q_anchor", type: "auto_reply", use_case: "consider_selling", message_body: S2_BODY, seller_first_name: "Charles", language: null, ...(over.anchor || {}) },
    anchor_sent_at: SENT_AT,
    anchor_message_event_id: "me_anchor",
    thread_key: PHONE,
    has_inbound_before_anchor: true,
    has_inbound_after_anchor: false,
    has_newer_outbound: false,
    thread_state: { contactability_status: "contactable", ...(over.thread_state || {}) },
    on_suppression_list: false,
    inbound_rows_newest_first: [{ message_body: "Yes I own it" }],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["anchor", "thread_state"].includes(k))),
  };
}
const NOW = new Date("2026-10-06T20:00:00.000Z");

// ── Cadence ─────────────────────────────────────────────────────────────────

test("cadence: FU1 = our S2 question + 24h", () => {
  const ev = evaluateNoResponseCandidate(baseFacts(), { now: NOW });
  assert.equal(ev.eligible, true, ev.reason);
  assert.equal(ev.plan.kind, "s2_interest");
  assert.equal(ev.plan.use_case, "s2_no_response_fu1");
  assert.equal(ev.plan.scheduled_for, "2026-10-06T18:00:00.000Z");
  assert.equal(ev.plan.seller_first_name, "Charles");
  assert.equal(ev.plan.language, "English");
});

test("cadence: delivered FU1 → FU2 +72h (different use case) → nurture +30d → chain complete", () => {
  const chain = (step) => ({ id: `q_fu${step}`, type: "followup", use_case: `x`, message_body: "…", metadata: { no_response_followup: { kind: "s2_interest", step, chain_root_id: "me_anchor" } } });
  const fu2 = evaluateNoResponseCandidate(baseFacts({ anchor: chain(0) }), { now: NOW });
  assert.equal(fu2.plan.use_case, "s2_no_response_fu2");
  assert.equal(Date.parse(fu2.plan.scheduled_for) - Date.parse(SENT_AT), 72 * HOUR);
  assert.equal(fu2.plan.chain_root_id, "me_anchor");
  const nurture = evaluateNoResponseCandidate(baseFacts({ anchor: chain(1) }), { now: NOW });
  assert.equal(nurture.plan.use_case, "s2_no_response_nurture");
  assert.equal(Date.parse(nurture.plan.scheduled_for) - Date.parse(SENT_AT), 30 * 24 * HOUR);
  const done = evaluateNoResponseCandidate(baseFacts({ anchor: chain(2) }), { now: NOW });
  assert.equal(done.eligible, false);
  assert.equal(done.reason, "no_response_chain_complete");
});

test("cadence is configurable (system_control followup_no_response_config)", () => {
  const config = resolveNoResponseConfig(JSON.stringify({ s2_interest: { delays_hours: [12, 48] }, languages: ["English"] }));
  assert.deepEqual(config.s2_interest.delays_hours, [12, 48]);
  const ev = evaluateNoResponseCandidate(baseFacts(), { config, now: NOW });
  assert.equal(Date.parse(ev.plan.scheduled_for) - Date.parse(SENT_AT), 12 * HOUR);
  const step2 = evaluateNoResponseCandidate(
    baseFacts({ anchor: { type: "followup", metadata: { no_response_followup: { kind: "s2_interest", step: 1 } } } }),
    { config, now: NOW }
  );
  assert.equal(step2.reason, "no_response_chain_complete", "two configured steps → no nurture");
  assert.deepEqual(resolveNoResponseConfig("not json").s2_interest.delays_hours, [24, 72, 720]);
});

test("gate: followup_no_response_mode defaults to disabled for missing / invalid values", () => {
  for (const v of [null, undefined, "", "on", "true", "full_live"]) assert.equal(normalizeNoResponseMode(v), "disabled");
  assert.equal(normalizeNoResponseMode("Dry-Run"), "dry_run");
  assert.equal(normalizeNoResponseMode("live"), "live");
});

// ── Window ──────────────────────────────────────────────────────────────────

test("window: a due follow-up row only sends 8am–9pm recipient-local (processor gate)", () => {
  const row = { id: "q1", type: "followup", queue_status: "scheduled", to_phone_number: PHONE, timezone: "America/Chicago", metadata: {} };
  assert.equal(evaluateContactWindow(row, { now: "2026-10-06T15:00:00.000Z" }).allowed, true, "10:00 CDT");
  assert.equal(evaluateContactWindow(row, { now: "2026-10-07T02:30:00.000Z" }).allowed, false, "21:30 CDT");
  assert.equal(evaluateContactWindow(row, { now: "2026-10-06T12:30:00.000Z" }).allowed, false, "07:30 CDT");
  assert.equal(evaluateContactWindow({ ...row, timezone: null }, { now: "2026-10-06T15:00:00.000Z" }).hold, true, "unknown zone holds");
});

// ── Gates ───────────────────────────────────────────────────────────────────

test("gates: every disqualifier blocks FU1", () => {
  const cases = [
    [{ has_inbound_after_anchor: true }, "inbound_reply_received"],
    [{ has_newer_outbound: true }, "newer_outbound_exists"],
    [{ has_inbound_before_anchor: false }, "seller_never_replied"],
    [{ on_suppression_list: true }, "phone_suppressed"],
    [{ thread_state: { is_suppressed: true } }, "thread_suppressed"],
    [{ thread_state: { contactability_status: "opted_out" } }, "contact_blocked:opted_out"],
    [{ thread_state: { contactability_status: "invalid_number" } }, "contact_blocked:invalid_number"],
    [{ thread_state: { last_intent: "not_interested" } }, "disposition_rules_own_thread:not_interested"],
    [{ thread_state: { last_intent: "wrong_number" } }, "disposition_rules_own_thread:wrong_number"],
    [{ thread_state: { last_intent: "hostile_or_legal" } }, "disposition_rules_own_thread:hostile_or_legal"],
    [{ thread_state: { lifecycle_stage: "closed" } }, "terminal_stage:closed"],
    [{ anchor_sent_at: "2026-09-10T18:00:00.000Z" }, "anchor_too_old"],
    [{ inbound_rows_newest_first: [{ message_body: "Yes please don't call about my house" }] }, "seller_asked_not_to_be_contacted"],
    [{ inbound_rows_newest_first: [{ message_body: "Sí, pero no me escriba más" }] }, "seller_asked_not_to_be_contacted"],
  ];
  for (const [over, reason] of cases) {
    assert.equal(evaluateNoResponseCandidate(baseFacts(over), { now: NOW }).reason, reason, JSON.stringify(over));
  }
});

test("gates: reply language — seller's language, unknown is skipped, never English by default", () => {
  const es = evaluateNoResponseCandidate(baseFacts({ inbound_rows_newest_first: [{ message_body: "Sí, soy el dueño de la casa" }] }), { now: NOW });
  assert.equal(es.plan.language, "Spanish");
  const vi = evaluateNoResponseCandidate(baseFacts({ inbound_rows_newest_first: [{ message_body: "Vâng, tôi là chủ nhà" }], anchor: { message_body: "Anh có muốn bán nhà không?" } }), { now: NOW });
  assert.equal(vi.eligible, false);
  assert.match(vi.reason, /^language_(not_enabled|unknown)/);
  const unidentified = evaluateNoResponseCandidate(baseFacts({ inbound_rows_newest_first: [{ message_body: "Si- estoy pidiendo un millón", language: "English" }, { message_body: "Yes" }] }), { now: NOW });
  assert.notEqual(unidentified.plan?.language, "English", "a seller's unidentified text never becomes English");
  const unknown = evaluateNoResponseCandidate(baseFacts({ inbound_rows_newest_first: [{ message_body: "👍" }], anchor: { message_body: "??", use_case: "consider_selling" } }), { now: NOW });
  assert.equal(unknown.reason, "language_unknown");
});

test("names: only a confident person first name, never an entity", () => {
  assert.equal(confidentFirstName("charles smith"), "Charles");
  for (const bad of ["2972 Sw 17 Street LLC", "Pim Six Corporation", "Noel A Edwards Rev Liv Tr", "Owner", "there", "", null, "J"]) {
    assert.equal(confidentFirstName(bad), null, String(bad));
  }
});

test("anchors: S2 question by template or typed text; other follow-ups never start a chain", () => {
  assert.equal(isS2InterestQuestion({ message_body: "Are you open to a proposal on the property?" }), true);
  assert.equal(isS2InterestQuestion({ message_body: "Hey Charles, are you open to selling the property?" }), true);
  assert.equal(isS2InterestQuestion({ message_body: "¿Estás abierto a una propuesta sobre la propiedad?" }), true);
  assert.equal(isS2InterestQuestion({ message_body: "Do you have an asking price in mind?" }), false);
  assert.equal(isS2InterestQuestion({ message_body: "Public records." }), false);
  assert.equal(classifyNoResponseAnchor({ type: "followup", use_case: "consider_selling_follow_up", message_body: "Would you be open to a proposal?", metadata: { intent: "not_interested" } }).reason, "anchor_is_other_followup");
});

// ── Offer extraction ────────────────────────────────────────────────────────

test("offer extraction from OUR outbound (single money parser, v3 number rules)", () => {
  const cases = [
    ["Hey Gale, this is Alex following up on 3635 Emerson Ave N. Are you interested in moving forward with my offer at $132,000 cash with a 7 day close?", 132000],
    ["I'd be at $825,000 cash, which is $75,000 per unit. I can close quickly.", 825000],
    ["I can do $185,000", 185000],
    ["we could offer 185k", 185000],
    ["my offer is 185", 185000],
    ["I’d be at around $315K, close in 10 days.", 315000],
    ["I’m good to move forward at $315,000. What’s your best email?", 315000],
  ];
  for (const [body, amount] of cases) {
    const d = detectOutboundOffer({ message_body: body });
    assert.equal(d.mode, "number", body);
    assert.equal(d.amount, amount, body);
  }
  for (const body of ["I could do between $120,000 and $130,000", "I can do $150,000 or $160,000 if you cover closing"]) {
    assert.equal(detectOutboundOffer({ message_body: body }).mode, "no_number", body);
  }
  for (const body of ["Do you have an asking price in mind?", "Right, so $240K is the ARV after it's fully updated.", "The county has it assessed at around $193K."]) {
    assert.equal(detectOutboundOffer({ message_body: body }).is_offer, false, body);
  }
});

test("offer chain: FU1/FU2 quote the number as sent; ambiguous → no-number copy; nurture never quotes", () => {
  const offer = baseFacts({ anchor: { use_case: "manual_reply", message_body: "I'd be at $165,000 cash and can close in 7 days." } });
  const fu1 = evaluateNoResponseCandidate(offer, { now: NOW });
  assert.equal(fu1.plan.kind, "offer");
  assert.equal(fu1.plan.use_case, "offer_no_response_fu1");
  assert.equal(fu1.plan.offer.amount, 165000);
  const amb = evaluateNoResponseCandidate(baseFacts({ anchor: { use_case: "manual_reply", message_body: "I could do between $120,000 and $130,000 cash" } }), { now: NOW });
  assert.equal(amb.plan.use_case, OFFER_NO_NUMBER_USE_CASE);
  const nurture = evaluateNoResponseCandidate(baseFacts({ anchor: { type: "followup", metadata: { no_response_followup: { kind: "offer", step: 1, offer: { mode: "number", amount: 165000 } } } } }), { now: NOW });
  assert.equal(nurture.plan.use_case, "offer_no_response_nurture");
});

// ── Idempotency + cancel ───────────────────────────────────────────────────

function scheduleCtx(facts = baseFacts()) {
  const ev = evaluateNoResponseCandidate(facts, { now: NOW });
  return buildNoResponseScheduleContext(ev.plan, { thread_key: PHONE, anchor: facts.anchor, anchor_message_event_id: "me_anchor" });
}

test("idempotent: the same delivery replayed never makes a second row; a new step is its own row", async () => {
  const db = createDb();
  const ctx = scheduleCtx();
  const first = await scheduleFollowUp(STAGE_NO_REPLY_FOLLOWUP_INTENT, PHONE, ctx, db);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.scheduled_for, "2026-10-06T18:00:00.000Z");
  const replay = await scheduleFollowUp(STAGE_NO_REPLY_FOLLOWUP_INTENT, PHONE, ctx, db);
  assert.equal(replay.reason, "duplicate_followup_exists");
  // Even after FU1 was sent, replaying its scheduling key never re-creates it.
  Object.assign(db.rows("send_queue")[0], { queue_status: "sent", sent_at: "2026-10-06T18:01:00.000Z" });
  const after_sent = await scheduleFollowUp(STAGE_NO_REPLY_FOLLOWUP_INTENT, PHONE, ctx, db);
  assert.equal(after_sent.reason, "duplicate_followup_exists");
  assert.equal(db.rows("send_queue").length, 1);
  const row = db.rows("send_queue")[0];
  assert.equal(row.type, "followup");
  assert.equal(row.use_case_template, "s2_no_response_fu1");
  assert.equal(row.metadata.no_response_followup.language, "English");
  assert.equal(row.metadata.deferred_message_resolution, true);
  assert.equal(row.metadata.no_response_followup.step, 0);
});

test("cancel: any inbound cancels a pending no-response follow-up (even with nurture-keeping on)", async () => {
  const db = createDb();
  await scheduleFollowUp(STAGE_NO_REPLY_FOLLOWUP_INTENT, PHONE, scheduleCtx(), db);
  const res = await cancelSupabasePendingOutbound(
    { thread_key: PHONE, to_phone_number: PHONE, policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER, reason: "cancelled_followup_on_inbound_reply", keep_nurture_follow_ups: true },
    { supabase: db }
  );
  assert.equal(res.cancelled, 1);
  assert.equal(db.rows("send_queue")[0].queue_status, "cancelled");
});

// ── Delivery hook ───────────────────────────────────────────────────────────

function hookDb(extra = {}) {
  return createDb({
    send_queue: [{ id: "q_anchor", thread_key: PHONE, type: "auto_reply", use_case_template: "consider_selling", message_body: S2_BODY, seller_first_name: "Charles", timezone: "America/Chicago", metadata: {} }],
    inbox_thread_state: [{ thread_key: PHONE, contactability_status: "contactable", lifecycle_stage: "offer_interest" }],
    message_events: [{ id: "me_in1", thread_key: PHONE, direction: "inbound", message_body: "Yes I own it", event_timestamp: "2026-10-05T17:50:00.000Z", created_at: "2026-10-05T17:50:00.000Z" }],
    ...extra,
  });
}
const OUTBOUND = { id: "me_anchor", thread_key: PHONE, queue_id: "q_anchor" };
const sys = (mode) => async (key) => (key === NO_RESPONSE_MODE_KEY ? mode : null);

test("hook: disabled (default) is a no-op — the generic path runs unchanged", async () => {
  for (const mode of [null, "", "garbage"]) {
    const out = await maybeScheduleNoResponseFollowUp({ supabase: hookDb(), outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys(mode) });
    assert.equal(out.handled, false);
  }
});

test("hook: dry_run reports the plan and writes nothing; live schedules exactly one FU1", async () => {
  const db = hookDb();
  const dry = await maybeScheduleNoResponseFollowUp({ supabase: db, outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys("dry_run"), now: NOW });
  assert.equal(dry.result.reason, "no_response_followup_dry_run");
  assert.equal(dry.result.plan.use_case, "s2_no_response_fu1");
  assert.equal(db.rows("send_queue").length, 1);

  const live = await maybeScheduleNoResponseFollowUp({ supabase: db, outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys("live"), now: NOW });
  assert.equal(live.result.scheduled, true, live.result.reason);
  const again = await maybeScheduleNoResponseFollowUp({ supabase: db, outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys("live"), now: NOW });
  assert.equal(again.result.scheduled, false);
  assert.equal(db.rows("send_queue").filter((r) => r.type === "followup").length, 1);
});

test("hook: a pending follow-up, an internal_only gate or a suppressed phone blocks scheduling", async () => {
  const pending = await maybeScheduleNoResponseFollowUp({ supabase: hookDb(), outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, pending_rows: [{ id: "x" }], getSystemValueImpl: sys("live"), now: NOW });
  assert.equal(pending.result.reason, "duplicate_pending_followup");
  const internal = await maybeScheduleNoResponseFollowUp({ supabase: hookDb(), outbound: OUTBOUND, sid: "SM1", mode: "internal_only", sent_at: SENT_AT, getSystemValueImpl: sys("live"), isInternalTestPhoneImpl: () => false, now: NOW });
  assert.equal(internal.result.reason, "followup_internal_only_blocked");
  const supp = await maybeScheduleNoResponseFollowUp({ supabase: hookDb({ sms_suppression_list: [{ id: "s", phone_e164: PHONE, is_active: true }] }), outbound: OUTBOUND, sid: "SM1", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys("live"), now: NOW });
  assert.equal(supp.result.reason, "phone_suppressed");
});

// ── Dispatch ────────────────────────────────────────────────────────────────

function activeTemplates() {
  return proposedNoResponseTemplateRows().map((r) => ({ ...r, is_active: true, safe_for_auto_reply: true }));
}
function dueRow(over = {}) {
  return {
    id: "q_fu1", thread_key: PHONE, to_phone_number: PHONE, type: "followup", use_case_template: "s2_no_response_fu1",
    language: "English", seller_first_name: "Charles", queue_status: "processing",
    metadata: {
      deferred_message_resolution: true, intent: "stage_no_reply", followup_use_case: "s2_no_response_fu1",
      no_response_followup: { kind: "s2_interest", step: 0, anchor_at: SENT_AT, anchor_message_event_id: "me_anchor", language: "English" },
      ...(over.metadata || {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "metadata")),
  };
}

test("dispatch: renders the reviewed copy with template_id, name only when confident", async () => {
  const db = createDb({ sms_templates: activeTemplates() });
  const named = await resolveDeferredQueueMessage(dueRow(), { supabase: db });
  assert.equal(named.resolved, true, named.reason);
  assert.match(named.message_body, /^Hey Charles, /);
  assert.match(named.template_id, /^lc-nr-s2fu1-en-[ab]$/);
  const entity = await resolveDeferredQueueMessage(dueRow({ seller_first_name: "Acme Holdings LLC" }), { supabase: db });
  assert.equal(entity.template_id, "lc-nr-s2fu1-en-n");
  assert.equal(entity.message_body, "Hey, are you still interested in selling the property?");
});

test("dispatch: inactive (proposed) templates never send — row parks, nothing blank", async () => {
  const db = createDb({ sms_templates: proposedNoResponseTemplateRows() });
  const out = await resolveDeferredQueueMessage(dueRow(), { supabase: db });
  assert.equal(out.resolved, false);
  assert.equal(out.reason, "no_renderable_no_response_template");
});

test("dispatch: a reply or a newer outbound since the anchor stops the send", async () => {
  const replied = createDb({ sms_templates: activeTemplates(), message_events: [{ id: "me_r", thread_key: PHONE, direction: "inbound", event_timestamp: "2026-10-06T01:00:00.000Z" }] });
  assert.equal((await resolveDeferredQueueMessage(dueRow(), { supabase: replied })).reason, "seller_replied_since_anchor");
  const newer = createDb({ sms_templates: activeTemplates(), message_events: [{ id: "me_o", thread_key: PHONE, direction: "outbound", event_timestamp: "2026-10-06T01:00:00.000Z" }] });
  assert.equal((await resolveDeferredQueueMessage(dueRow(), { supabase: newer })).reason, "newer_outbound_since_anchor");
});

test("dispatch: Spanish seller gets Spanish copy or nothing (no English fallback)", async () => {
  const es_row = dueRow({ language: "Spanish", metadata: { no_response_followup: { kind: "s2_interest", step: 0, anchor_at: SENT_AT, language: "Spanish" } } });
  const ok = await resolveDeferredQueueMessage(es_row, { supabase: createDb({ sms_templates: activeTemplates() }) });
  assert.equal(ok.language, "Spanish");
  const en_only = activeTemplates().filter((t) => t.language === "English");
  const none = await resolveDeferredQueueMessage(es_row, { supabase: createDb({ sms_templates: en_only }) });
  assert.equal(none.resolved, false);
});

test("dispatch: offer FU1 quotes exactly the number sent; above the engine max → no-number copy", async () => {
  const offer_row = (amount) => dueRow({
    use_case_template: "offer_no_response_fu1", property_id: "p1",
    metadata: { followup_use_case: "offer_no_response_fu1", no_response_followup: { kind: "offer", step: 0, anchor_at: SENT_AT, language: "English", offer: { mode: "number", amount } } },
  });
  const db = createDb({ sms_templates: activeTemplates(), property_acquisition_scores: [{ property_id: "p1", mao: "150000", computed_at: "2026-10-05T00:00:00Z" }] });
  const within = await resolveDeferredQueueMessage(offer_row(132000), { supabase: db });
  assert.match(within.message_body, /\$132,000/);
  assert.equal(within.offer_price_quoted, 132000);
  const above = await resolveDeferredQueueMessage(offer_row(165000), { supabase: db });
  assert.equal(above.use_case, OFFER_NO_NUMBER_USE_CASE);
  assert.doesNotMatch(above.message_body, /\$/);
});

// ── Proposed templates ──────────────────────────────────────────────────────

test("proposed templates: 42 inactive EN/ES rows, every one renders, ids unique, use cases known", () => {
  const rows = proposedNoResponseTemplateRows();
  assert.equal(rows.length, 42);
  assert.equal(new Set(rows.map((r) => r.template_id)).size, rows.length);
  for (const r of rows) {
    assert.equal(r.is_active, false);
    assert.equal(r.safe_for_auto_reply, false);
    assert.ok(ALL_NO_RESPONSE_USE_CASES.has(r.use_case), r.use_case);
    const out = personalizeTemplate(r.template_body, { seller_first_name: "Ana", agent_name: "Alex", offer_price: 132000 });
    assert.equal(out.ok, true, r.template_id);
    if (r.metadata.variant === "N") assert.doesNotMatch(r.template_body, /seller_first_name/);
    if (r.use_case.endsWith("_nurture") || r.use_case === OFFER_NO_NUMBER_USE_CASE) assert.doesNotMatch(r.template_body, /offer_price/);
  }
});

test("observed offer: a manual Inbox offer is recorded (amount, source, message id); ambiguous offers are not", async () => {
  const anchor = { id: "q_off", use_case: "manual_reply", message_body: "I'd be at $132,000 cash", metadata: { template_source: "manual_composer" } };
  const q = buildObservedOfferQuote({ thread_key: PHONE, message_event_id: "me_off", offer: detectOutboundOffer({ message_body: anchor.message_body }), anchor, language: "English" });
  assert.equal(q.quote_type, "observed_offer");
  assert.equal(q.quote_source, "manual");
  assert.equal(q.amount, 132000);
  assert.equal(q.quote_key, "observed_offer:me_off");
  assert.equal(buildObservedOfferQuote({ thread_key: PHONE, message_event_id: "me_x", offer: { mode: "no_number" }, anchor }), null);

  const db = createDb({
    send_queue: [{ id: "q_off", thread_key: PHONE, type: "outbound", use_case_template: "manual_reply", message_body: anchor.message_body, metadata: anchor.metadata }],
    inbox_thread_state: [{ thread_key: PHONE, contactability_status: "contactable" }],
    message_events: [{ id: "me_in1", thread_key: PHONE, direction: "inbound", message_body: "Make me an offer", event_timestamp: "2026-10-05T17:50:00.000Z", created_at: "2026-10-05T17:50:00.000Z" }],
  });
  const out = await maybeScheduleNoResponseFollowUp({ supabase: db, outbound: { id: "me_off", thread_key: PHONE, queue_id: "q_off" }, sid: "SM2", mode: "full_live", sent_at: SENT_AT, getSystemValueImpl: sys("live"), now: NOW });
  assert.equal(out.result.scheduled, true, out.result.reason);
  assert.equal(out.result.use_case, "offer_no_response_fu1");
  assert.equal(db.rows("negotiation_quotes").length, 1);
  assert.equal(db.rows("send_queue").find((r) => r.type === "followup").metadata.no_response_followup.offer.amount, 132000);
});
