/**
 * P0 2026-10-09 — strip-mall (retail) thread, Mesquite TX.
 *
 *   S1 "do you still own the commercial property …?" → "Yes"
 *   S2 "Thanks for confirming. Would you consider a proposal …?" (operator)
 *   seller: "How much is do u think?"            (asks_offer, 0.92)
 *   autopilot sent local-template:condition_probe:v1 — code registry copy,
 *   no sms_templates row, a condition question before we had their price.
 *
 * Decision path in prod (0ea4554a):
 *   resolve-seller-next-best-action.js:321  asking_price skipped (seller_requests_offer)
 *     → DISCOVER_CONDITION, reason missing_property_condition
 *   resolve-seller-response-strategy.js:32  → condition_probe
 *   process-seller-inbound-message.js:641   resolveTransitionDirective → required condition_probe
 *   apply-inbound-automation-decision.js:3029 lifecycle_resolver authority
 *   apply-inbound-automation-decision.js:1717 no sms_templates row → local registry fallback
 *
 * OWNER RULES (binding): Stage 3 is ALWAYS the asking price; never ask about
 * condition before we have their price; every sent word is an sms_templates
 * row — registry / hard-coded copy is never sent by automation.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  executeInboundAutomationDecision,
  applyStage3AskingPriceRule,
  resolveSellerPriceKnown,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  evaluateTemplateAuthority,
  isRegistryTemplateId,
  TEMPLATE_NOT_IN_SUPABASE,
} from "@/lib/domain/templates/template-authority.js";
import { evaluateAndBlockSendAtCompliance } from "@/lib/domain/queue/block-send-at-compliance.js";
import { resolveNonSpendableNextAction, NON_SPENDABLE_REASONS } from "@/lib/domain/seller-flow/valuation-offer-authority.js";

const THREAD = "+15550001111";
const PROPERTY_ID = "2127840038";

// The approved prod rows (sms_templates, 2026-10-09).
const S3_EN = {
  id: "5d6bfa0f-b6d3-4b47-b1cf-7220722a93df", template_id: "occ_seller_asking_price_en_v1",
  use_case: "seller_asking_price", stage_code: "S3", language: "English", is_active: true,
  safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: null, allowed_property_groups: null,
  template_body: "Got it. What price would you have in mind for the property?",
};
const S4_CLARIFIER_EN = {
  id: "84356a5e-3bc6-4d48-a228-0a157ee88b5b", template_id: "lc-ask-condition-clarifier-en-1",
  use_case: "ask_condition_clarifier", stage_code: "S4", language: "English", is_active: true,
  safe_for_auto_reply: true, reply_mode: "auto", property_type_scope: "Any Residential",
  allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"],
  template_body: "Thanks, could you tell me a little more about the condition? Anything major like roof, HVAC, or foundation?",
  success_rate: 99,
};
const S4B_EN = {
  id: "634df2e7-2e62-41f3-bd79-baf609f75574", template_id: "550002", use_case: "price_high_condition_probe",
  stage_code: "S4B", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Residential",
  allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"],
  template_body: "Got it. Is the property updated, or does it need work?",
};
const SFR = { property_id: PROPERTY_ID, property_type: "Single Family", property_class: "Residential" };
const RETAIL = { property_id: PROPERTY_ID, property_type: "Other", property_class: "Commercial", is_commercial_retail: true };

/** Table-aware, filter-aware double (limit + maybeSingle). */
function makeSupabase(tables = {}) {
  const updates = [];
  const from = (table) => {
    const filters = [];
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => String(r?.[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => (vs || []).map(String).includes(String(r?.[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain,
      or: () => chain, not: () => chain, neq: () => chain, order: () => chain, ilike: () => chain,
      update: (payload) => (updates.push({ table, payload }), chain),
      insert: () => chain, upsert: () => chain,
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { from, updates, rpc: async () => ({ data: null, error: null }) };
}

function threadContext() {
  return {
    found: true,
    inbound_from: THREAD,
    ids: { master_owner_id: "mo_test", prospect_id: "p_test", property_id: PROPERTY_ID },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 2, recent_events: [] },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: "120 E Main St",
      seller_first_name: "Pat",
      agent_name: "Sam",
      language_preference: "English",
      last_inbound_at: "2026-10-09T23:58:25.610Z",
    },
  };
}

// The prod classification of "How much is do u think?".
const ASKS_OFFER = {
  primary_intent: "asks_offer",
  confidence: 0.92,
  language: "English",
  reply_language_source: "seller_reply",
  price_parse: { value: null, qualifies_as_seller_asking_price: false },
  automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false },
};

// Exactly what prod handed the executor: the lifecycle resolver's condition_probe.
const PROD_DIRECTIVE = {
  required_template_use_case: "condition_probe",
  stage_after: "asking_price",
  reasoning_code: "missing_property_condition",
};

function run({ tables, transitionDirective = PROD_DIRECTIVE, sellerAskingPriceKnown = false, classification = ASKS_OFFER }) {
  const ctx = threadContext();
  return executeInboundAutomationDecision({
    message: "How much is do u think?",
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundTo: "+15550002222",
    ownerId: ctx.ids.master_owner_id,
    propertyId: PROPERTY_ID,
    prospectId: ctx.ids.prospect_id,
    latestThreadContext: ctx,
    context: ctx,
    classification,
    transitionDirective,
    effectiveStageBefore: "asking_price",
    sellerAskingPriceKnown,
    inboundEventId: "5f90d025-8805-4f67-b7ad-7ac13d61c31d",
    inboundReceivedAt: "2026-10-09T23:58:25.610Z",
    dryRun: true,
    autoReplyMode: "dry_run",
    applySuppression: false,
    supabaseClient: makeSupabase(tables),
  });
}

const text = (r) => String(r.rendered_message_text || r.queue_result?.message_body || "");

test("the prod thread: asks_offer before we hold a price → S3 asking-price row, never condition / registry", async () => {
  const result = await run({ tables: { sms_templates: [S3_EN, S4_CLARIFIER_EN, S4B_EN], properties: [SFR] } });
  assert.equal(result.selected_template?.template_id, "occ_seller_asking_price_en_v1");
  assert.equal(result.automation_decision.required_template_use_case, "seller_asking_price");
  assert.equal(result.automation_decision.template_authority, "stage3_asking_price_rule");
  assert.equal(result.automation_decision.stage3_rerouted_from, "condition_probe");
  assert.equal(text(result), "Got it. What price would you have in mind for the property?");
  assert.ok(!/condition|repairs|move-in/i.test(text(result)), text(result));
  assert.ok(!isRegistryTemplateId(result.selected_template?.template_id));
});

test("no lifecycle directive (intent profile only): asks_offer still lands on seller_asking_price", async () => {
  const result = await run({ tables: { sms_templates: [S3_EN, S4_CLARIFIER_EN, S4B_EN], properties: [SFR] }, transitionDirective: null });
  assert.equal(result.selected_template?.template_id, "occ_seller_asking_price_en_v1");
});

test("retail asset: no approved asset-compatible S3 row → Needs Review hold with a clear reason, nothing sent", async () => {
  // occ_seller_asking_price_* carries no scope (= residential under the asset
  // rule); scope is NOT widened here (owner decision pending).
  const result = await run({ tables: { sms_templates: [S3_EN, S4_CLARIFIER_EN, S4B_EN], properties: [RETAIL] } });
  assert.equal(result.queued, false);
  assert.equal(result.selected_template, null);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(result.automation_decision.human_review_reason, "asset_compatible_template_missing");
  assert.match(String(result.automation_decision.human_review_detail || ""), /seller_asking_price.*retail/);
});

test("no sms_templates row for the route → hold template_not_in_supabase; the code registry is never used", async () => {
  // Price KNOWN so the lifecycle condition_probe stands: prod had no
  // condition_probe row and fell back to local-template:condition_probe:v1.
  const result = await run({
    tables: { sms_templates: [], properties: [SFR] },
    sellerAskingPriceKnown: true,
  });
  assert.equal(result.queued, false);
  assert.equal(result.selected_template, null);
  assert.equal(result.automation_decision.human_review_reason, TEMPLATE_NOT_IN_SUPABASE);
  assert.ok(!String(JSON.stringify(result)).includes("local-template:"), "no registry id anywhere in the decision");
});

test("Stage 3 rule (pure): condition is forbidden before the price; allowed after it", () => {
  const before = applyStage3AskingPriceRule(
    { should_queue_reply: true, route_hint: "condition_probe", required_template_use_case: "condition_probe", allowed_template_stages: ["condition_probe"] },
    { classification: { primary_intent: "condition_disclosed" }, seller_price_known: false, stage: "asking_price" }
  );
  assert.equal(before.required_template_use_case, "seller_asking_price");
  assert.equal(before.condition_questions_forbidden, true);

  const absent = applyStage3AskingPriceRule(
    { should_queue_reply: true, route_hint: "condition_probe", required_template_use_case: "condition_probe" },
    { classification: { primary_intent: "asking_price_absent" }, seller_price_known: false }
  );
  assert.equal(absent.should_queue_reply, false);
  assert.equal(absent.human_review_reason, "condition_before_seller_price_forbidden");

  const after = { should_queue_reply: true, route_hint: "price_high_condition_probe", required_template_use_case: "price_high_condition_probe" };
  assert.equal(applyStage3AskingPriceRule(after, { classification: { primary_intent: "asking_price_provided" }, seller_price_known: true }), after);

  assert.equal(resolveSellerPriceKnown({ classification: { primary_intent: "asks_offer" } }), false);
  assert.equal(resolveSellerPriceKnown({ classification: { price_parse: { qualifies_as_seller_asking_price: true } } }), true);
});

test("non-spendable valuation without the seller's price → ask the price (S3); condition only after it (S4B)", () => {
  for (const reason of Object.values(NON_SPENDABLE_REASONS)) {
    assert.equal(resolveNonSpendableNextAction({ reason }).use_case, "seller_asking_price", reason);
    const after = resolveNonSpendableNextAction({ reason }, { seller_asking_price_known: true }).use_case;
    assert.ok(["price_high_condition_probe", "ask_condition_clarifier"].includes(after), `${reason} → ${after}`);
  }
});

test("code-authored safe clarifier copy is never sent by automation", async () => {
  const result = await executeInboundAutomationDecision({
    message: "??",
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundTo: "+15550002222",
    propertyId: PROPERTY_ID,
    context: threadContext(),
    latestThreadContext: threadContext(),
    classification: { primary_intent: "unclear", confidence: 0.4, language: "English", automation_decision: { auto_reply_allowed: true } },
    inboundEventId: "evt-clarifier",
    dryRun: true,
    autoReplyMode: "dry_run",
    applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: [], properties: [SFR] }),
  });
  assert.ok(!String(result.selected_template?.template_id || "").startsWith("safe_clarifier_"));
  assert.ok(!String(JSON.stringify(result.selected_template || {})).includes("safe_clarifier_"));
});

// ── send-time hard rule (system-wide) ──────────────────────────────────────

test("send-time template authority: registry / empty / unknown ids are refused; approved rows and manual copy pass", async () => {
  const supabase = makeSupabase({ sms_templates: [S3_EN] });
  const verdict = (queue_row, manual_operator_send = false) =>
    evaluateTemplateAuthority({ supabase, queue_row, manual_operator_send });

  const local = await verdict({ template_id: "local-template:condition_probe:v1" });
  assert.equal(local.allowed, false);
  assert.equal(local.reason, TEMPLATE_NOT_IN_SUPABASE);
  assert.equal(local.detail, "registry_template_id");

  const clar = await verdict({ template_id: "safe_clarifier_intent_offer" });
  assert.equal(clar.allowed, false);

  const none = await verdict({ template_id: null });
  assert.equal(none.allowed, false);
  assert.equal(none.detail, "missing_template_id");

  const unknown = await verdict({ template_id: "not-a-row" });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.detail, "template_row_not_found");

  assert.equal((await verdict({ template_id: "occ_seller_asking_price_en_v1" })).allowed, true);
  assert.equal((await verdict({ template_id: S3_EN.id })).allowed, true, "row uuid also resolves");
  assert.equal((await verdict({ template_id: null, message_type: "manual_reply" }, true)).allowed, true, "operator's own words");
});

