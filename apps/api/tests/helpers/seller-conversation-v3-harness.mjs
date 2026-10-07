// Replays one redacted production inbound through the SELLER CONVERSATION v3
// chain, exactly as process-seller-inbound-message wires it with both flags on:
//   buildConversationContext -> classify(heuristicOnly) -> v2 overlay ->
//   v2 plan -> v3 plan -> applySellerConversationV3 ->
//   executeInboundAutomationDecision (dry run, directive + patched classification)
// against a given sms_templates catalog and language switch. Pure: no network.
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  applySellerAutopilotV2Overlay,
  planSellerAutopilotV2,
  resolveV2OfferAuthority,
  buildV2ExecutionDirectives,
} from "@/lib/domain/seller-flow/seller-autopilot-v2.js";
import {
  planSellerConversationV3,
  applySellerConversationV3,
  resolveV3ValueAuthority,
  summarizeV3Outcome,
} from "@/lib/domain/seller-flow/seller-conversation-v3.js";
import { resolveCanonicalAskingPrice, isCommittedAskingPrice } from "@/lib/domain/seller-flow/canonical-asking-price.js";

const THREAD = "+15555550123";

const STAGE_BY_USE_CASE = {
  ownership_check: "ownership_confirmation",
  who_is_this: "ownership_confirmation",
  consider_selling: "offer_interest",
  seller_asking_price: "asking_price",
  ask_condition_clarifier: "property_condition",
  price_high_condition_probe: "property_condition",
};

function makeSupabase(tables) {
  const from = (table) => {
    const filters = [];
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => !(c in r) || (vs || []).map(String).includes(String(r[c]))), chain),
      is: () => chain,
      gte: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) >= String(v)), chain),
      lte: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) <= String(v)), chain),
      lt: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) < String(v)), chain),
      gt: (c, v) => (filters.push((r) => !(c in r) || String(r[c]) > String(v)), chain),
      or: () => chain, not: () => chain, neq: () => chain, order: () => chain, ilike: () => chain,
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

async function withFlags(fn) {
  const keep = { v2: process.env.SELLER_AUTOPILOT_V2, v3: process.env.SELLER_CONVERSATION_V3 };
  process.env.SELLER_AUTOPILOT_V2 = "1";
  process.env.SELLER_CONVERSATION_V3 = "1";
  try {
    return await fn();
  } finally {
    for (const [k, env] of [["v2", "SELLER_AUTOPILOT_V2"], ["v3", "SELLER_CONVERSATION_V3"]]) {
      if (keep[k] === undefined) delete process.env[env];
      else process.env[env] = keep[k];
    }
  }
}

