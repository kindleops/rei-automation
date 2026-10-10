/**
 * Live 2026-10-06 (RC 8.4.2 B), +17276319579, 12051 Willow Trl, Houston,
 * estimated value $182,000.
 *   13:42 opener "Hey Laura, this is Alex. 🙂 Is 12051 Willow Trl yours?"
 *   13:45 "1 million dollars"        -> asking_price_provided -> condition probe (delivered)
 *   13:49 "Great. 1 million dollars" -> asking_price_provided -> SAME probe -> duplicate_blocked -> silence
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { assessAskingPricePlausibility } from "@/lib/domain/classification/price-plausibility.js";
import { resolveCanonicalAskingPrice, isCommittedAskingPrice } from "@/lib/domain/seller-flow/canonical-asking-price.js";
import {
  executeInboundAutomationDecision,
  isRepeatOfRecentOutbound,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const THREAD = "+17276319579";
const PROPERTY_ID = "2131034304";
const OPENER = "Hey Laura, this is Alex. 🙂 Is 12051 Willow Trl yours?";
const CONDITION_PROBE_V1_TEXT =
  "Thanks for the details on 12051 Willow Trl. How would you describe the overall condition — move-in ready, needs some updating, or bigger repairs?";

function makeSupabase(tables = {}) {
  const from = (table) => {
    const filters = [];
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => !(c in r) || (vs || []).map(String).includes(String(r[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain,
      or: () => chain, not: () => chain, neq: () => chain, order: () => chain,
      update: () => chain, insert: () => chain, upsert: () => chain,
      limit: async () => ({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const OPENER_ROW = {
  id: "8ba66550", to_phone_number: THREAD, message_type: null, template_id: "211393", property_id: PROPERTY_ID,
  message_body: OPENER, provider_message_id: null, sent_at: "2026-10-06T13:42:21.843Z",
  delivered_at: "2026-10-06T13:42:30.000Z", queue_status: "delivered", created_at: "2026-10-06T01:46:01Z",
};
const PROBE_ROW = {
  id: "e9b02909", to_phone_number: THREAD, message_type: "Follow-Up", template_id: "cond-probe-v1",
  property_id: PROPERTY_ID, message_body: CONDITION_PROBE_V1_TEXT, provider_message_id: null,
  sent_at: "2026-10-06T13:47:21.861Z", delivered_at: "2026-10-06T13:47:30.000Z", queue_status: "delivered",
  created_at: "2026-10-06T13:45:48.501Z",
};
// Owner rule P0 2026-10-09: only sms_templates rows are ever sent (the code
// registry is never a fallback), so the repeat rule is exercised on approved rows.
const COND_ROW = (n, body) => ({
  id: `cond-${n}`, template_id: `cond-probe-${n}`, use_case: "condition_probe", stage_code: "S4", language: "English",
  is_active: true, safe_for_auto_reply: true, reply_mode: "auto", property_type_scope: "Any Residential",
  allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"],
  template_body: body, usage_count: n === "v1" ? 10 : 1,
});
const COND_ROWS = [
  COND_ROW("v1", "Thanks for the details on {{property_address}}. How would you describe the overall condition — move-in ready, needs some updating, or bigger repairs?"),
  COND_ROW("v2", "Got it. Anything on {{property_address}} that would need attention?"),
];
const PROPERTY = { property_id: PROPERTY_ID, property_address: "12051 Willow Trl", estimated_value: 182000, arv_estimate: null };

async function contextAt(at, outbound) {
  return buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: at,
    supabase: makeSupabase({
      send_queue: outbound,
      message_events: [],
      sms_templates: [{ template_id: "211393", use_case: "ownership_check" }],
      properties: [PROPERTY],
    }),
  });
}

function threadContext() {
  return {
    found: true,
    inbound_from: THREAD,
    ids: { master_owner_id: "mo-laura", prospect_id: "pr-laura", property_id: PROPERTY_ID },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 1, recent_events: [] },
    summary: { conversation_stage: "ownership_confirmation", property_address: "12051 Willow Trl", seller_first_name: "Laura", language_preference: "English" },
  };
}

const tpl = (template_id, use_case, body, extra = {}) => ({
  id: template_id, template_id, use_case, stage_code: "S1", language: "English", is_active: true,
  safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: null, template_body: body,
  updated_at: "2026-10-06T00:00:00Z", usage_count: 0, ...extra,
});
const REALITY_1 = tpl("lc-price-reality-check-en-1", "price_reality_check", "Ha, I wish! Realistically, if the number made sense, is selling something you'd consider?");
const REALITY_2 = tpl("lc-price-reality-check-en-2", "price_reality_check", "Fair enough! If we could land on a realistic number for {{property_address}}, would you be open to selling?", { usage_count: 1 });

function run({ message, classification, tables, strategyDirective = null, dryRun = true, notify = null, inboundEventId }) {
  const ctx = threadContext();
  return executeInboundAutomationDecision({
    message, threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+18325550000",
    ownerId: "mo-laura", propertyId: PROPERTY_ID, prospectId: "pr-laura",
    latestThreadContext: ctx, context: ctx, classification, strategyDirective,
    inboundEventId, inboundReceivedAt: "2026-10-06T13:49:16.768Z",
    dryRun, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: makeSupabase(tables), renderFailureNotifyImpl: notify,
  });
}

// ── 1. implausible asks ─────────────────────────────────────────────────────

test("plausibility rules: ratio to estimate, round joke, absurd word; no valuation -> no judgement", () => {
  const laura = assessAskingPricePlausibility({ amount: 1_000_000, valuation: { estimated_value: 182000 }, message: "1 million dollars" });
  assert.equal(laura.implausible, true);
  assert.equal(laura.rule, "ratio_to_estimate");
  assert.equal(laura.ratio, 5.49);
  assert.equal(laura.reference, 182000);
  assert.equal(assessAskingPricePlausibility({ amount: 300_000, valuation: { estimated_value: 182000 } }).implausible, false);
  assert.equal(assessAskingPricePlausibility({ amount: 1_000_000, valuation: { estimated_value: 395000 }, message: "a million" }).implausible, true);
  assert.equal(assessAskingPricePlausibility({ amount: 900_000, valuation: { estimated_value: 400000 } }).implausible, false);
  assert.equal(assessAskingPricePlausibility({ amount: 1_000_000, valuation: { estimated_value: 950000 } }).implausible, false);
  assert.equal(assessAskingPricePlausibility({ amount: 2_000_000, valuation: { max_comp: 600000 } }).rule, "ratio_to_max_comp");
  assert.equal(assessAskingPricePlausibility({ amount: 1e9, valuation: null, message: "a billion dollars" }).rule, "absurd_word");
  assert.equal(assessAskingPricePlausibility({ amount: 1_000_000, valuation: null, message: "1 million" }).implausible, false);
});

test("Laura 13:45 '1 million dollars' -> asking_price_implausible with evidence; not ownership, not a price fact", async () => {
  const ctx = await contextAt("2026-10-06T13:45:42.947Z", [OPENER_ROW]);
  assert.equal(ctx.property_valuation.estimated_value, 182000);
  const r = await classify("1 million dollars", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.primary_intent, "asking_price_implausible");
  assert.notEqual(r.primary_intent, "ownership_confirmed");
  assert.ok(!(r.secondary_intents || []).includes("asking_price_provided"));
  assert.equal(r.price_parse.qualifies_as_seller_asking_price, false);
  assert.deepEqual(
    { ask: r.price_parse.implausibility.ask, estimate: r.price_parse.implausibility.estimated_value, ratio: r.price_parse.implausibility.ratio },
    { ask: 1000000, estimate: 182000, ratio: 5.49 }
  );
  assert.equal(r.automation_decision.auto_reply_allowed, true);
  assert.equal(r.automation_decision.reply_kind, "price_reality_check");
  // The one money path refuses it, so no asking price persists and the stage cannot move.
  const signal = resolveCanonicalAskingPrice("1 million dollars", { classification: r });
  assert.equal(isCommittedAskingPrice(signal), false);
  assert.equal(signal.commitment_reason, "implausible_price");
  assert.equal(signal.asking_price, null);
});

test("a plausible price on the same house is still asking_price_provided", async () => {
  const ctx = await contextAt("2026-10-06T13:45:42.947Z", [OPENER_ROW]);
  const r = await classify("I'd take 210k", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.primary_intent, "asking_price_provided");
});

test("Laura 13:45: the reply is the reality check, never the condition probe", async () => {
  const ctx = await contextAt("2026-10-06T13:45:42.947Z", [OPENER_ROW]);
  const classification = await classify("1 million dollars", null, { heuristicOnly: true, conversation_context: ctx });
  const result = await run({
    message: "1 million dollars", classification, inboundEventId: "in-1345",
    tables: { sms_templates: [REALITY_1, REALITY_2], send_queue: [OPENER_ROW], properties: [PROPERTY] },
  });
  assert.equal(result.automation_decision.route_hint, "price_reality_check");
  assert.equal(result.selected_template?.use_case, "price_reality_check");
  assert.ok(!String(result.rendered_message_text || "").includes("condition"));
  // With no safe reality-check template: review, never a silent drop.
  const none = await run({ message: "1 million dollars", classification, inboundEventId: "in-1345b", tables: { sms_templates: [], send_queue: [OPENER_ROW], properties: [PROPERTY] } });
  assert.equal(none.queued, false);
  assert.equal(none.automation_decision.should_mark_human_review, true);
});

// ── 2. the repeat-intent stall ──────────────────────────────────────────────

test("Laura 13:49 'Great. 1 million dollars' after the probe: still implausible, a DIFFERENT reply, never the same text", async () => {
  const ctx = await contextAt("2026-10-06T13:49:16.768Z", [PROBE_ROW, OPENER_ROW]);
  const classification = await classify("Great. 1 million dollars", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(classification.primary_intent, "asking_price_implausible");
  const sentReality = { ...PROBE_ROW, id: "rc-1", template_id: REALITY_1.template_id, message_body: REALITY_1.template_body };
  const result = await run({
    message: "Great. 1 million dollars", classification, inboundEventId: "in-1349",
    tables: { sms_templates: [REALITY_1, REALITY_2], send_queue: [sentReality, PROBE_ROW, OPENER_ROW], properties: [PROPERTY] },
  });
  assert.equal(result.selected_template?.template_id, REALITY_2.template_id);
  assert.notEqual(result.rendered_message_text, REALITY_1.template_body);
});

test("generic repeat rule: the condition probe already sent -> its approved variant (v2)", async () => {
  const classification = {
    primary_intent: "asking_price_provided", confidence: 0.92, language: "English",
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply" },
  };
  const directive = {
    strategy: "condition_discovery", reason_code: "S1_TO_S4_ASKING_PRICE_PROVIDED", template_use_case: "condition_probe",
    allowed_template_use_cases: ["condition_probe"], next_action: "send_message_now", review_required: false,
  };
  const result = await run({
    message: "250k", classification, strategyDirective: directive, inboundEventId: "in-generic",
    tables: { sms_templates: COND_ROWS, send_queue: [PROBE_ROW, OPENER_ROW], properties: [PROPERTY] },
  });
  assert.equal(result.selected_template?.template_id, "cond-probe-v2");
  assert.ok(result.rendered_message_text && result.rendered_message_text !== CONDITION_PROBE_V1_TEXT);
  assert.ok(!result.rendered_message_text.includes("{{"));
});

test("generic repeat rule: every variant already sent -> review repeat_intent_no_alternative + operator alert; nothing queued", async () => {
  const classification = {
    primary_intent: "asking_price_provided", confidence: 0.92, language: "English",
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply" },
  };
  const directive = {
    strategy: "condition_discovery", reason_code: "S1_TO_S4_ASKING_PRICE_PROVIDED", template_use_case: "condition_probe",
    allowed_template_use_cases: ["condition_probe"], next_action: "send_message_now", review_required: false,
  };
  const v2Row = { ...PROBE_ROW, id: "v2", template_id: "cond-probe-v2", message_body: "Got it. Anything on 12051 Willow Trl that would need attention?" };
  const alerts = [];
  const result = await run({
    message: "250k", classification, strategyDirective: directive, inboundEventId: "in-noalt", dryRun: false,
    notify: async (p) => (alerts.push(p), { ok: true }),
    tables: { sms_templates: COND_ROWS, send_queue: [v2Row, PROBE_ROW, OPENER_ROW], properties: [PROPERTY] },
  });
  assert.equal(result.queued, false);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(result.automation_decision.human_review_reason, "repeat_intent_no_alternative");
  assert.equal(result.automation_decision.repeat_guard.outcome, "no_alternative");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].eventType, "inbox_auto_reply_blocked");
});

test("isRepeatOfRecentOutbound: same template id or identical text (whitespace/case-insensitive)", () => {
  const recent = [{ template_id: "a", message_body: "Hello   there" }];
  assert.equal(isRepeatOfRecentOutbound({ template: { template_id: "a" }, renderedText: "x", recent }), true);
  assert.equal(isRepeatOfRecentOutbound({ template: { template_id: "b" }, renderedText: "hello there", recent }), true);
  assert.equal(isRepeatOfRecentOutbound({ template: { template_id: "b" }, renderedText: "different", recent }), false);
});
