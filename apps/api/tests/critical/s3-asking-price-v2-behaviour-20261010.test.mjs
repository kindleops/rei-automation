/**
 * Stage 3 asking-price rows LIVE 2026-10-10 (owner):
 *   lc-s3-asking-price-res-en-02 / lc-s3-asking-price-com-en-02
 *   use_case seller_asking_price, S3, auto-safe — "Got it. What price would you be looking for?"
 *
 * Behaviour (residential AND commercial):
 *   (a) sent only when the seller is interested and gave no price;
 *   (b) never when a price was already given — incl. multi-fact replies
 *       ("yes I'd sell, 250k, needs a roof");
 *   (c) a seller asking for OUR offer is never parsed as THEIR price → S3;
 *   (d) no offer is manufactured;
 *   (e) a Spanish seller never gets English; no approved ES row → hold.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { classify } from "@/lib/domain/classification/classify.js";

const THREAD = "+15550003333";
const PROPERTY_ID = "2127840099";
const RES = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const COM = ["self_storage", "retail", "office", "industrial", "hotel_motel", "mobile_home_park", "other_commercial"];

const S3_RES_02 = {
  id: "s3-res-02", template_id: "lc-s3-asking-price-res-en-02", use_case: "seller_asking_price", stage_code: "S3",
  language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Residential", allowed_property_groups: RES, prohibited_property_groups: [...COM, "land"],
  template_body: "Got it. What price would you be looking for?",
};
const S3_COM_02 = {
  id: "s3-com-02", template_id: "lc-s3-asking-price-com-en-02", use_case: "seller_asking_price", stage_code: "S3",
  language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: "Commercial (Other)", allowed_property_groups: COM, prohibited_property_groups: [...RES, "land"],
  template_body: "Got it. What price would you be looking for?",
};
const S3_ES = {
  id: "9740716e-1686-4c75-b60e-72497cb87cfd", template_id: "occ_seller_asking_price_es_v1", use_case: "seller_asking_price",
  stage_code: "S3", language: "Spanish", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
  property_type_scope: null, allowed_property_groups: null,
  template_body: "Entendido. ¿Qué precio tendría en mente para la propiedad?",
};
const S4_RES = {
  id: "s4-res", template_id: "lc-s4-condition-res-en-01", use_case: "condition_probe", stage_code: "S4", language: "English",
  is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Residential",
  allowed_property_groups: ["sfr", "duplex", "triplex", "fourplex", "small_multifamily"],
  prohibited_property_groups: [...COM, "land", "multifamily_5_plus"],
  template_body: "Got it. How's the property overall? Anything that needs work?",
};
const LIVE = [S3_RES_02, S3_COM_02, S3_ES, S4_RES];
const S3_IDS = { sfr: new Set(["lc-s3-asking-price-res-en-02"]), retail: new Set(["lc-s3-asking-price-com-en-02"]) };

const ASSETS = {
  sfr: { property_id: PROPERTY_ID, property_type: "Single Family", property_class: "Residential" },
  retail: { property_id: PROPERTY_ID, property_type: "Other", property_class: "Commercial", is_commercial_retail: true },
};

function makeSupabase(tables = {}) {
  const from = (table) => {
    const filters = [];
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => String(r?.[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => (vs || []).map(String).includes(String(r?.[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain,
      or: () => chain, not: () => chain, neq: () => chain, order: () => chain, ilike: () => chain,
      update: () => chain, insert: () => chain, upsert: () => chain,
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

function ctx(stage, language = "English") {
  return {
    found: true, inbound_from: THREAD,
    ids: { master_owner_id: "mo_s3", prospect_id: "p_s3", property_id: PROPERTY_ID },
    items: {}, flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 3, recent_events: [] },
    summary: {
      conversation_stage: stage, seller_stage: stage, property_address: "12 Oak St", seller_first_name: "Pat",
      agent_name: "Sam", language_preference: language, last_inbound_at: "2026-10-10T15:00:00.000Z",
    },
  };
}

const ok = { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false };
const C = {
  interested: (language = "English") => ({ primary_intent: "seller_interested", confidence: 0.92, language, reply_language_source: "seller_reply", price_parse: { value: null, qualifies_as_seller_asking_price: false }, automation_decision: ok }),
  asks_offer: (language = "English") => ({ primary_intent: "asks_offer", confidence: 0.9, language, reply_language_source: "seller_reply", price_parse: { value: null, qualifies_as_seller_asking_price: false }, automation_decision: ok }),
};

function run({ message, classification, stage = "offer_interest", asset = "sfr", templates = LIVE, priceKnown = null, conditionKnown = null, language = "English" }) {
  const c = ctx(stage, language);
  return executeInboundAutomationDecision({
    message, threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+15550004444",
    ownerId: c.ids.master_owner_id, propertyId: PROPERTY_ID, prospectId: c.ids.prospect_id,
    latestThreadContext: c, context: c, classification, effectiveStageBefore: stage,
    sellerAskingPriceKnown: priceKnown, sellerConditionKnown: conditionKnown,
    inboundEventId: `evt-${asset}-${message.length}`, inboundReceivedAt: "2026-10-10T15:00:00.000Z",
    dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: makeSupabase({ sms_templates: templates, properties: [ASSETS[asset]] }),
  });
}
const textOf = (r) => String(r.rendered_message_text || r.queue_result?.message_body || "");
const OFFER_USE_CASES = /offer|anchor|comp_|reveal|accept_terms/i;

// (a) interested, no price → the live S3 row (asset-matched)
for (const asset of ["sfr", "retail"]) {
  test(`(a) ${asset}: interested + no price given → the live S3 asking-price row`, async () => {
    for (const [message, classification] of [["Yes I'd consider it", C.interested()], ["What would you offer?", C.asks_offer()]]) {
      const result = await run({ message, classification, asset });
      assert.ok(S3_IDS[asset].has(String(result.selected_template?.template_id)), `${message}: ${result.selected_template?.template_id} ${result.automation_decision?.human_review_reason}`);
      assert.equal(textOf(result), "Got it. What price would you be looking for?");
    }
  });
}

// (b) a price was given → never S3 (single and multi-fact)
for (const asset of ["sfr", "retail"]) {
  test(`(b) ${asset}: a price already given ("250k", "yes I'd sell, 250k, needs a roof") → never the S3 question`, async () => {
    for (const message of ["250k", "yes I'd sell, 250k, needs a roof", "I'd take 250,000 for it"]) {
      const classification = await classify(message, null, { heuristicOnly: true });
      assert.equal(classification.price_parse?.qualifies_as_seller_asking_price, true, `${message} must hold a seller price`);
      const result = await run({ message, classification: { ...classification, automation_decision: ok }, asset, stage: "asking_price" });
      assert.notEqual(result.selected_template?.use_case, "seller_asking_price", message);
      assert.ok(!/what price would you be looking for/i.test(textOf(result)), `${message}: ${textOf(result)}`);
    }
  });
}

// (c) asking for OUR offer is never THEIR price → S3
test("(c) 'what's your offer / max you'll give / how much would you pay' never parse as the seller's price → S3", async () => {
  for (const message of ["What is the max you'll give", "how much would you pay?", "What's your best offer?", "Yes I'd sell, what's your offer?"]) {
    const classification = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(classification.price_parse?.qualifies_as_seller_asking_price, true, message);
    assert.notEqual(classification.primary_intent, "asking_price_provided", message);
    for (const asset of ["sfr", "retail"]) {
      const result = await run({ message, classification: { ...classification, automation_decision: ok }, asset });
      assert.ok(S3_IDS[asset].has(String(result.selected_template?.template_id)), `${message} / ${asset}: ${result.selected_template?.template_id}`);
    }
  }
});

// (d) no offer is manufactured
test("(d) no offer is manufactured: no offer template, no $ amount, no offer price on the decision", async () => {
  for (const asset of ["sfr", "retail"]) {
    for (const [message, classification] of [["What would you offer?", C.asks_offer()], ["Yes I'd consider it", C.interested()]]) {
      const result = await run({ message, classification, asset });
      assert.ok(!OFFER_USE_CASES.test(String(result.selected_template?.use_case || "")), result.selected_template?.use_case);
      assert.ok(!/\$\s?\d|\d{2,3}\s?k\b|\d{1,3}(,\d{3})+/i.test(textOf(result)), textOf(result));
      assert.ok(!(Number(result.automation_decision?.offer_price) > 0), "no offer price");
    }
  }
});

// (e) language
test("(e) a Spanish seller gets the Spanish S3 row — never English; no approved ES row → hold", async () => {
  const es = await run({ message: "¿Cuánto me ofrece?", classification: C.asks_offer("Spanish"), language: "Spanish" });
  assert.equal(es.selected_template?.template_id, "occ_seller_asking_price_es_v1");
  assert.ok(!/what price/i.test(textOf(es)), textOf(es));
  const none = await run({ message: "¿Cuánto me ofrece?", classification: C.asks_offer("Spanish"), language: "Spanish", templates: [S3_RES_02, S3_COM_02, S4_RES] });
  assert.equal(none.queued, false);
  assert.ok(!/what price would you be looking for/i.test(textOf(none)), "never the English row for a Spanish seller");
  assert.notEqual(none.selected_template?.language, "English");
});
