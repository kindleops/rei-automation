/**
 * FOLLOW-UPS NOT FIRING (owner P0 2026-10-10).
 *
 * Prod example: "Thanks for confirming. Would you consider a proposal for the
 * property?" delivered 2026-10-06 17:23Z, no reply, NO follow-up by 10-10.
 * 14-day prod count (read-only, 2026-10-10): 39 S2 / 8 S3 / 1 offer / 3 S4
 * threads silent > 24h with no follow-up; ZERO stage follow-up rows were ever
 * written — every followup row in send_queue is a 30-day not-interested nurture.
 *
 * Root causes:
 *   1. delivery-triggered-followup.js — the generic stage leg reads the
 *      outbound's use case ONLY from message_events.metadata
 *      (template_use_case / automation_provenance). The send path never writes
 *      either onto the outbound message_event (0 / 6,575 outbound events in 14
 *      days), so every delivery resolves "no_declared_followup_plan".
 *   2. The owner-designed no-response leg (S2 / offer) is gated on
 *      system_control.followup_no_response_mode, which does not exist in prod
 *      → disabled; and its s2_/offer_no_response_* templates were never applied.
 *   3. S3 (unanswered asking-price question) had no follow-up kind at all.
 *   (follow_up_scheduler_heartbeat_at frozen at 2026-09-17 is the retired
 *   Vercel recover-inbound lane — not the live scheduler.)
 *
 * Fix: the no-response leg owns S2 / S3 / offer silence (anchor read from the
 * send_queue row, never the event metadata), FU1 +24h → FU2 +72h → nurture
 * +30d; S2 falls back to the ALREADY-APPROVED consider_selling_follow_up rows;
 * S3 / offer hold (paused, nothing sent) until their PROPOSED rows are approved.
 * S1 is unchanged (no delivery-triggered ownership cadence — campaign-owned).
 * Archive is visibility only: archived threads keep their follow-ups.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  maybeScheduleFollowUpAfterDelivery,
  resolveDeliveryFollowUpDecision,
} from "@/lib/domain/seller-flow/delivery-triggered-followup.js";
import {
  NO_RESPONSE_MODE_KEY,
  NO_RESPONSE_KINDS,
  classifyNoResponseAnchor,
  evaluateNoResponseCandidate,
  isS3AskingPriceQuestion,
  isS2InterestQuestion,
} from "@/lib/domain/seller-flow/no-response-followup.js";
import { resolveFollowUpPlan, scheduleFollowUp } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { proposedS3S4TemplateRows } from "../../scripts/ops/s3-s4-natural-templates.proposed.mjs";

const PHONE = "+16125550123";
const HOUR = 3_600_000;
const LIVE = new Set(["queued", "ready", "runnable", "scheduled", "pending", "paused", "paused_after_hours", "processing", "approved", "approval", "held", "sending"]);

// ── In-memory PostgREST-shaped fake (same shape as no-response-followup.test.mjs) ──
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

// Anchors exactly as prod writes them: the use case lives on the send_queue
// row; the outbound message_event metadata carries NO template_use_case.
const ANCHORS = {
  S1_ownership: { type: "campaign_launch", use_case_template: "ownership_check", message_body: "Hey, this is Sam. Is 12 Oak St yours?", replied_before: false },
  S2_template: { type: "auto_reply", use_case_template: "consider_selling", message_body: "Thanks for confirming. Would you consider a proposal for the property?" },
  S2_typed: { type: "outbound", use_case_template: "manual_reply", message_body: "Would you be open to an offer on the property?" },
  S3_template: { type: "auto_reply", use_case_template: "seller_asking_price", message_body: "Got it. What price would you have in mind for the property?" },
  S3_typed: { type: "outbound", use_case_template: "manual_reply", message_body: "Do you have an asking price in mind for the property?" },
  S4_condition: { type: "auto_reply", use_case_template: "price_high_condition_probe", message_body: "Got it. Is the property updated, or does it need work?" },
  S5_offer_typed: { type: "outbound", use_case_template: "manual_reply", message_body: "I can do $150,000 cash and close in 2 weeks. Does that work?" },
};

function deliveredThread(anchorKey, { sentAt = new Date(Date.now() - HOUR).toISOString(), threadState = {}, extra = {} } = {}) {
  const a = ANCHORS[anchorKey];
  const before = new Date(Date.parse(sentAt) - 10 * 60_000).toISOString();
  return {
    sentAt,
    db: createDb({
      send_queue: [{ id: "q_anchor", thread_key: PHONE, type: a.type, use_case_template: a.use_case_template, message_body: a.message_body, seller_first_name: "Charles", language: "English", timezone: "America/Chicago", metadata: {} }],
      inbox_thread_state: [{ thread_key: PHONE, contactability_status: "contactable", lifecycle_stage: "offer_interest", ...threadState }],
      message_events: [
        ...(a.replied_before === false ? [] : [{ id: "me_in1", thread_key: PHONE, direction: "inbound", message_body: "Yes I own it", event_timestamp: before, created_at: before }]),
        // prod shape: no template_use_case / automation_provenance in metadata
        { id: "me_anchor", thread_key: PHONE, direction: "outbound", queue_id: "q_anchor", provider_message_sid: "SM_anchor", sent_at: sentAt, event_timestamp: sentAt, created_at: sentAt, metadata: { queue_row: { id: "q_anchor" } } },
      ],
      ...extra,
    }),
  };
}

const sys = ({ followup = "full_live", noResponse = "live", enabledAt = "2026-10-01T00:00:00.000Z", canaryCap = null } = {}) => async (key) =>
  key === "followup_automation_mode" ? followup
    : key === NO_RESPONSE_MODE_KEY ? noResponse
    : key === "followup_no_response_enabled_at" ? enabledAt
    : key === "followup_no_response_canary_daily_cap" ? canaryCap
    : null;

async function deliver(db, system) {
  return maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_anchor",
    final_delivery_status: "delivered",
    supabase: db,
    getSystemValueImpl: system,
  });
}
const followups = (db) => db.rows("send_queue").filter((r) => r.type === "followup");

// ── 1. Root cause pinned on the prod configuration ─────────────────────────

test("root cause: prod today (no followup_no_response_mode key) — an S2 delivery schedules nothing (no_declared_followup_plan)", async () => {
  const { db } = deliveredThread("S2_template");
  const out = await deliver(db, sys({ noResponse: null }));
  assert.equal(out.scheduled, false);
  assert.equal(out.reason, "no_declared_followup_plan");
  assert.equal(followups(db).length, 0);
});

// ── 2. Firing per stage (gate live) ────────────────────────────────────────

test("S2 silence (templated question) → FU1 at anchor +24h, s2_no_response_fu1", async () => {
  const { db, sentAt } = deliveredThread("S2_template");
  const out = await deliver(db, sys());
  assert.equal(out.scheduled, true, out.reason);
  const [row] = followups(db);
  assert.equal(row.use_case_template, "s2_no_response_fu1");
  assert.equal(row.scheduled_for, new Date(Date.parse(sentAt) + 24 * HOUR).toISOString());
  assert.equal(row.metadata.no_response_followup.kind, NO_RESPONSE_KINDS.S2_INTEREST);
  assert.equal(row.metadata.deferred_message_resolution, true);
});

test("S2 silence (owner-typed question) → FU1 +24h", async () => {
  const { db } = deliveredThread("S2_typed");
  assert.equal((await deliver(db, sys())).scheduled, true);
  assert.equal(followups(db)[0].use_case_template, "s2_no_response_fu1");
});

test("S3 silence (templated or typed asking-price question) → FU1 +24h re-asking the price", async () => {
  for (const key of ["S3_template", "S3_typed"]) {
    const { db, sentAt } = deliveredThread(key, { threadState: { lifecycle_stage: "asking_price" } });
    const out = await deliver(db, sys());
    assert.equal(out.scheduled, true, `${key}: ${out.reason}`);
    const [row] = followups(db);
    assert.equal(row.use_case_template, "s3_no_response_fu1", key);
    assert.equal(row.metadata.no_response_followup.kind, NO_RESPONSE_KINDS.S3_ASKING_PRICE, key);
    assert.equal(row.scheduled_for, new Date(Date.parse(sentAt) + 24 * HOUR).toISOString(), key);
  }
});

test("offer silence (owner-typed offer) → FU1 +24h quoting exactly the number sent", async () => {
  const { db } = deliveredThread("S5_offer_typed", { threadState: { lifecycle_stage: "offer" } });
  const out = await deliver(db, sys());
  assert.equal(out.scheduled, true, out.reason);
  const [row] = followups(db);
  assert.equal(row.use_case_template, "offer_no_response_fu1");
  assert.equal(row.metadata.no_response_followup.offer.amount, 150000);
});

test("S1 ownership first touch with no reply → no delivery-triggered follow-up (S1 cadence is unchanged / campaign-owned)", async () => {
  const { db } = deliveredThread("S1_ownership", { threadState: { lifecycle_stage: "ownership_confirmation" } });
  const out = await deliver(db, sys());
  assert.equal(out.scheduled, false);
  assert.equal(followups(db).length, 0);
});

test("S4 condition question is not a no-response anchor (no owner rule yet) — nothing scheduled, nothing resent", async () => {
  const { db } = deliveredThread("S4_condition", { threadState: { lifecycle_stage: "property_condition" } });
  const out = await deliver(db, sys());
  assert.equal(out.scheduled, false);
  assert.equal(followups(db).length, 0);
});

test("a reply, a newer outbound, a suppression or a stop-contact request blocks every stage", async () => {
  for (const key of ["S2_template", "S3_template", "S5_offer_typed"]) {
    const sup = deliveredThread(key, { extra: { sms_suppression_list: [{ id: "s", phone_e164: PHONE, is_active: true }] } });
    assert.equal((await deliver(sup.db, sys())).scheduled, false, `${key} suppressed`);
    const opted = deliveredThread(key, { threadState: { contactability_status: "opted_out" } });
    assert.equal((await deliver(opted.db, sys())).scheduled, false, `${key} opted_out`);
  }
  const anchor = { use_case: "consider_selling", message_body: ANCHORS.S2_template.message_body };
  const base = { anchor, anchor_sent_at: new Date().toISOString(), thread_key: PHONE, has_inbound_before_anchor: true, thread_state: {}, inbound_rows_newest_first: [{ message_body: "yes" }] };
  assert.equal(evaluateNoResponseCandidate({ ...base, has_inbound_after_anchor: true }).reason, "inbound_reply_received");
  assert.equal(evaluateNoResponseCandidate({ ...base, has_newer_outbound: true }).reason, "newer_outbound_exists");
  assert.equal(evaluateNoResponseCandidate({ ...base, inbound_rows_newest_first: [{ message_body: "please stop texting me" }] }).reason, "seller_asked_not_to_be_contacted");
});

test("not interested → 30-day nurture, never a suppression", () => {
  const plan = resolveFollowUpPlan("not_interested", { thread_key: PHONE });
  assert.equal(plan.suppressed, false);
  assert.equal(plan.followup_created, true);
  assert.equal(plan.days, 30);
  // and it never starts an S2 chain, even with the gate live
  assert.equal(classifyNoResponseAnchor({ type: "followup", use_case: "nurture_not_interested", message_body: "" }).kind, null);
});

test("anchor classification: S3 before S2; questions that quote a number are offers / clarifiers, not S3", () => {
  assert.equal(isS3AskingPriceQuestion({ message_body: "Do you have an asking price in mind for the property?" }), true);
  assert.equal(isS3AskingPriceQuestion({ message_body: "Got it. What price would you have in mind for the property?" }), true);
  assert.equal(isS3AskingPriceQuestion({ message_body: "Would $150k work for you?" }), false);
  assert.equal(isS3AskingPriceQuestion({ use_case: "seller_asking_price" }), true);
  assert.equal(isS2InterestQuestion({ message_body: "Do you have an asking price in mind for the property?" }), false);
  assert.equal(classifyNoResponseAnchor({ use_case: "manual_reply", message_body: "Do you have an asking price in mind?" }).kind, NO_RESPONSE_KINDS.S3_ASKING_PRICE);
});

// ── 3. Dispatch on the LIVE template set ───────────────────────────────────

const APPROVED_S2F = [
  { template_id: "521101", use_case: "consider_selling_follow_up", language: "English", stage_code: "S2F", is_active: true, safe_for_auto_reply: true, quarantine_state: "active", property_type_scope: "Follow-Up", allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"], template_body: "{{seller_first_name}}, circling back on {{property_address}}. If the numbers made sense, would you look at a proposal?" },
  { template_id: "521105", use_case: "consider_selling_follow_up", language: "English", stage_code: "S2F", is_active: true, safe_for_auto_reply: true, quarantine_state: "active", property_type_scope: "Follow-Up", allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"], template_body: "{{seller_first_name}}, just checking back on {{property_address}}. Would you be open to a proposal?" },
  { template_id: "lc-consider-selling-follow-up-es-1", use_case: "consider_selling_follow_up", language: "Spanish", stage_code: "S2F", is_active: true, safe_for_auto_reply: true, quarantine_state: "active", property_type_scope: "Any Residential", allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"], template_body: "{{seller_first_name}}, le escribo de nuevo. Si los números tienen sentido, ¿consideraría una propuesta?" },
];
const ANCHOR_AT = "2026-10-06T17:23:00.000Z";
function dueRow(kind, use_case, over = {}) {
  return {
    id: `q_${use_case}`, thread_key: PHONE, to_phone_number: PHONE, type: "followup", use_case_template: use_case,
    language: "English", seller_first_name: "Charles", property_address: "12 Oak St", queue_status: "processing",
    metadata: {
      deferred_message_resolution: true, intent: "stage_no_reply", followup_use_case: use_case,
      no_response_followup: { kind, step: 0, anchor_at: ANCHOR_AT, anchor_message_event_id: "me_anchor", language: "English" },
    },
    ...over,
  };
}

test("dispatch S2 FU1 on today's templates → the approved consider_selling_follow_up copy (sms_templates row, never registry)", async () => {
  const db = createDb({ sms_templates: APPROVED_S2F });
  const out = await resolveDeferredQueueMessage(dueRow("s2_interest", "s2_no_response_fu1"), { supabase: db });
  assert.equal(out.resolved, true, out.reason);
  assert.ok(["521101", "521105"].includes(out.template_id), out.template_id);
  assert.match(out.message_body, /^Charles, /);
  assert.match(out.message_body, /proposal\?$/);
});

test("dispatch S2 FU2 never repeats a template the seller already received", async () => {
  const db = createDb({
    sms_templates: APPROVED_S2F,
    send_queue: [{ id: "q_fu1_sent", thread_key: PHONE, template_id: "521105", queue_status: "delivered" }],
  });
  const row = dueRow("s2_interest", "s2_no_response_fu2");
  row.metadata.no_response_followup.step = 1;
  const out = await resolveDeferredQueueMessage(row, { supabase: db });
  assert.equal(out.resolved, true, out.reason);
  assert.equal(out.template_id, "521101");
  const both = createDb({
    sms_templates: APPROVED_S2F,
    send_queue: [{ id: "a", thread_key: PHONE, template_id: "521105", queue_status: "delivered" }, { id: "b", thread_key: PHONE, template_id: "521101", queue_status: "delivered" }],
  });
  assert.equal((await resolveDeferredQueueMessage(row, { supabase: both })).resolved, false, "nothing left to say → park, never repeat");
});

test("dispatch S2 Spanish → Spanish approved copy or nothing", async () => {
  const row = dueRow("s2_interest", "s2_no_response_fu1", { language: "Spanish" });
  row.metadata.no_response_followup.language = "Spanish";
  const out = await resolveDeferredQueueMessage(row, { supabase: createDb({ sms_templates: APPROVED_S2F }) });
  assert.equal(out.template_id, "lc-consider-selling-follow-up-es-1");
  const none = await resolveDeferredQueueMessage(row, { supabase: createDb({ sms_templates: APPROVED_S2F.filter((t) => t.language === "English") }) });
  assert.equal(none.resolved, false);
});

test("dispatch S3 FU1 on today's templates → HOLD (no approved natural re-ask); after approval → the S3 follow-up copy", async () => {
  const row = dueRow("s3_asking_price", "s3_no_response_fu1");
  const today = await resolveDeferredQueueMessage(row, { supabase: createDb({ sms_templates: [...APPROVED_S2F, ...proposedS3S4TemplateRows()] }) });
  assert.equal(today.resolved, false);
  assert.equal(today.reason, "no_renderable_no_response_template");
  const approved = proposedS3S4TemplateRows().map((r) => ({ ...r, is_active: true, safe_for_auto_reply: true }));
  const later = await resolveDeferredQueueMessage(row, { supabase: createDb({ sms_templates: approved }) });
  assert.equal(later.resolved, true, later.reason);
  assert.match(later.template_id, /^lc-s3fu1-en-/);
  assert.match(later.message_body, /price/i);
});

// ── 4. ARCHIVE IS VISIBILITY ONLY ──────────────────────────────────────────

test("archive keeps follow-ups: an archived thread is scheduled, dispatched, and never treated as terminal", async () => {
  for (const key of ["S2_template", "S3_template", "S5_offer_typed"]) {
    const { db } = deliveredThread(key, {
      threadState: { is_archived: true, archived_at: "2026-10-07T00:00:00Z", archive_scope: "thread", archive_reason: "operator_cleanup" },
    });
    const out = await deliver(db, sys());
    assert.equal(out.scheduled, true, `${key}: ${out.reason}`);
  }
  // the generic gate: 'archived' is not a terminal lifecycle
  const gate = resolveDeliveryFollowUpDecision({ final_delivery_status: "delivered", provider_message_id: "SM1", followup_intent: "stage_no_reply", lifecycle_stage: "archived" });
  assert.equal(gate.eligible, true);
  // dispatch: archive state is never read
  const db = createDb({ sms_templates: APPROVED_S2F, inbox_thread_state: [{ thread_key: PHONE, is_archived: true, archive_scope: "thread" }] });
  assert.equal((await resolveDeferredQueueMessage(dueRow("s2_interest", "s2_no_response_fu1"), { supabase: db })).resolved, true);
  // the archive authority never cancels or rewrites a queued send
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/domain/lead-visibility/lead-visibility-service.js"), "utf8");
  assert.ok(!/cancelSupabasePendingOutbound|cancelPendingFollowUpsForThread/.test(src), "lead-visibility never cancels follow-ups");
  assert.ok(!/from\(['"]send_queue['"]\)\s*\.(update|delete)/.test(src), "lead-visibility never writes send_queue");
});

test("not-interested nurture on an archived thread is written like any other (archive never blocks scheduling)", async () => {
  const db = createDb({ inbox_thread_state: [{ thread_key: PHONE, is_archived: true }] });
  const out = await scheduleFollowUp("not_interested", PHONE, {
    source: "test", skip_render_context: true, skip_email_lane: true,
    seller_first_name: "Charles", property_address: "12 Oak St", language: "English", agent_name: "Sam",
  }, db);
  assert.equal(out.ok, true, out.reason);
  assert.equal(followups(db)[0].use_case_template, "nurture_not_interested");
});

// ── 5. PROSPECTIVE ONLY + CANARY (owner 2026-10-10) ────────────────────────

test("prospective only: a sending mode with no followup_no_response_enabled_at fails closed (no backlog sweep)", async () => {
  for (const noResponse of ["live", "canary"]) {
    const { db } = deliveredThread("S2_template");
    const out = await deliver(db, sys({ noResponse, enabledAt: null }));
    assert.equal(out.scheduled, false, noResponse);
    assert.equal(out.reason, "no_response_enabled_at_missing", noResponse);
    assert.equal(followups(db).length, 0);
  }
});

test("prospective only: an anchor delivered BEFORE the enable instant never qualifies; one after it does", async () => {
  const sentAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const before = deliveredThread("S2_template", { sentAt });
  const out = await deliver(before.db, sys({ enabledAt: new Date(Date.now() - HOUR).toISOString() }));
  assert.equal(out.scheduled, false);
  assert.equal(out.reason, "anchor_before_enable_cutoff");
  const after = deliveredThread("S2_template", { sentAt });
  assert.equal((await deliver(after.db, sys({ enabledAt: new Date(Date.now() - 3 * HOUR).toISOString() }))).scheduled, true);
});

test("canary: schedules like live (marked canary), honors the daily cap (default 5), never duplicates", async () => {
  const { db } = deliveredThread("S3_template", { threadState: { lifecycle_stage: "asking_price" } });
  const first = await deliver(db, sys({ noResponse: "canary" }));
  assert.equal(first.scheduled, true, first.reason);
  assert.equal(followups(db)[0].metadata.no_response_canary, true);
  const replay = await deliver(db, sys({ noResponse: "canary" }));
  assert.equal(replay.scheduled, false, "idempotent: the same delivery never writes a second row");
  assert.equal(followups(db).length, 1);

  const today = new Date().toISOString();
  const spent = [1, 2].map((n) => ({ id: `spent_${n}`, thread_key: `+1612555000${n}`, type: "followup", queue_status: "scheduled", created_at: today, metadata: { source: "no_response_followup" } }));
  const capped = deliveredThread("S2_template", { extra: {} });
  for (const row of spent) capped.db.rows("send_queue").push(row);
  const out = await deliver(capped.db, sys({ noResponse: "canary", canaryCap: "2" }));
  assert.equal(out.scheduled, false);
  assert.equal(out.reason, "canary_daily_cap_reached:2/2");
  const zero = deliveredThread("S2_template");
  assert.equal((await deliver(zero.db, sys({ noResponse: "canary", canaryCap: "0" }))).reason, "canary_daily_cap_reached:0/0");
});

test("canary/live gates: identity (wrong number / not owner / sold), legal hold, precautionary hold all block", async () => {
  for (const [threadState, extra, reason] of [
    [{ disposition: "wrong_number" }, {}, "identity_not_owner:wrong_number"],
    [{ disposition: "wrong_person" }, {}, "identity_not_owner:wrong_person"],
    [{ disposition: "sold" }, {}, "identity_not_owner:sold"],
    [{ paused_reason: "legal_threat_hold" }, {}, "legal_hold"],
    [{ last_intent: "hostile_or_legal" }, {}, "disposition_rules_own_thread:hostile_or_legal"],
    [{}, { automation_suppressions: [{ id: "h", phone_e164: PHONE, status: "active", suppression_type: "precautionary_no_contact" }] }, "precautionary_hold"],
  ]) {
    const { db } = deliveredThread("S2_template", { threadState, extra });
    const out = await deliver(db, sys({ noResponse: "canary" }));
    assert.equal(out.scheduled, false, reason);
    assert.equal(out.reason, reason);
  }
});

test("stage: a follow-up keeps its anchor's stage — never scheduled or sent once the thread moved past it", async () => {
  const { db } = deliveredThread("S2_template", { threadState: { lifecycle_stage: "asking_price" } });
  const out = await deliver(db, sys());
  assert.equal(out.reason, "thread_stage_advanced:asking_price");
  // and at dispatch
  const advanced = createDb({ sms_templates: APPROVED_S2F, inbox_thread_state: [{ thread_key: PHONE, lifecycle_stage: "offer" }] });
  const res = await resolveDeferredQueueMessage(dueRow("s2_interest", "s2_no_response_fu1"), { supabase: advanced });
  assert.equal(res.resolved, false);
  assert.equal(res.reason, "thread_stage_advanced");
  // same stage (or a stale lower projection) is fine
  const same = createDb({ sms_templates: APPROVED_S2F, inbox_thread_state: [{ thread_key: PHONE, lifecycle_stage: "offer_interest" }] });
  assert.equal((await resolveDeferredQueueMessage(dueRow("s2_interest", "s2_no_response_fu1"), { supabase: same })).resolved, true);
});

// ── 6. Recovery reconciliation fixes (2026-10-10) ──────────────────────────

test("S2 dispatch: an anchor row with no address re-resolves it from properties before parking", async () => {
  const row = dueRow("s2_interest", "s2_no_response_fu1", { property_address: null, property_id: "p-77" });
  const withProp = createDb({ sms_templates: APPROVED_S2F, properties: [{ property_id: "p-77", property_address: "12 Oak St", property_address_city: "Dallas" }] });
  const out = await resolveDeferredQueueMessage(row, { supabase: withProp });
  assert.equal(out.resolved, true, out.reason);
  assert.match(out.message_body, /12 Oak St/);
  assert.equal(out.render_context.property_address, "12 Oak St", "persisted onto the row by the processor");
  const noProp = createDb({ sms_templates: APPROVED_S2F, properties: [] });
  const parked = await resolveDeferredQueueMessage(row, { supabase: noProp });
  assert.equal(parked.resolved, false, "no address anywhere → park, never a blank address");
});

test("nurture dispatch: unknown language holds (language_unknown) — never English", async () => {
  const row = {
    id: "q_nurture", thread_key: PHONE, to_phone_number: PHONE, type: "followup", use_case_template: "nurture_not_interested",
    seller_first_name: "Charles", property_address: "12 Oak St", agent_name: "Sam", language: null, message_body: "",
    metadata: { deferred_message_resolution: true, intent: "not_interested" },
  };
  const out = await resolveDeferredQueueMessage(row, {
    supabase: createDb({ sms_templates: APPROVED_S2F }),
    loadNurtureRenderContext: async () => ({}),
  });
  assert.equal(out.resolved, false);
  // prod names it language_unknown; feat's round-10 resolver names it hold_language
  assert.ok(["language_unknown", "hold_language"].includes(out.reason), out.reason);
});

test("archive is visibility only: no repair SQL filters archived threads out of follow-ups / nurture", () => {
  const dir = path.resolve(import.meta.dirname, "../../scripts/repairs");
  for (const f of ["20261010130000_PROPOSED_rearm_missed_no_response_followups.sql", "20261010130001_PROPOSED_rearm_missed_no_response_followups_write.sql", "20261010130002_PROPOSED_not_interested_30day_nurture.sql"]) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/is_archived\s*,\s*false\)\s*=\s*false|is_archived\s*=\s*false|not\s+(coalesce\()?\s*\w*\.?is_archived/i.test(sql), f);
  }
});

// ── 7. Scheduler heartbeat restored (owner 2026-10-10) ─────────────────────

test("heartbeat: every follow-up leg run stamps followup_no_response_heartbeat_at (+ the legacy key) with the run result; throttled", async () => {
  const { recordFollowUpHeartbeat } = await import("@/lib/domain/seller-flow/delivery-triggered-followup.js");
  const writes = [];
  const setSystemValuesImpl = async (pairs) => { writes.push(pairs); return { ok: true }; };
  const { db } = deliveredThread("S2_template");
  const out = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_anchor", final_delivery_status: "delivered", supabase: db,
    getSystemValueImpl: sys(), setSystemValuesImpl, heartbeatThrottleMs: 0,
  });
  assert.equal(out.scheduled, true, out.reason);
  assert.equal(writes.length, 1);
  assert.ok(Date.parse(writes[0].followup_no_response_heartbeat_at) > 0);
  assert.equal(writes[0].follow_up_scheduler_heartbeat_at, writes[0].followup_no_response_heartbeat_at);
  const last = JSON.parse(writes[0].followup_no_response_last_result);
  assert.equal(last.scheduled, true);
  // even a disabled / no-op run proves the leg is alive
  await maybeScheduleFollowUpAfterDelivery({ provider_message_sid: "SM_x", final_delivery_status: "delivered", supabase: createDb(), getSystemValueImpl: async () => null, setSystemValuesImpl, heartbeatThrottleMs: 0 });
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1].followup_no_response_last_result).reason, "followup_automation_disabled");
  // throttle: a burst is one write; a failing write never throws into the webhook
  const t0 = new Date("2026-10-10T16:00:00Z");
  assert.equal((await recordFollowUpHeartbeat({}, { setSystemValuesImpl, now: t0 })).written, true);
  assert.equal((await recordFollowUpHeartbeat({}, { setSystemValuesImpl, now: new Date(t0.getTime() + 5_000) })).written, false);
  const failing = await recordFollowUpHeartbeat({}, { setSystemValuesImpl: async () => { throw new Error("down"); }, throttleMs: 0 });
  assert.equal(failing.written, false);
});
