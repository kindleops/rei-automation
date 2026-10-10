/**
 * 2026-10-05 hotfix: sellers who GAVE A PRICE got no reply.
 *
 * Yanli Mu ("199k sale", +18323149479, 15:36) and Frank L Hutchinson III
 * ("1 million for the property", +17138051340, 16:44) were classified
 * asking_price_provided, the flow chose local-template:condition_probe:v1
 * ("Thanks for the details on {{property_address}}. ...") and the render failed
 * on {{property_address}}: campaign_launch_execution rows keep the address only
 * in send_queue.metadata (target_snapshot / candidate_snapshot), the column
 * send_queue.property_address is NULL, so the thread summary had no address.
 * AUTOMATION_NEEDS_REVIEW reason=template_render_failed, nothing queued, no alert.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  executeInboundAutomationDecision,
  hydrateReplyAddressContext,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const THREAD = "+18323149479";
const PROPERTY_ID = "2131429162";

// The real campaign row shape (property_address column NULL).
const CAMPAIGN_ROW = {
  id: "sq-yanli",
  to_phone_number: "+18323149479",
  property_id: PROPERTY_ID,
  property_address: null,
  created_at: "2026-10-05T15:34:37.743Z",
  metadata: {
    campaign_target_id: "ct-yanli",
    target_snapshot: { property_address: "3706 E Lockwood Dr, Houston, Tx 77026" },
    candidate_snapshot: { property_address_full: "3706 E Lockwood Dr, Houston, Tx 77026", property_city: "Houston" },
  },
};

/** Table-aware, filter-aware double. */
function makeSupabase(tables = {}) {
  const calls = [];
  const from = (table) => {
    const filters = [];
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => String(r?.[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => (vs || []).map(String).includes(String(r?.[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain,
      or: () => chain, not: () => chain, neq: () => chain,
      order: () => chain,
      update: () => chain, insert: () => chain, upsert: () => chain,
      limit: async () => {
        calls.push(table);
        return { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { from, calls, rpc: async () => ({ data: null, error: null }) };
}

function threadContext({ address = null } = {}) {
  return {
    found: true,
    inbound_from: THREAD,
    ids: { master_owner_id: "mo_bfacff4a7d8c939f93015d57", prospect_id: "150100471237", property_id: PROPERTY_ID },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 1, recent_events: [] },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: address,
      property_type: "Single Family",
      seller_first_name: "Yanli",
      language_preference: "English",
      last_inbound_at: "2026-10-05T15:36:37.360Z",
    },
  };
}

const CONDITION_DIRECTIVE = {
  strategy: "condition_discovery",
  reason_code: "S1_TO_S4_ASKING_PRICE_PROVIDED",
  template_use_case: "condition_probe",
  allowed_template_use_cases: ["condition_probe"],
  next_action: "send_message_now",
  review_required: false,
};

function runPriceReply({ supabase, ctx, dryRun = true, notify = null, catalog = null }) {
  return executeInboundAutomationDecision({
    message: "199k sale",
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundTo: "+18325550000",
    ownerId: ctx.ids.master_owner_id,
    propertyId: PROPERTY_ID,
    prospectId: ctx.ids.prospect_id,
    latestThreadContext: ctx,
    context: ctx,
    classification: {
      primary_intent: "asking_price_provided",
      confidence: 0.92,
      language: "English",
      automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply" },
    },
    strategyDirective: CONDITION_DIRECTIVE,
    inboundEventId: "3589ea05-6ca9-4916-a96e-a0641adb9fdb",
    inboundReceivedAt: "2026-10-05T15:36:37.360Z",
    dryRun,
    autoReplyMode: "dry_run",
    applySuppression: false,
    supabaseClient: supabase,
    renderFailureNotifyImpl: notify,
  });
}

const renderedText = (r) => String(r.rendered_message_text || r.queue_result?.message_body || "");

// ── hydration sources ───────────────────────────────────────────────────────

test("hydration: properties.property_address (canonical) wins", async () => {
  const supabase = makeSupabase({
    properties: [{ property_id: PROPERTY_ID, property_address: "3706 E Lockwood Dr", property_address_full: "3706 E Lockwood Dr, Houston, Tx 77026" }],
    send_queue: [CAMPAIGN_ROW],
  });
  const out = await hydrateReplyAddressContext({ supabase, context: threadContext(), propertyId: PROPERTY_ID, threadKey: THREAD });
  assert.equal(out.summary.property_address, "3706 E Lockwood Dr");
  assert.equal(out.summary.property_address_source, "properties");
});

test("hydration: the opener queue row's metadata snapshot when properties has nothing", async () => {
  const supabase = makeSupabase({ properties: [], send_queue: [CAMPAIGN_ROW] });
  const out = await hydrateReplyAddressContext({ supabase, context: threadContext(), propertyId: PROPERTY_ID, threadKey: THREAD });
  assert.equal(out.summary.property_address, "3706 E Lockwood Dr");
  assert.equal(out.summary.property_address_source, "send_queue");
});

test("hydration: campaign_targets as the last source", async () => {
  const bare = { ...CAMPAIGN_ROW, metadata: { campaign_target_id: "ct-yanli" } };
  const supabase = makeSupabase({
    properties: [],
    send_queue: [bare],
    campaign_targets: [{ id: "ct-yanli", property_id: PROPERTY_ID, property_address: "3706 E Lockwood Dr, Houston, Tx 77026" }],
  });
  const out = await hydrateReplyAddressContext({ supabase, context: threadContext(), propertyId: PROPERTY_ID, threadKey: THREAD });
  assert.equal(out.summary.property_address, "3706 E Lockwood Dr");
  assert.equal(out.summary.property_address_source, "campaign_targets");
});

test("hydration: an address already on the thread is kept and nothing is queried", async () => {
  const supabase = makeSupabase({});
  const out = await hydrateReplyAddressContext({ supabase, context: threadContext({ address: "1 Main St" }), propertyId: PROPERTY_ID, threadKey: THREAD });
  assert.equal(out.summary.property_address, "1 Main St");
  assert.deepEqual(supabase.calls, []);
});

// ── the price-provided reply ────────────────────────────────────────────────
// Owner rule P0 2026-10-09: only sms_templates rows are sent (this file used to
// rely on local-template:condition_probe:v1); the approved address-bearing row:
const ADDRESS_CONDITION_ROW = {
  id: "cond-addr-row", template_id: "cond-addr-row", use_case: "condition_probe", stage_code: "S4",
  language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto",
  property_type_scope: "Any Residential",
  template_body: "Thanks for the details on {{property_address}}. How would you describe the overall condition: move-in ready, needs some updating, or bigger repairs?",
};

for (const [label, tables] of [
  ["properties", { properties: [{ property_id: PROPERTY_ID, property_address: "3706 E Lockwood Dr" }] }],
  ["send_queue metadata", { send_queue: [CAMPAIGN_ROW] }],
  ["campaign_targets", {
    send_queue: [{ ...CAMPAIGN_ROW, metadata: { campaign_target_id: "ct-yanli" } }],
    campaign_targets: [{ id: "ct-yanli", property_id: PROPERTY_ID, property_address: "3706 E Lockwood Dr, Houston, Tx 77026" }],
  }],
]) {
  test(`price-provided reply renders with the address from ${label}, no raw {{`, async () => {
    const result = await runPriceReply({ supabase: makeSupabase({ ...tables, sms_templates: [ADDRESS_CONDITION_ROW] }), ctx: threadContext() });
    assert.notEqual(result.audit_reason, "template_render_failed");
    assert.equal(result.automation_decision.should_mark_human_review, false);
    assert.ok(result.selected_template, "a template is selected");
    const text = renderedText(result);
    assert.ok(text.includes("3706 E Lockwood Dr"), text);
    assert.ok(!text.includes("{{") && !text.includes("}}"), text);
  });
}

test("no address anywhere: falls back to an approved variant WITHOUT {{property_address}}", async () => {
  const NO_ADDRESS_VARIANT = {
    id: "cond-generic", template_id: "cond-generic", use_case: "condition_probe", stage_code: "S4",
    language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto",
    property_type_scope: "Any Residential",
    template_body: "Got it, thanks. How would you describe the condition: move-in ready, needs some updating, or bigger repairs?",
  };
  const ADDRESS_VARIANT = { ...NO_ADDRESS_VARIANT, id: "cond-addr", template_id: "cond-addr", template_body: "Thanks for the details on {{property_address}}. What condition is it in?", usage_count: -1 };
  const result = await runPriceReply({
    supabase: makeSupabase({ sms_templates: [ADDRESS_VARIANT, NO_ADDRESS_VARIANT] }),
    ctx: threadContext(),
  });
  assert.notEqual(result.audit_reason, "template_render_failed");
  assert.equal(result.selected_template?.template_id, "cond-generic");
  const text = renderedText(result);
  assert.ok(text.length > 0 && !text.includes("{{"), text);
});

test("nothing renders: human review + operator alert, never a raw {{ and never silent", async () => {
  const alerts = [];
  const result = await runPriceReply({
    supabase: makeSupabase({ sms_templates: [ADDRESS_CONDITION_ROW] }),
    ctx: threadContext(),
    dryRun: false,
    notify: async (payload) => (alerts.push(payload), { ok: true }),
  });
  assert.equal(result.audit_reason, "template_render_failed");
  assert.equal(result.queued, false);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(result.rendered_message_text, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].eventType, "inbox_auto_reply_blocked");
  assert.ok(alerts[0].description.includes("property_address"), alerts[0].description);
  assert.equal(alerts[0].deduplicationKey, "auto_reply_render_failed:3589ea05-6ca9-4916-a96e-a0641adb9fdb");
});