export async function replayV3(fixture, { catalog = [], languages = "English,Spanish", ade_snapshot = null, known_facts = {}, mf_door_comps = [], property_metadata = { property_type: "Single Family" } } = {}) {
  return withFlags(async () => {
    const prior = fixture.prior_question;
    const outbound = prior
      ? [{
          id: "out-1", to_phone_number: THREAD, message_type: prior.message_type, template_id: prior.template_id,
          message_body: prior.text, property_id: "prop-1", provider_message_id: null,
          sent_at: prior.sent_at, delivered_at: prior.delivered_at || prior.sent_at, queue_status: "delivered",
          created_at: prior.sent_at,
        }]
      : [];
    const iso = (v) => (v ? new Date(v).toISOString() : v);
    const events = (fixture.intervening_inbound || []).map((row, i) => ({
      id: `in-${i}`, created_at: iso(row.created_at), direction: "inbound", message_body: row.text, detected_intent: row.intent,
    }));
    const before = prior?.sent_at ? new Date(prior.sent_at).getTime() : new Date(fixture.received_at).getTime();
    for (const [i, row] of (fixture.r7_history || []).entries()) {
      events.push({ id: `h-${i}`, created_at: new Date(before - (i + 1) * 60000).toISOString(), direction: "inbound", message_body: row.text, language: row.language || null });
    }
    const ctxSupabase = makeSupabase({
      send_queue: outbound,
      message_events: events,
      sms_templates: prior?.template_id && prior?.template_use_case ? [{ template_id: prior.template_id, use_case: prior.template_use_case }] : [],
      properties: fixture.valuation ? [{ property_id: "prop-1", ...fixture.valuation }] : [],
    });
    const ctx = await buildConversationContext({ thread_key: THREAD, inbound_received_at: fixture.received_at, supabase: ctxSupabase });
    const raw = await classify(fixture.seller_message, null, { heuristicOnly: true, conversation_context: ctx });
    const stage_before = STAGE_BY_USE_CASE[prior?.template_use_case] || "ownership_confirmation";
    const overlaid = applySellerAutopilotV2Overlay(raw, { message: fixture.seller_message, conversation_context: ctx, stage_before });
    const classification = overlaid.classification;
    const price = resolveCanonicalAskingPrice(fixture.seller_message, { lastQuestion: ctx?.last_outbound_question || null, classification });
    const ask_now = isCommittedAskingPrice(price) ? price.asking_price.value : null;
    const offer_authority = resolveV2OfferAuthority({ ade_snapshot, spendability: ade_snapshot ? { spendable: true } : null, property_metadata });
    const v2_plan = planSellerAutopilotV2({
      classification, message: fixture.seller_message, conversation_context: ctx, stage_before,
      asking_price_this_turn: ask_now, known_asking_price: null, offer_authority,
    });
    const recent_outbound = prior ? [{ use_case: prior.template_use_case || null, template_id: prior.template_id || null, body: prior.text }] : [];
    const plan = planSellerConversationV3({
      classification, message: fixture.seller_message, conversation_context: ctx, stage_before, known_facts,
      asking_price_this_turn: ask_now, v2_plan, offer_authority,
      value_authority: resolveV3ValueAuthority({ ade_snapshot }), property_metadata, ade_snapshot, mf_door_comps, recent_outbound,
    });
    const applied = applySellerConversationV3(classification, plan);
    const v2_directives = applied.applied ? null : buildV2ExecutionDirectives(v2_plan);
    const thread = {
      found: true, inbound_from: THREAD,
      ids: { master_owner_id: "mo-1", prospect_id: "pr-1", property_id: "prop-1" },
      items: {}, flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
      recent: { recently_used_template_ids: recent_outbound.map((r) => r.template_id).filter(Boolean), touch_count: 1, recent_events: [] },
      summary: { conversation_stage: stage_before, property_address: "1 Main St", seller_first_name: "Pat", language_preference: applied.classification.language },
    };
    const result = await executeInboundAutomationDecision({
      message: fixture.seller_message, threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+15555550000",
      ownerId: "mo-1", propertyId: "prop-1", prospectId: "pr-1", latestThreadContext: thread, context: thread,
      classification: applied.classification, inboundEventId: fixture.fixture_id, inboundReceivedAt: fixture.received_at,
      dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
      strategyDirective: applied.strategyDirective || v2_directives?.strategyDirective || null,
      dealAuthority: applied.dealAuthorityPatch || v2_directives?.dealAuthorityPatch || null,
      getSystemValue: async (key) => (key === "seller_autopilot_v2_languages" ? languages : null),
      negotiationQuoteImpl: async () => ({ ok: true, id: "quote-dry" }),
      supabaseClient: makeSupabase({ sms_templates: catalog, send_queue: outbound, properties: [] }),
    });
    const d = result.automation_decision || {};
    const text = result.rendered_message_text || null;
    const suppressed =
      d.should_suppress_contact ||
      raw.automation_decision?.suppression_action === "opt_out" ||
      raw.automation_decision?.suppression_action === "archive_wrong_number";
    const outcome = suppressed
      ? "suppressed"
      : text && !d.should_mark_human_review
        ? "auto_reply"
        : d.should_mark_human_review
          ? "review"
          : "auto_terminal";
    return {
      ctx, raw, classification: applied.classification, plan, v2_plan, planned: summarizeV3Outcome(plan),
      result, decision: d, text, outcome, template: result.selected_template || null,
      review_reason: d.should_mark_human_review ? d.human_review_reason || d.audit_reason || "review" : null,
    };
  });
}
