// Replays one redacted production inbound through the live decision chain:
// buildConversationContext -> classify(heuristicOnly) -> executeInboundAutomationDecision
// (dry run) against a given sms_templates catalog. Pure: no network.
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const THREAD = "+15555550123";

const STAGE_BY_USE_CASE = {
  ownership_check: "ownership_confirmation",
  who_is_this: "ownership_confirmation",
  consider_selling: "offer_interest",
  seller_asking_price: "asking_price",
  ask_condition_clarifier: "property_condition",
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

export async function replayReply(fixture, { catalog = [] } = {}) {
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
  // Older seller messages (before our last outbound), newest first.
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
  const classification = await classify(fixture.seller_message, null, { heuristicOnly: true, conversation_context: ctx });
  const stage = STAGE_BY_USE_CASE[prior?.template_use_case] || "ownership_confirmation";
  const thread = {
    found: true, inbound_from: THREAD,
    ids: { master_owner_id: "mo-1", prospect_id: "pr-1", property_id: "prop-1" },
    items: {}, flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 1, recent_events: [] },
    summary: { conversation_stage: stage, property_address: "1 Main St", seller_first_name: "Pat", language_preference: classification.language },
  };
  const result = await executeInboundAutomationDecision({
    message: fixture.seller_message, threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+15555550000",
    ownerId: "mo-1", propertyId: "prop-1", prospectId: "pr-1", latestThreadContext: thread, context: thread,
    classification, inboundEventId: fixture.fixture_id, inboundReceivedAt: fixture.received_at,
    dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: catalog, send_queue: outbound, properties: [] }),
  });
  const d = result.automation_decision || {};
  const text = result.rendered_message_text || null;
  const outcome = d.should_suppress_contact || classification.automation_decision?.suppression_action === "opt_out" || classification.automation_decision?.suppression_action === "archive_wrong_number"
    ? "suppressed"
    : text && !d.should_mark_human_review
      ? "auto_reply"
      : d.should_mark_human_review
        ? "review"
        : "no_reply_by_design";
  return { ctx, classification, result, decision: d, text, outcome, template: result.selected_template || null };
}
