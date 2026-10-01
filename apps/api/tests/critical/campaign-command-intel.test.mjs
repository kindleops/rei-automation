import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMAND_CONTROL_KEYS,
  GEO_STATES,
  _resetCommandBookCache,
  batchesOf,
  bucketIntents,
  buildCampaignCommandBook,
  buildCampaignGeo,
  buildCampaignReplyBook,
  buildCampaignIntel,
  deliveryFunnel,
  isCampaignText,
  isConversationRow,
  replyBucketOf,
  senderStateOf,
} from "@/lib/domain/campaigns/campaign-command-intel.js";
import { sanitizeBlockReason } from "@/lib/domain/campaigns/campaign-cockpit.js";

/**
 * CAMPAIGN COMMAND 3.0 — the war room's reads.
 *
 * Shapes are production's, read-only, 2026-10-01 ~10:30Z: "Map area ·
 * Minneapolis, MN · 944 properties" (563 targets: 488 planned, 15 ready, 60
 * held), carrier-filtered first texts retried on another template, automatic
 * replies that inherited the campaign id, Minneapolis numbers whose router
 * counter (messages_sent_today) was never reset, and an operator blocklist.
 */

const CAMPAIGN_ID = "7f2ba659-16ad-463b-851d-3381c81e2e38";
const OTHER_ID = "9799d345-06c7-46d8-9b4d-db8b8a4e2bdc";
const ARCHIVED_ID = "f7d99b2a-4851-4b58-bb07-940b2b9073d6";
const NOW = "2026-10-01T10:30:00.000Z"; // 05:30 CDT — window closed
const SECRET_KEY = "queue_engine_shared_secret";

const controls = [
  { key: "queue_processor_mode", value: "live" },
  { key: "queue_execution_mode", value: "normal" },
  { key: "outbound_sms_enabled", value: "true" },
  { key: "queue_processor_heartbeat_at", value: "2026-10-01T10:29:30Z" },
  { key: "campaign_feeder_heartbeat_at", value: "2026-10-01T10:25:30Z" },
  { key: "queue_per_number_cap", value: "800" },
  { key: "queue_contact_window_start", value: "08:00" },
  { key: "queue_contact_window_end", value: "21:00" },
  { key: "sms_blocked_sender_numbers", value: "+13058975670,+14704920588" },
  { key: "sms_blocked_template_ids", value: "204513" },
  { key: SECRET_KEY, value: "must-never-leave-the-server" },
];

const minneapolis = {
  id: CAMPAIGN_ID, name: "Map area · Minneapolis, MN · 944 properties", status: "active",
  daily_cap: 750, total_cap: 1000, batch_max: 50, market_cap: 400, per_sender_cap: null, send_interval_seconds: 45,
  contact_window_start: "08:00", contact_window_end: "21:00",
  scheduled_for: "2026-09-29T13:00:00Z", activated_at: "2026-09-28T14:35:33Z", created_at: "2026-09-28T12:20:21Z", updated_at: NOW,
  metadata: {
    source: "map_area", timezone: "America/Chicago",
    area: { bbox: [-93.3, 44.9, -93.2, 45.0], vertices: 68, property_count: 944 },
    target_filters: { properties: [{ field_key: "properties.property_id", operator: "in", value: ["1", "2", "3"] }] },
    feeder_last: { at: "2026-10-01T10:20:32Z", bound: "buffer", reason: "no_row_placed", stalled: true, inserted: 0, ready_remaining: 2, skipped_counts_by_reason: { NO_TEMPLATE: 1, TEMPLATE_RENDER_LINT_FAILURE: 1 } },
  },
};
const scheduled = {
  id: OTHER_ID, name: "75+ ACQ SCORE", status: "scheduled", daily_cap: 750, total_cap: 1000,
  contact_window_start: "08:00", contact_window_end: "21:00", scheduled_for: "2026-09-30T16:11:00Z", created_at: "2026-09-30T15:54:51Z",
  metadata: { timezone: "America/Chicago", schedule_missed_for: "2026-09-30T16:11:00Z", target_filters: { properties: [{ field_key: "properties.final_acquisition_score", operator: "gte", value: "75" }] } },
};
const archived = { id: ARCHIVED_ID, name: "ZZ-RESUME-REVERSIBILITY-20260920", status: "archived", created_at: "2026-09-20T04:00:00Z", metadata: {} };

