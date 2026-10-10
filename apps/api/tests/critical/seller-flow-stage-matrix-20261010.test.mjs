/**
 * OWNER FLOW (binding, 2026-10-10): S1 ownership → S2 offer interest → S3
 * asking price → S4 condition → S5 offer → S6–S10 negotiation / contract /
 * closing. Never skip a stage.
 *
 *   - "yes I'd sell / what's your offer / max you'll give / how much" before we
 *     hold the seller's price → S3 asking price (an approved sms_templates row);
 *   - never a condition question before the price;
 *   - commercial assets never get residential condition wording — an
 *     asset-compatible approved row, or a hold for a human;
 *   - every word is an approved sms_templates row.
 *
 * Owner-reported prod failures this matrix pins:
 *   #1 "What is the max you'll give" (asks_offer) after our S3 question →
 *      ask_condition_clarifier (pre-8.5.3, audit MISSING_FACT_ASKING_PRICE but
 *      negotiation_strategy condition_discovery).
 *   #2 commercial strip mall → local-template:condition_probe:v1 residential
 *      "move-in ready" copy.
 *   #3 "$290k firm" → local-template condition_probe "Thanks for the details…".
 *
 * Template fixtures are the live prod rows as of 2026-10-10 (the robotic
 * clarifiers lc-ask-condition-clarifier-en/es-1 are DEACTIVATED, condition_probe
 * rows are inactive, 550002 / 550102 S4B are the only auto-safe condition copy).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  executeInboundAutomationDecision,
  applyStage3AskingPriceRule,
  resolveSellerPriceKnown,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { isRegistryTemplateId } from "@/lib/domain/templates/template-authority.js";
import { isTemplateCompatibleWithProperty } from "@/lib/domain/templates/template-asset-compatibility.js";
import { proposedS3S4TemplateRows } from "../../scripts/ops/s3-s4-natural-templates.proposed.mjs";

const THREAD = "+15550001111";
const PROPERTY_ID = "2127840038";
const RESIDENTIAL = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const COMMERCIAL = ["self_storage", "retail", "office", "industrial", "hotel_motel", "mobile_home_park", "other_commercial"];

// ── live prod rows (2026-10-10) ─────────────────────────────────────────────
const S3_EN = {
  id: "5d6bfa0f-b6d3-4b47-b1cf-7220722a93df", template_id: "occ_seller_asking_price_en_v1",
  use_case: "seller_asking_price", stage_code: "S3", language: "English", is_active: true,
  safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: null, allowed_property_groups: null,
  template_body: "Got it. What price would you have in mind for the property?",
};
const S3_COMMERCIAL_EN = {
  id: "78885306-7b31-4775-83fa-faf8c709887b", template_id: "lc-s3-asking-price-commercial-en-01",
  use_case: "seller_asking_price", stage_code: "S3", language: "English", is_active: true,
  safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Commercial (Other)",
  allowed_property_groups: COMMERCIAL,
  prohibited_property_groups: [...RESIDENTIAL, "land"],
  template_body: "Got it. Do you have an asking price in mind for the property?",
};
const S4B_EN = {
  id: "634df2e7-2e62-41f3-bd79-baf609f75574", template_id: "550002", use_case: "price_high_condition_probe",
  stage_code: "S4B", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Residential", allowed_property_groups: RESIDENTIAL,
  template_body: "Got it. Is the property updated, or does it need work?",
};
// Deactivated 2026-10-10 by the owner (backup _bk_condition_clarifier_20261010).
const CLARIFIER_EN_INACTIVE = {
  id: "84356a5e-3bc6-4d48-a228-0a157ee88b5b", template_id: "lc-ask-condition-clarifier-en-1",
  use_case: "ask_condition_clarifier", stage_code: "S4", language: "English", is_active: false,
  safe_for_auto_reply: false, reply_mode: "auto", property_type_scope: "Any Residential", allowed_property_groups: RESIDENTIAL,
  template_body: "Thanks, could you tell me a little more about the condition? Anything major like roof, HVAC, or foundation?",
};
const CONDITION_PROBE_EN_INACTIVE = {
  id: "c6e5295b-c784-4652-98a1-7f8a80387898", template_id: "lc-condition-probe-en-1", use_case: "condition_probe",
  stage_code: "S4", language: "English", is_active: false, safe_for_auto_reply: false, reply_mode: "auto",
  property_type_scope: "Any Residential", allowed_property_groups: RESIDENTIAL,
  template_body: "Happy to. To get you a real number, is it vacant right now or occupied?",
};
const PROD_TEMPLATES = [S3_EN, S3_COMMERCIAL_EN, S4B_EN, CLARIFIER_EN_INACTIVE, CONDITION_PROBE_EN_INACTIVE];

const ASSETS = {
  sfr: { property_id: PROPERTY_ID, property_type: "Single Family", property_class: "Residential" },
  retail: { property_id: PROPERTY_ID, property_type: "Other", property_class: "Commercial", is_commercial_retail: true },
};

/** Table-aware, filter-aware double. Inactive rows are filtered by the real `.eq("is_active", true)`. */
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