test("system-wide: map ownership check must carry a real row; workflow free text under a real id is refused", async () => {
  const supabase = makeSupabase({ sms_templates: [S3_EN] });
  const map = (template_id) =>
    evaluateTemplateAuthority({
      supabase,
      manual_operator_send: true,
      queue_row: { template_id, metadata: { source: "map_command", action: "send_ownership_check" } },
    });
  assert.equal((await map(null)).allowed, false, "a template-picked manual send must stamp its template id");
  assert.equal((await map("local-template:ownership_check:v1")).allowed, false);
  assert.equal((await map("occ_seller_asking_price_en_v1")).allowed, true);

  const wf = (message_body) =>
    evaluateTemplateAuthority({
      supabase,
      queue_row: { template_id: "occ_seller_asking_price_en_v1", message_body, metadata: { source: "workflow" } },
    });
  const free = await wf("Hey, what would you take for it? We pay cash fast.");
  assert.equal(free.allowed, false);
  assert.equal(free.detail, "body_not_rendered_from_template");
  assert.equal((await wf("Got it. What price would you have in mind for the property?")).allowed, true);
});

test("final send guard: an automated local-template row is HELD for review, the provider is never reached", async () => {
  const supabase = makeSupabase({ sms_templates: [S3_EN] });
  const row = {
    id: "55c4bb2a-9075-48da-a936-ec644ccc0712",
    queue_status: "processing",
    type: "auto_reply",
    template_id: "local-template:condition_probe:v1",
    selected_template_id: "local-template:condition_probe:v1",
    metadata: { source: "auto_reply" },
  };
  const out = await evaluateAndBlockSendAtCompliance(row, {
    supabase,
    manual_operator_send: false,
    evaluateCanonicalContactability: async () => ({ blocked: false }),
    runSendTimeContactGuard: async () => ({ blocked: false }),
  });
  assert.equal(out.blocked, true);
  assert.equal(out.result.reason, TEMPLATE_NOT_IN_SUPABASE);
  assert.equal(out.result.queue_status, "paused_operator_review");
  assert.equal(out.result.held_for_review, true);
  const hold = supabase.updates.find((u) => u.table === "send_queue");
  assert.equal(hold.payload.queue_status, "paused_operator_review");
  assert.equal(hold.payload.metadata.needs_review_reason, TEMPLATE_NOT_IN_SUPABASE);

  // Same row with an approved template passes this gate.
  const ok = await evaluateAndBlockSendAtCompliance(
    { ...row, template_id: "occ_seller_asking_price_en_v1", selected_template_id: "occ_seller_asking_price_en_v1" },
    {
      supabase,
      evaluateCanonicalContactability: async () => ({ blocked: false }),
      runSendTimeContactGuard: async () => ({ blocked: false }),
      evaluateTemplateAuthority: (args) => evaluateTemplateAuthority(args),
    }
  );
  assert.equal(ok.blocked, false);
});

test("no automated selection path in seller-flow can produce a local-template:* send", () => {
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"),
    "utf8"
  );
  assert.ok(!src.includes('source: "local_registry"'), "registry rows are never shaped into a selectable template");
  assert.ok(!src.includes("verifyLocalAutoReplyApproval"), "the registry approval shortcut is gone");
  assert.ok(!src.includes("? natural_reply.text"), "model rewrites never replace template copy");
});