const T = (i) => `t-${i}`;
function targets() {
  return [
    { id: T(1), campaign_id: CAMPAIGN_ID, target_status: "planned", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p1", to_phone_number: "+16120000001" },
    { id: T(2), campaign_id: CAMPAIGN_ID, target_status: "planned", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p2", to_phone_number: "+16120000002" },
    { id: T(3), campaign_id: CAMPAIGN_ID, target_status: "planned", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p3", to_phone_number: "+16120000003" },
    { id: T(4), campaign_id: CAMPAIGN_ID, target_status: "ready", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p4", to_phone_number: "+16120000004" },
    { id: T(5), campaign_id: CAMPAIGN_ID, target_status: "ready", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p5", to_phone_number: "+16120000005" },
    { id: T(6), campaign_id: CAMPAIGN_ID, target_status: "blocked", block_reason: "entity_contact_requires_review", market: "Minneapolis, MN", state: "MN", timezone: "America/Chicago", property_id: "p6", to_phone_number: "+16120000006" },
    { id: "s-1", campaign_id: OTHER_ID, target_status: "ready", market: "Miami, FL", state: "FL", timezone: "America/New_York", property_id: "m1" },
    { id: "s-2", campaign_id: OTHER_ID, target_status: "blocked", block_reason: "entity_contact_requires_review", market: "Miami, FL", state: "FL", timezone: "America/New_York", property_id: "m2" },
  ];
}

const M2 = "+16125092382";
const M3 = "+16125092623";
function queueRows() {
  const base = { campaign_id: CAMPAIGN_ID, type: "campaign_launch", source: "campaign_launch_execution" };
  return [
    // seller 1: first text filtered by the carrier, retried on another template, delivered
    { ...base, id: "q1", campaign_target_id: T(1), to_phone_number: "+16120000001", from_phone_number: M2, queue_status: "failed_transport", template_id: "204513", provider_message_id: "SM1", created_at: "2026-09-28T14:40:00Z", sent_at: "2026-09-28T14:50:00Z", updated_at: "2026-09-28T14:51:00Z", recycle_outcome: "retry_different_template" },
    { ...base, id: "q2", campaign_target_id: T(1), to_phone_number: "+16120000001", from_phone_number: M2, queue_status: "delivered", template_id: "211393", provider_message_id: "SM2", spam_retry_generation: "1", created_at: "2026-09-29T00:01:02.600Z", sent_at: "2026-09-29T13:05:00Z", delivered_at: "2026-09-29T13:05:05Z", updated_at: "2026-09-29T13:05:05Z" },
    // seller 2: delivered, replied, opportunity opened after the send
    { ...base, id: "q3", campaign_target_id: T(2), to_phone_number: "+16120000002", from_phone_number: M3, queue_status: "delivered", template_id: "211393", provider_message_id: "SM3", created_at: "2026-09-29T00:01:02.700Z", sent_at: "2026-09-29T13:10:00Z", delivered_at: "2026-09-29T13:10:04Z", updated_at: "2026-09-29T13:10:04Z" },
    // seller 3: hard bounce (invalid destination) — never a content filter
    { ...base, id: "q4", campaign_target_id: T(3), to_phone_number: "+16120000003", from_phone_number: M3, queue_status: "failed_transport", template_id: "200033", provider_message_id: "SM4", created_at: "2026-09-29T00:01:02.800Z", sent_at: "2026-09-29T13:12:00Z", updated_at: "2026-09-29T13:12:30Z", recycle_outcome: "no_retry:Hard Bounce" },
    // a provider refusal (no SID) and a guard hold: neither left us
    { ...base, id: "q5", campaign_target_id: T(4), to_phone_number: "+16120000004", from_phone_number: M3, queue_status: "failed", template_id: "200033", failed_reason: "provider no sid", created_at: "2026-09-29T00:01:02.900Z", updated_at: "2026-09-29T13:20:00Z" },
    { ...base, id: "q6", campaign_target_id: T(5), to_phone_number: "+16120000005", from_phone_number: M3, queue_status: "blocked_by_health_guard", guard_reason: "sender blocked", created_at: "2026-09-28T14:40:01Z", updated_at: "2026-09-28T14:41:00Z" },
    // the queue still says "sent", the carrier already said undelivered
    { ...base, id: "q7", campaign_target_id: T(3), to_phone_number: "+16120000003", from_phone_number: M3, queue_status: "sent", template_id: "200033", provider_message_id: "SM7", created_at: "2026-09-30T14:40:21.6Z", sent_at: "2026-09-30T15:00:00Z", updated_at: "2026-09-30T15:00:00Z" },
    // an automatic reply that inherited the campaign id — conversation, not a campaign text
    { id: "q8", campaign_id: CAMPAIGN_ID, type: "auto_reply", source: "auto_reply", campaign_target_id: null, to_phone_number: "+16120000002", from_phone_number: M3, queue_status: "delivered", provider_message_id: "SM8", created_at: "2026-09-29T14:00:00Z", sent_at: "2026-09-29T14:00:01Z", delivered_at: "2026-09-29T14:00:03Z", updated_at: "2026-09-29T14:00:03Z" },
    // a proof row is never counted
    { id: "q9", campaign_id: CAMPAIGN_ID, type: "campaign_launch", source: "campaign_launch_execution", campaign_target_id: T(5), queue_status: "scheduled", no_send: "true", created_at: "2026-09-28T12:00:00Z" },
  ];
}

const events = [
  { id: "e1", queue_id: "q1", failure_bucket: "Spam", provider_delivery_status: "failed", created_at: "2026-09-28T14:51:00Z" },
  { id: "e4", queue_id: "q4", failure_bucket: "Hard Bounce", provider_delivery_status: "undelivered", created_at: "2026-09-29T13:12:30Z" },
  { id: "e7", queue_id: "q7", failure_bucket: "Other", provider_delivery_status: "undelivered", created_at: "2026-09-30T15:01:00Z" },
];

const fleet = [
  { id: "n1", phone_number: M2, friendly_name: "MINNEAPOLIS 2", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 209 },
  { id: "n2", phone_number: M3, friendly_name: "MINNEAPOLIS 3", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 281 },
  { id: "n3", phone_number: "+16128060495", friendly_name: "MINNEAPOLIS", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 801 },
  { id: "n4", phone_number: "+13058975670", friendly_name: "Miami (replacement)", market: "Miami, FL", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
  { id: "n5", phone_number: "+17866052999", friendly_name: "MIAMI (cooling)", market: "Miami, FL", status: "active", health_state: "cooling", daily_limit: 800, messages_sent_today: 2 },
  { id: "n6", phone_number: "+13057604780", friendly_name: "Miami", market: "Miami, FL", status: "paused", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
];

const runs = [
  { id: "r1", campaign_id: CAMPAIGN_ID, run_type: "launch_queue_plan", status: "completed", started_at: "2026-09-29T00:01:02.556Z", finished_at: "2026-09-29T00:01:02.931Z", ready_to_queue: 176, queue_rows_planned: 3, queue_rows_created: 3, blocked_counts: { NO_TEMPLATE: 6 }, metadata: { sender_distribution: [{ value: M3, count: 3 }] } },
  { id: "r0", campaign_id: CAMPAIGN_ID, run_type: "launch_queue_plan", status: "completed", started_at: "2026-10-01T10:20:32Z", finished_at: "2026-10-01T10:20:32.4Z", ready_to_queue: 2, queue_rows_planned: 0, queue_rows_created: 0, blocked_counts: { NO_TEMPLATE: 1 } },
];

const opportunities = [
  // opened after the campaign messaged them, then moved a stage
  { id: "o1", primary_thread_key: "+16120000002", acquisition_stage: "property_condition", opportunity_status: "active", created_at: "2026-09-29T15:00:00Z", recommended_offer: 150400, current_offer: 0 },
  // an opportunity that predates the campaign's first text: never attributed
  { id: "o2", primary_thread_key: "+16120000001", acquisition_stage: "closed", opportunity_status: "dead", created_at: "2026-09-01T00:00:00Z" },
];
const history = [
  { id: "h1", opportunity_id: "o1", field_name: "acquisition_stage", previous_value: "offer_interest", new_value: "property_condition", created_at: "2026-09-30T20:20:00Z" },
  { id: "h0", opportunity_id: "o1", field_name: "acquisition_stage", previous_value: null, new_value: "offer_interest", created_at: "2026-09-29T12:00:00Z" },
];

function tables() {
  return {
    campaigns: [minneapolis, scheduled, archived],
    system_control: controls,
    campaign_targets: targets(),
    send_queue: queueRows(),
    message_events: events,
    textgrid_numbers: fleet,
    campaign_runs: runs,
    sms_templates: [
      { template_id: "211393", template_name: "ownership_check_S1_English_211393", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, quarantine_state: "active" },
      { template_id: "204513", template_name: "ownership_check_S1_English_204513", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, quarantine_state: "active" },
    ],
    acquisition_opportunities: opportunities,
    acquisition_opportunity_history: history,
    seller_offers: [],
    closing_cases: [],
    properties: [
      { property_id: "p1", latitude: 44.98, longitude: -93.27, property_address_county_name: "Hennepin", property_address_state: "MN" },
      { property_id: "p2", latitude: 44.99, longitude: -93.28, property_address_county_name: "Hennepin", property_address_state: "MN" },
      { property_id: "p3", latitude: 45.0, longitude: -93.29, property_address_county_name: "Hennepin", property_address_state: "MN" },
      { property_id: "p4", latitude: null, longitude: null, property_address_county_name: "Hennepin", property_address_state: "MN" },
    ],
  };
}

const replySellers = [
  { seller_phone: "+16120000002", seller_name: "Seller Two", sender_phone: M3, first_reply_at: "2026-09-29T13:40:00Z", latest_reply_at: "2026-09-29T13:40:00Z", intent: "ownership_confirmed", asked_to_stop: false, thread_key: "+16120000002", message: "Yes I own it", messages: 1 },
  { seller_phone: "+16120000001", seller_name: null, sender_phone: M2, first_reply_at: "2026-09-29T14:10:00Z", latest_reply_at: "2026-09-29T14:12:00Z", intent: "unclear", asked_to_stop: true, thread_key: "+16120000001", message: "STOP", messages: 2 },
];
const stubResponses = async (id, opts = {}) => ({
  ok: true, campaign_id: id, sellers_messaged: 2, sellers_replied: id === CAMPAIGN_ID ? 2 : 0, reply_messages: 3, sellers_asked_to_stop: 1,
  latest_reply_at: "2026-09-29T14:12:00Z", truncated: false, intents: id === CAMPAIGN_ID ? { ownership_confirmed: 1, unclear: 1 } : {}, latest: [],
  ...(opts.includeSellers ? { sellers: id === CAMPAIGN_ID ? replySellers : [] } : {}),
});

/** PostgREST-shaped fake; any write throws. */
function fakeSupabase(data, { failTables = [] } = {}) {
  const calls = [];
  const writes = [];
  function from(table) {
    const state = { table, columns: null, options: null, filters: [], orders: [], limit: null };
    calls.push(state);
    const matches = () => {
      let out = (data[table] || []).filter((row) => state.filters.every(([op, column, value]) => {
        const v = row[column];
        if (op === "eq") return v === value || (typeof value === "number" && Number(v) === value);
        if (op === "neq") return v !== value;
        if (op === "in") return value.includes(v);
        if (op === "notnull") return v !== null && v !== undefined;
        if (op === "gt") return v !== null && v !== undefined && (typeof value === "number" ? Number(v) > value : String(v) > String(value));
        if (op === "gte") return v !== null && v !== undefined && String(v) >= String(value);
        return true;
      }));
      for (const { column, ascending } of [...state.orders].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[column] ?? null;
          const bv = b[column] ?? null;
          if (av === bv) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return out;
    };
    const failing = () => failTables.includes(table);
    const chain = {
      select(columns, options) { state.columns = columns; state.options = options ?? null; return chain; },
      eq(column, value) { state.filters.push(["eq", column, value]); return chain; },
      neq(column, value) { state.filters.push(["neq", column, value]); return chain; },
      in(column, values) { state.filters.push(["in", column, values]); return chain; },
      not(column, op, value) { if (op === "is" && value === null) state.filters.push(["notnull", column]); return chain; },
      gt(column, value) { state.filters.push(["gt", column, value]); return chain; },
      gte(column, value) { state.filters.push(["gte", column, value]); return chain; },
      order(column, opts = {}) { state.orders.push({ column, ascending: opts.ascending !== false }); return chain; },
      limit(n) { state.limit = n; return chain; },
      async range(fromIndex, toIndex) {
        if (failing()) return { data: null, error: new Error(`${table} unavailable`), count: null };
        const all = matches();
        return { data: all.slice(fromIndex, toIndex + 1), count: state.options?.count === "exact" ? all.length : null, error: null };
      },
      async maybeSingle() {
        if (failing()) return { data: null, error: new Error(`${table} unavailable`) };
        return { data: matches()[0] ?? null, error: null };
      },
      insert() { writes.push(["insert", table]); throw new Error("write attempted"); },
      update() { writes.push(["update", table]); throw new Error("write attempted"); },
      upsert() { writes.push(["upsert", table]); throw new Error("write attempted"); },
      delete() { writes.push(["delete", table]); throw new Error("write attempted"); },
      then(resolve, reject) {
        if (failing()) return Promise.resolve({ data: null, count: null, error: new Error(`${table} unavailable`) }).then(resolve, reject);
        const all = matches();
        const result = state.options?.head ? { data: null, count: all.length, error: null } : { data: state.limit != null ? all.slice(0, state.limit) : all, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  async function rpc(name, args) {
    calls.push({ rpc: name, args });
    if (name === "campaign_target_status_counts") {
      const ids = args?.p_campaign_ids || [];
      const groups = new Map();
      for (const row of data.campaign_targets || []) {
        if (!ids.includes(row.campaign_id)) continue;
        const key = `${row.campaign_id}|${row.target_status}|${row.block_reason || ""}`;
        const g = groups.get(key) || { campaign_id: row.campaign_id, target_status: row.target_status, block_reason: row.block_reason || null, row_count: 0 };
        g.row_count += 1;
        groups.set(key, g);
      }
      return { data: [...groups.values()], error: null };
    }
    writes.push(["rpc", name]);
    throw new Error(`unexpected rpc ${name}`);
  }
  return { from, rpc, calls, writes };
}

// ── pure classifiers ───────────────────────────────────────────────────────

test("replies: grouping never upgrades meaning; asking to stop is an opt-out whatever the intent", () => {
  assert.equal(replyBucketOf("ownership_confirmed"), "other", "owning the property is not interest");
  assert.equal(replyBucketOf("who_is_this"), "other");
  assert.equal(replyBucketOf("asks_offer"), "interested");
  assert.equal(replyBucketOf("asking_price_provided"), "interested");
  assert.equal(replyBucketOf("need_time"), "not_interested", "'not now' is the owner's 30-day nurture, a not-interested");
  assert.equal(replyBucketOf("wrong_number"), "wrong_number");
  assert.equal(replyBucketOf("unclear"), "ambiguous");
  assert.equal(replyBucketOf(""), "ambiguous");
  assert.equal(replyBucketOf("unclear", true), "opt_out");
  assert.equal(replyBucketOf("some_new_intent"), "other", "an unknown code is never dropped");
  assert.deepEqual(bucketIntents({ unclear: 11, opt_out: 10, not_interested: 3, need_time: 1, ownership_confirmed: 2 }), { interested: 0, not_interested: 4, wrong_number: 0, opt_out: 10, ambiguous: 11, other: 2 });
});

test("rows: an automatic reply carrying the campaign id is conversation, never a campaign text", () => {
  const rows = queueRows();
  assert.equal(isCampaignText(rows.find((r) => r.id === "q8")), false);
  assert.equal(isConversationRow(rows.find((r) => r.id === "q8")), true);
  assert.equal(isCampaignText(rows.find((r) => r.id === "q2")), true, "a retry is a campaign text");
  assert.equal(isCampaignText({ type: "outbound", source: "enqueue_campaign_target_one", campaign_target_id: "t" }), true);
  assert.equal(isCampaignText({ type: "outbound", source: "internal_canary", campaign_target_id: "t" }), false);
});

test("delivery funnel: content filter, invalid destination, provider refusal and guard holds stay distinct", () => {
  const rows = queueRows().filter(isCampaignText).filter((r) => r.no_send !== "true");
  const verdicts = new Map(events.map((e) => [e.queue_id, { bucket: e.failure_bucket, receipt: e.provider_delivery_status }]));
  const f = deliveryFunnel(rows, verdicts);
  assert.equal(f.total, 7);
  assert.equal(f.delivered, 2);
  assert.equal(f.filtered, 1, "Spam bucket = carrier content filter");
  assert.equal(f.invalid_destination, 1, "Hard Bounce = invalid destination");
  assert.equal(f.provider_refused, 1, "failed with no SID never left us");
  assert.equal(f.held_at_send, 1, "a guard hold is not a failure");
  assert.equal(f.awaiting_receipt, 1);
  assert.equal(f.receipt_lag, 1, "queue says sent, the carrier said undelivered");
  assert.equal(f.left_us, 5);
  assert.equal(f.accepted, 5);
});

test("sender state: the operator blocklist wins even at zero usage; cooling, paused and the router's counter are named", () => {
  const blocked = new Set(["+13058975670"]);
  const now = new Date(NOW);
  assert.deepEqual(senderStateOf(fleet[3], { blocked, now }), { state: "blocked", reason: "blocked_by_operator", eligible: false });
  assert.equal(senderStateOf(fleet[4], { blocked, now }).state, "cooling");
  assert.equal(senderStateOf(fleet[5], { blocked, now }).state, "paused");
  assert.equal(senderStateOf(fleet[2], { blocked, now }).state, "cap_reached", "the router reads messages_sent_today, which is never reset");
  const ok = senderStateOf(fleet[0], { blocked, now });
  assert.equal(ok.eligible, true);
  assert.equal(ok.state, "unverified", "eligible, but no structured health evidence");
});

test("batches: a feeder pass owns the rows created during it; outcomes and replies roll up per pass", () => {
  const rows = queueRows().filter(isCampaignText);
  const verdicts = new Map(events.map((e) => [e.queue_id, { bucket: e.failure_bucket, receipt: e.provider_delivery_status }]));
  const list = batchesOf(runs, rows, verdicts, new Set([T(2)]));
  assert.equal(list.length, 1, "a pass that placed nothing is not a batch");
  const b = list[0];
  assert.equal(b.created, 3);
  assert.equal(b.matched_rows, 4, "q2,q3,q4,q5 were created inside the pass window");
  assert.equal(b.outcome.delivered, 2);
  assert.equal(b.outcome.replied, 1);
  assert.equal(b.duration_ms, 375);
});

test("held-reason filter accepts canonical codes only", () => {
  assert.equal(sanitizeBlockReason("entity_contact_requires_review"), "entity_contact_requires_review");
  assert.equal(sanitizeBlockReason("insufficient_template_rotation_pool:auto:0<2"), "insufficient_template_rotation_pool:auto:0<2");
  assert.equal(sanitizeBlockReason("x),or(id.eq.1"), null);
  assert.equal(sanitizeBlockReason(""), null);
});

// ── the book ───────────────────────────────────────────────────────────────

test("book: sellers not messages, replies bucketed, archived slim, window in the campaign's zone, no writes, no secrets", async () => {
  _resetCommandBookCache();
  const db = fakeSupabase(tables());
  const book = await buildCampaignCommandBook({ supabase: db, now: NOW, fetchResponses: stubResponses, noCache: true });
  assert.equal(book.ok, true);
  assert.deepEqual(db.writes, []);
  assert.ok(!JSON.stringify(book).includes("must-never-leave-the-server"));
  const controlRead = db.calls.find((c) => c.table === "system_control");
  assert.deepEqual(controlRead.filters[0][2], [...COMMAND_CONTROL_KEYS]);

  const m = book.campaigns.find((c) => c.id === CAMPAIGN_ID);
  assert.deepEqual({ total: m.targets.total, ready: m.targets.ready, planned: m.targets.planned, held: m.targets.held }, { total: 6, ready: 2, planned: 3, held: 1 });
  assert.equal(m.sends.sellers_dispatched, 3, "sellers 1, 2, 3 left us; the refusal and the guard hold did not");
  assert.equal(m.sends.sellers_delivered, 2);
  assert.equal(m.replies, null, "replies come from the reply book, read after the book");
  assert.equal(m.window.open, false, "05:30 CDT");
  assert.equal(m.window.timezone, "America/Chicago");
  assert.equal(m.feeder.stalled, true);
  assert.equal(m.source.kind, "map_area");

  const s = book.campaigns.find((c) => c.id === OTHER_ID);
  assert.equal(s.schedule.missed_for, "2026-09-30T16:11:00.000Z");
  assert.equal(s.sends.sellers_dispatched, 0);

  const a = book.campaigns.find((c) => c.id === ARCHIVED_ID);
  assert.equal(a.archived, true);
  assert.equal(a.targets, undefined, "archived campaigns are listed, not read");
});

test("reply book: only campaigns that messaged someone are read; replies bucketed without upgrading meaning", async () => {
  _resetCommandBookCache();
  const db = fakeSupabase(tables());
  const asked = [];
  const book = await buildCampaignCommandBook({ supabase: db, now: NOW, noCache: true });
  const out = await buildCampaignReplyBook({ supabase: db, book, noCache: true, fetchResponses: async (id, opts) => { asked.push(id); return stubResponses(id, opts); } });
  assert.equal(out.ok, true);
  assert.deepEqual(asked, [CAMPAIGN_ID], "the scheduled campaign never messaged anyone; archived is never read");
  assert.equal(out.replies[CAMPAIGN_ID].sellers_replied, 2);
  assert.equal(out.replies[CAMPAIGN_ID].buckets.other, 1, "ownership confirmed is not interest");
  assert.equal(out.replies[CAMPAIGN_ID].buckets.ambiguous, 1);
  assert.deepEqual(db.writes, []);
});

test("book: a stalled read is abandoned at its ceiling instead of hanging every caller", async () => {
  _resetCommandBookCache();
  const never = { from() { throw new Error("unused"); } };
  const stalled = { ...never, from: () => ({ select: () => ({ order: () => ({ limit: () => new Promise(() => {}) }) }) }) };
  await assert.rejects(buildCampaignCommandBook({ supabase: stalled, timeoutMs: 30 }), (err) => err.code === "read_timeout");
  _resetCommandBookCache();
});

test("book: a section that fails is unavailable, never zero", async () => {
  _resetCommandBookCache();
  const db = fakeSupabase(tables(), { failTables: ["send_queue"] });
  const book = await buildCampaignCommandBook({ supabase: db, now: NOW, fetchResponses: stubResponses, noCache: true });
  assert.ok(book.unavailable.includes("sends"));
  const m = book.campaigns.find((c) => c.id === CAMPAIGN_ID);
  assert.equal(m.sends, null);
  assert.equal(m.queue, null);
});

// ── intel ──────────────────────────────────────────────────────────────────

test("intel: campaign texts vs conversation, retry lineage, attributable outcomes after the first send only", async () => {
  const db = fakeSupabase(tables());
  const intel = await buildCampaignIntel(CAMPAIGN_ID, { supabase: db, now: NOW, fetchResponses: stubResponses });
  assert.equal(intel.ok, true);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(intel.unavailable, []);
  assert.equal(intel.rows.campaign_texts, 7);
  assert.equal(intel.rows.conversation, 1);
  assert.equal(intel.rows.proof, 1);
  assert.deepEqual(intel.sellers, { left_us: 3, delivered: 2, replied: 2 });

  assert.equal(intel.retries.originals_filtered, 1);
  assert.equal(intel.retries.recycled, 1);
  assert.equal(intel.retries.retry_rows, 1);
  assert.equal(intel.retries.retry_delivered, 1);
  assert.equal(intel.retries.no_retry_reasons["Hard Bounce"], 1);

  assert.equal(intel.replies.buckets.other, 1, "ownership confirmed");
  assert.equal(intel.replies.buckets.opt_out, 1, "asked to stop wins over 'unclear'");

  assert.equal(intel.outcomes.opportunities.length, 1, "the opportunity that predates the campaign is not attributed");
  assert.equal(intel.outcomes.opportunities[0].id, "o1");
  assert.equal(intel.outcomes.stage_moves, 1, "the move before the first send does not count");
  assert.equal(intel.outcomes.opportunities[0].recommended_offer, 150400);

  const blockedTemplate = intel.templates.find((t) => t.template_id === "204513");
  assert.equal(blockedTemplate.blocked_by_operator, true);
  assert.equal(blockedTemplate.filtered, 1);
  assert.equal(intel.templates.find((t) => t.template_id === "211393").sellers_replied, 2);

  const m3 = intel.fleet.numbers.find((s) => s.phone === M3);
  assert.equal(m3.router_counter, 281);
  assert.equal(m3.sent_today, 0, "real sends today come from the queue, not the stale counter");
  assert.equal(m3.limit, 800);
  assert.equal(m3.limit_basis, "system");
  const capped = intel.fleet.numbers.find((s) => s.phone === "+16128060495");
  assert.equal(capped.state, "cap_reached");
  assert.equal(capped.remaining_today, 0);

  const route = intel.routing.find((r) => r.market === "Minneapolis, MN");
  assert.equal(route.eligible, 2, "the capped number cannot win routing");
  assert.equal(route.ready, 2);
  assert.equal(intel.batches.list.length, 1);
  assert.equal(intel.series.grain, "hour");
});

// ── geo ────────────────────────────────────────────────────────────────────

test("geo: a delivered retry outranks its filtered original; replies and opportunities mark the seller; unlocated is counted", async () => {
  const db = fakeSupabase(tables());
  const geo = await buildCampaignGeo(CAMPAIGN_ID, { supabase: db, replies: await stubResponses(CAMPAIGN_ID, { includeSellers: true }) });
  assert.equal(geo.ok, true);
  assert.deepEqual(db.writes, []);
  assert.equal(geo.total_targets, 6);
  const stateOf = (lat) => GEO_STATES[geo.points.find((p) => p[0] === lat)[2]];
  assert.equal(stateOf(44.98), "replied", "seller 1 replied (delivered retry)");
  assert.equal(stateOf(44.99), "opportunity");
  assert.equal(stateOf(45), "sent", "seller 3: a later text still awaiting its receipt outranks the earlier hard bounce");
  assert.equal(geo.unlocated, 3, "p4 has no coordinates; p5, p6 have no property row");
  const hennepin = geo.counties.find((c) => c.county === "Hennepin");
  assert.equal(hennepin.sent, 3, "only targets whose texts left us");
  assert.equal(hennepin.opportunities, 1);
});