function threadContext(stage) {
  return {
    found: true,
    inbound_from: THREAD,
    ids: { master_owner_id: "mo_test", prospect_id: "p_test", property_id: PROPERTY_ID },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 3, recent_events: [] },
    summary: {
      conversation_stage: stage,
      seller_stage: stage,
      property_address: "120 E Main St",
      seller_first_name: "Pat",
      agent_name: "Sam",
      language_preference: "English",
      last_inbound_at: "2026-10-09T18:43:49.695Z",
    },
  };
}

const CLASSIFICATIONS = {
  asks_offer: (message) => ({
    primary_intent: "asks_offer", confidence: 0.9, language: "English", reply_language_source: "seller_reply",
    price_parse: { value: null, qualifies_as_seller_asking_price: false },
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false },
    message,
  }),
  asking_price_provided: (message) => ({
    primary_intent: "asking_price_provided", confidence: 0.93, language: "English", reply_language_source: "seller_reply",
    price_parse: { value: 290000, qualifies_as_seller_asking_price: true },
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false },
    message,
  }),
};

function run({ message, intent, stage, asset, directive = null, templates = PROD_TEMPLATES, priceKnown = false }) {
  const ctx = threadContext(stage);
  return executeInboundAutomationDecision({
    message,
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundTo: "+15550002222",
    ownerId: ctx.ids.master_owner_id,
    propertyId: PROPERTY_ID,
    prospectId: ctx.ids.prospect_id,
    latestThreadContext: ctx,
    context: ctx,
    classification: CLASSIFICATIONS[intent](message),
    transitionDirective: directive,
    effectiveStageBefore: stage,
    sellerAskingPriceKnown: priceKnown,
    inboundEventId: `evt-${intent}-${stage}-${asset}`,
    inboundReceivedAt: "2026-10-09T18:43:49.695Z",
    dryRun: true,
    autoReplyMode: "dry_run",
    applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: templates, properties: [ASSETS[asset]] }),
  });
}

const textOf = (r) => String(r.rendered_message_text || r.queue_result?.message_body || "");
const CONDITION_WORDS = /condition|repair|move-in|roof|hvac|foundation|updated|need(s)? work|vacant|occupied/i;
const RESIDENTIAL_WORDS = /move-in|roof|hvac|foundation|house|home\b|bedroom|kitchen/i;

// ── 1. Pure Stage 3 rule: stages S1–S10 × intents (price unknown / known) ──

const PRE_OFFER_STAGES = ["ownership_confirmation", "offer_interest", "asking_price", "property_condition"];
const POST_OFFER_STAGES = ["offer", "negotiation", "formal_contract", "under_contract", "disposition", "closing", "closed"];
const CONDITION_ROUTES = ["condition_probe", "ask_condition_clarifier", "price_high_condition_probe", "occupancy_probe", "repair_clarification"];

test("matrix (pure): price question before we hold their price → S3 at every pre-offer stage", () => {
  for (const stage of PRE_OFFER_STAGES) {
    for (const intent of ["asks_offer", "offer_request"]) {
      for (const route of [null, ...CONDITION_ROUTES]) {
        const out = applyStage3AskingPriceRule(
          { should_queue_reply: true, route_hint: route, required_template_use_case: route, allowed_template_stages: route ? [route] : [] },
          { classification: { primary_intent: intent }, seller_price_known: false, stage }
        );
        const cell = `${stage} × ${intent} × ${route}`;
        assert.equal(out.required_template_use_case, "seller_asking_price", cell);
        assert.deepEqual(out.allowed_template_stages, ["seller_asking_price"], cell);
        assert.equal(out.condition_questions_forbidden, true, cell);
      }
    }
  }
});

test("matrix (pure): any condition route before the price → S3 (or a human when they have no number)", () => {
  for (const stage of PRE_OFFER_STAGES) {
    for (const intent of ["positive_interest", "seller_interested", "condition_disclosed", "info_request", "unclear"]) {
      for (const route of CONDITION_ROUTES) {
        const out = applyStage3AskingPriceRule(
          { should_queue_reply: true, route_hint: route, required_template_use_case: route, allowed_template_stages: [route] },
          { classification: { primary_intent: intent }, seller_price_known: false, stage }
        );
        assert.equal(out.required_template_use_case, "seller_asking_price", `${stage} × ${intent} × ${route}`);
      }
    }
    for (const route of CONDITION_ROUTES) {
      const out = applyStage3AskingPriceRule(
        { should_queue_reply: true, route_hint: route, required_template_use_case: route },
        { classification: { primary_intent: "asking_price_absent" }, seller_price_known: false, stage }
      );
      assert.equal(out.should_queue_reply, false, `${stage} × asking_price_absent × ${route}`);
      assert.equal(out.human_review_reason, "condition_before_seller_price_forbidden");
    }
  }
});

test("matrix (pure): price KNOWN → S4 condition is allowed and the decision is untouched", () => {
  for (const stage of [...PRE_OFFER_STAGES, ...POST_OFFER_STAGES]) {
    for (const route of CONDITION_ROUTES) {
      const decision = { should_queue_reply: true, route_hint: route, required_template_use_case: route };
      const known = resolveSellerPriceKnown({ classification: CLASSIFICATIONS.asking_price_provided("$290k firm") });
      assert.equal(known, true);
      assert.equal(applyStage3AskingPriceRule(decision, { classification: { primary_intent: "asking_price_provided" }, seller_price_known: known, stage }), decision, `${stage} × ${route}`);
    }
  }
});

test("matrix (pure): S5–S10 price questions belong to negotiation / contract lanes — never rerouted to S3", () => {
  for (const stage of POST_OFFER_STAGES) {
    for (const route of ["counter_offer", "best_price_request", "final_offer", "contract_information_request"]) {
      const out = applyStage3AskingPriceRule(
        { should_queue_reply: true, route_hint: route, required_template_use_case: route, allowed_template_stages: [route] },
        { classification: { primary_intent: "asks_offer" }, seller_price_known: false, stage }
      );
      assert.equal(out.required_template_use_case, route, `${stage} × ${route}`);
    }
  }
});

test("matrix (pure): resolveSellerPriceKnown — asks_offer / max-you'll-give never counts as holding their price", () => {
  for (const intent of ["asks_offer", "offer_request", "positive_interest", "seller_interested", "ownership_confirmed"]) {
    assert.equal(resolveSellerPriceKnown({ classification: { primary_intent: intent } }), false, intent);
  }
  assert.equal(resolveSellerPriceKnown({ classification: { primary_intent: "asking_price_provided" } }), true);
  assert.equal(resolveSellerPriceKnown({ classification: { primary_intent: "asking_price_implausible" } }), true);
});

// ── 2. Executor end-to-end on the live template set: stages × assets ──────

const PROD_CONDITION_DIRECTIVE = { required_template_use_case: "condition_probe", stage_after: "asking_price", reasoning_code: "missing_property_condition" };

for (const stage of ["ownership_confirmation", "offer_interest", "asking_price"]) {
  for (const message of ["What is the max you'll give", "how much would you pay?", "Yes I'd sell, what's your offer?"]) {
    test(`e2e #1: "${message}" at ${stage} (SFR) → the approved S3 row, never condition`, async () => {
      for (const directive of [null, PROD_CONDITION_DIRECTIVE]) {
        const result = await run({ message, intent: "asks_offer", stage, asset: "sfr", directive });
        assert.equal(result.selected_template?.template_id, "occ_seller_asking_price_en_v1", JSON.stringify(result.automation_decision?.human_review_reason));
        assert.equal(result.automation_decision.required_template_use_case, "seller_asking_price");
        assert.ok(!CONDITION_WORDS.test(textOf(result)), textOf(result));
      }
    });
  }
}

test("e2e #1/#2: asks_offer on a RETAIL asset → the approved commercial S3 row (asset-compatible), never residential copy", async () => {
  for (const stage of ["ownership_confirmation", "offer_interest", "asking_price"]) {
    const result = await run({ message: "How much is do u think?", intent: "asks_offer", stage, asset: "retail", directive: PROD_CONDITION_DIRECTIVE });
    assert.equal(result.selected_template?.template_id, "lc-s3-asking-price-commercial-en-01", stage);
    assert.equal(textOf(result), "Got it. Do you have an asking price in mind for the property?");
  }
});

test("e2e #2: commercial asset with its price KNOWN → no residential condition copy; hold for a human (no compatible approved S4 row)", async () => {
  for (const directive of [PROD_CONDITION_DIRECTIVE, { ...PROD_CONDITION_DIRECTIVE, required_template_use_case: "price_high_condition_probe" }, null]) {
    const result = await run({ message: "$2.9M firm", intent: "asking_price_provided", stage: "asking_price", asset: "retail", directive, priceKnown: true });
    assert.equal(result.queued, false, JSON.stringify(directive));
    const text = textOf(result);
    assert.ok(!RESIDENTIAL_WORDS.test(text), text);
    assert.ok(!isRegistryTemplateId(result.selected_template?.template_id));
    if (result.selected_template) {
      assert.ok(
        isTemplateCompatibleWithProperty({ template: result.selected_template, propertyGroup: "retail" }).compatible,
        result.selected_template.template_id
      );
    }
  }
});

test("e2e #3: \"$290k firm\" (SFR, price KNOWN) — today's live set: the clarifier is inactive, condition_probe has no active row → HOLD, never registry copy", async () => {
  const result = await run({ message: "$290k firm", intent: "asking_price_provided", stage: "asking_price", asset: "sfr", directive: PROD_CONDITION_DIRECTIVE, priceKnown: true });
  assert.equal(result.queued, false);
  assert.equal(result.selected_template, null);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.ok(!String(JSON.stringify(result)).includes("local-template:"));
  assert.ok(!String(JSON.stringify(result)).includes("lc-ask-condition-clarifier"));
});

test("e2e #3: price KNOWN and the route is S4B (price above value) → the approved 550002 row", async () => {
  const result = await run({
    message: "$290k firm", intent: "asking_price_provided", stage: "asking_price", asset: "sfr", priceKnown: true,
    directive: { required_template_use_case: "price_high_condition_probe", stage_after: "property_condition", reasoning_code: "price_above_value" },
  });
  assert.equal(result.selected_template?.template_id, "550002");
  assert.equal(textOf(result), "Got it. Is the property updated, or does it need work?");
});

test("e2e #3: once the owner approves the PROPOSED natural S4 rows, price-known SFR sends one of them; retail sends a commercial one", async () => {
  const approved = proposedS3S4TemplateRows()
    .filter((r) => r.use_case === "condition_probe")
    .map((r) => ({ ...r, id: r.template_id, is_active: true, safe_for_auto_reply: true }));
  const sfr = await run({ message: "$290k firm", intent: "asking_price_provided", stage: "asking_price", asset: "sfr", directive: PROD_CONDITION_DIRECTIVE, priceKnown: true, templates: [...PROD_TEMPLATES, ...approved] });
  assert.match(String(sfr.selected_template?.template_id), /^lc-s4-cond-res-en-/);
  const retail = await run({ message: "$2.9M firm", intent: "asking_price_provided", stage: "asking_price", asset: "retail", directive: PROD_CONDITION_DIRECTIVE, priceKnown: true, templates: [...PROD_TEMPLATES, ...approved] });
  assert.match(String(retail.selected_template?.template_id), /^lc-s4-cond-com-en-/);
  assert.ok(!RESIDENTIAL_WORDS.test(textOf(retail)), textOf(retail));
});

// ── 3. PROPOSED copy integrity ─────────────────────────────────────────────

test("proposed S3/S4 rows: inactive, unique ids, render, asset words compatible with their own group", async () => {
  const { personalizeTemplate } = await import("@/lib/sms/personalize_template.js");
  const rows = proposedS3S4TemplateRows();
  assert.ok(rows.length >= 24);
  assert.equal(new Set(rows.map((r) => r.template_id)).size, rows.length);
  for (const r of rows) {
    assert.equal(r.is_active, false, r.template_id);
    assert.equal(r.safe_for_auto_reply, false, r.template_id);
    assert.equal(personalizeTemplate(r.template_body, { seller_first_name: "Ana", agent_name: "Sam" }).ok, true, r.template_id);
    assert.ok(!/\$|\d{2,}/.test(r.template_body), `no money in ${r.template_id}`);
    const group = r.allowed_property_groups[0];
    assert.ok(isTemplateCompatibleWithProperty({ template: r, propertyGroup: group }).compatible, `${r.template_id} vs ${group}`);
    if (r.template_id.includes("-com-")) {
      assert.ok(!RESIDENTIAL_WORDS.test(r.template_body), r.template_id);
      assert.equal(isTemplateCompatibleWithProperty({ template: r, propertyGroup: "sfr" }).compatible, false, r.template_id);
    }
  }
});

// ── 4. LIVE S4 rows (owner 2026-10-10): only when the condition is MISSING ──

const S4_RES_EN = {
  id: "86fc2409-1b92-4d6d-b194-d1f22e67e7f7", template_id: "lc-s4-condition-res-en-01", use_case: "condition_probe",
  stage_code: "S4", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Residential", allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily"],
  prohibited_property_groups: [...COMMERCIAL, "land", "multifamily_5_plus"],
  template_body: "Got it. How's the property overall? Anything that needs work?",
};
const S4_COM_EN = {
  id: "b8daba64-0f6c-4572-9d48-cb27bc64616d", template_id: "lc-s4-condition-com-en-01", use_case: "condition_probe",
  stage_code: "S4", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Commercial (Other)", allowed_property_groups: [...COMMERCIAL, "multifamily_5_plus"],
  prohibited_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "land"],
  template_body: "Got it. How's the building overall? Any major repairs or deferred maintenance?",
};
const LIVE_S4 = [...PROD_TEMPLATES, S4_RES_EN, S4_COM_EN];

test("live S4: price held, condition MISSING → SFR gets the residential row, retail the commercial row", async () => {
  const sfr = await run({ message: "$290k firm", intent: "asking_price_provided", stage: "asking_price", asset: "sfr", directive: PROD_CONDITION_DIRECTIVE, priceKnown: true, templates: LIVE_S4 });
  assert.equal(sfr.selected_template?.template_id, "lc-s4-condition-res-en-01");
  assert.equal(textOf(sfr), "Got it. How's the property overall? Anything that needs work?");
  const retail = await run({ message: "$2.9M firm", intent: "asking_price_provided", stage: "asking_price", asset: "retail", directive: PROD_CONDITION_DIRECTIVE, priceKnown: true, templates: LIVE_S4 });
  assert.equal(retail.selected_template?.template_id, "lc-s4-condition-com-en-01");
  assert.ok(!RESIDENTIAL_WORDS.test(textOf(retail)), textOf(retail));
});

test("live S4: condition ALREADY KNOWN (state, or said in this reply) → never re-asked; held for the next step", async () => {
  const fromState = await executeInboundAutomationDecision({
    message: "$290k firm", threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+15550002222", propertyId: PROPERTY_ID,
    context: threadContext("asking_price"), latestThreadContext: threadContext("asking_price"),
    classification: CLASSIFICATIONS.asking_price_provided("$290k firm"), transitionDirective: PROD_CONDITION_DIRECTIVE,
    effectiveStageBefore: "asking_price", sellerAskingPriceKnown: true, sellerConditionKnown: true,
    inboundEventId: "evt-cond-known", dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: LIVE_S4, properties: [ASSETS.sfr] }),
  });
  assert.equal(fromState.queued, false);
  assert.equal(fromState.selected_template, null);
  assert.equal(fromState.automation_decision.human_review_reason, "condition_already_known");

  const inReply = await executeInboundAutomationDecision({
    message: "290k firm, it needs a new roof", threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+15550002222", propertyId: PROPERTY_ID,
    context: threadContext("asking_price"), latestThreadContext: threadContext("asking_price"),
    classification: { ...CLASSIFICATIONS.asking_price_provided("290k firm, it needs a new roof"), secondary_intents: ["condition_disclosed"] },
    transitionDirective: PROD_CONDITION_DIRECTIVE, effectiveStageBefore: "asking_price", sellerAskingPriceKnown: true,
    inboundEventId: "evt-cond-in-reply", dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: LIVE_S4, properties: [ASSETS.sfr] }),
  });
  assert.ok(!/overall|needs work|repairs/i.test(textOf(inReply)), textOf(inReply));
  assert.notEqual(inReply.selected_template?.use_case, "condition_probe");
});

test("live S4: condition disclosed but price NOT held → S3 asking price (never S4, never a hold)", async () => {
  const result = await run({
    message: "It needs a new roof, what would you offer?", intent: "asks_offer", stage: "offer_interest", asset: "sfr",
    directive: PROD_CONDITION_DIRECTIVE, templates: LIVE_S4,
  });
  assert.equal(result.selected_template?.template_id, "occ_seller_asking_price_en_v1");
});

test("pure: applyConditionKnownRule only touches condition routes", async () => {
  const { applyConditionKnownRule, resolveSellerConditionKnown } = await import("@/lib/domain/seller-flow/apply-inbound-automation-decision.js");
  const offer = { should_queue_reply: true, required_template_use_case: "initial_offer", route_hint: "initial_offer" };
  assert.equal(applyConditionKnownRule(offer, { condition_known: true }), offer);
  const cond = { should_queue_reply: true, required_template_use_case: "condition_probe" };
  assert.equal(applyConditionKnownRule(cond, { condition_known: false }), cond);
  assert.equal(applyConditionKnownRule(cond, { condition_known: true }).should_queue_reply, false);
  assert.equal(resolveSellerConditionKnown({ classification: { primary_intent: "condition_disclosed" } }), true);
  assert.equal(resolveSellerConditionKnown({ classification: { primary_intent: "asking_price_provided" } }), false);
});
