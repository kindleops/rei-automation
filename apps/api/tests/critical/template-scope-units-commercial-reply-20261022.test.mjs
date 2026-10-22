/**
 * PRODUCTION 2026-10-22 (diagnosed read-only ~20:50Z on Package A 6ff4a24a).
 *
 * DEFECT 1 — campaign first touches ignored property-type scope:
 *   - 840901 / 840902 (property_type_scope "single_family,residential") went
 *     to Residential / Multi-Family and to a Commercial / Other property:
 *     templateAllowedGroups() read "single_family,residential" as generic
 *     residential (every residential group, multi-family included).
 *   - 213841 ("5+ Units", "I am looking to acquire more units in {{city}}")
 *     was scheduled for a Multi-Family property with units_count 0/1:
 *     a multi-family label with no usable unit count became
 *     'small_multifamily', which the 5+ scope admits — and the campaign
 *     planner's candidate never carried units_count at all.
 *   Rule now: a scoped template is eligible only when the property's group /
 *   units match the scope; unknown units never select a unit-specific
 *   template (Any Residential, or hold). The send-time guard applies the same
 *   rule.
 *
 * DEFECT 3 — "Yes" from a Commercial / Other owner (+1281…5725, property
 * 2131479286) held as no_safe_template: the reply ran with no property id
 * (the inbound's message_events row had it), so the asset rule was skipped and
 * the legacy scope filter — with no commercial vocabulary — vetoed every
 * candidate. Next ask after ownership_confirmed is S2 interest (binding flow).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalPropertyGroupOf,
  isTemplateCompatibleWithProperty,
  templateAllowedGroups,
  templateScopeKind,
  MULTIFAMILY_UNITS_UNKNOWN,
} from "@/lib/domain/templates/template-asset-compatibility.js";
import { evaluateTemplateAssetGuard } from "@/lib/domain/queue/template-asset-guard.js";
import { renderOutboundTemplate } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { launchCandidateFromTarget } from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  executeInboundAutomationDecision,
  resolveReplyAssetPropertyId,
  selectSafeAutoReplyTemplate,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const RES = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const COM = ["self_storage", "retail", "office", "industrial", "hotel_motel", "mobile_home_park", "other_commercial"];

// Production rows (bodies as diagnosed).
const T840901 = { template_id: "840901", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, property_type_scope: "single_family,residential", template_body: "Hi {{seller_first_name}}, my name is {{agent_name}}. Came across {{property_address}}, are you still the owner?" };
const T840902 = { ...T840901, template_id: "840902", template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Are you still the owner of {{property_address}}?" };
const T213841 = { template_id: "213841", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, property_type_scope: "5+ Units", template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. I am looking to acquire more units in {{city}}. Do you still own {{property_address}}?" };
const ANY_RES = { template_id: "lc-anyres-1", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, property_type_scope: "Any Residential", template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?" };
const DUPLEX = { template_id: "dx-1", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, property_type_scope: "Duplex", template_body: "Hi {{seller_first_name}}, still own {{property_address}}?" };
const COMMERCIAL_S1 = { template_id: "840914", use_case: "ownership_check", language: "English", stage_code: "S1", is_active: true, property_type_scope: "Commercial (Other)", allowed_property_groups: ["self_storage", "retail", "other_commercial"], template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Quick question, do you still own the commercial property at {{property_address}}?" };
const LANDLORD_GENERIC = { template_id: "1181", property_type_scope: "Landlord / Multifamily", stage_code: "S6C", template_body: "No issue there, occupied properties are normal for me. If the number works, we can still move forward." };

const MF = (units) => ({ property_type: "Multi-Family", property_class: "Residential", units_count: units });
const P = {
  sfr: { property_type: "Single Family", property_class: "Residential", units_count: 1 },
  commercialOther: { property_type: "Other", property_class: "Commercial" },
  // the campaign graph's canonical_property_group is COALESCE(..., property_class, property_type)
  commercialWithResidentialLabel: { canonical_property_group: "Residential", property_type: "Other", property_class: "Commercial" },
};
const ok = (template, property) => isTemplateCompatibleWithProperty({ template, property }).compatible;

// ── canonical group ──────────────────────────────────────────────────────
test("a multi-family property with units 0 / 1 / unknown has UNKNOWN units, never small_multifamily", () => {
  for (const units of [0, 1, null, undefined, ""]) assert.equal(canonicalPropertyGroupOf(MF(units)), MULTIFAMILY_UNITS_UNKNOWN, `units=${units}`);
  assert.equal(canonicalPropertyGroupOf(MF(2)), "duplex");
  assert.equal(canonicalPropertyGroupOf(MF(4)), "fourplex");
  assert.equal(canonicalPropertyGroupOf(MF(6)), "small_multifamily");
  assert.equal(canonicalPropertyGroupOf(MF(24)), "multifamily_5_plus");
  assert.equal(canonicalPropertyGroupOf({ property_class: "Multifamily" }), MULTIFAMILY_UNITS_UNKNOWN);
});

test("a Commercial / Other record is commercial even when a snapshot labels it 'Residential'", () => {
  assert.equal(canonicalPropertyGroupOf(P.commercialOther), "other_commercial");
  assert.equal(canonicalPropertyGroupOf(P.commercialWithResidentialLabel), "other_commercial");
  // a label alone (no class) still reads as residential, units unknown
  assert.equal(canonicalPropertyGroupOf({ canonical_property_group: "Residential" }), "residential");
});

// ── scope parsing ────────────────────────────────────────────────────────
test("'single_family,residential' is a SINGLE-FAMILY scope, not generic residential", () => {
  assert.equal(templateScopeKind(T840901), "single_family");
  assert.deepEqual(templateAllowedGroups(T840901), ["sfr"]);
  assert.equal(templateScopeKind({ property_type_scope: "Single Family" }), "single_family");
  assert.equal(templateScopeKind(ANY_RES), "generic_residential");
  assert.equal(templateScopeKind({ property_type_scope: "Residential" }), "generic_residential");
  assert.equal(templateScopeKind({ property_type_scope: null }), "generic_residential");
  assert.equal(templateScopeKind(T213841), "five_plus");
});

// ── DEFECT 1 production cases ───────────────────────────────────────────
test("840901 / 840902 reach single-family homes only — never multi-family, commercial or an unclassified property", () => {
  for (const t of [T840901, T840902]) {
    assert.equal(ok(t, P.sfr), true, `${t.template_id} sfr`);
    for (const units of [0, 1, 2, 3, 4, 8, null]) assert.equal(ok(t, MF(units)), false, `${t.template_id} MF units=${units}`);
    assert.equal(ok(t, P.commercialOther), false, `${t.template_id} commercial`);
    assert.equal(ok(t, P.commercialWithResidentialLabel), false, `${t.template_id} commercial w/ label`);
    assert.equal(ok(t, {}), false, `${t.template_id} unclassified`);
    assert.equal(ok(t, { property_class: "Residential" }), false, `${t.template_id} residential, type unknown`);
  }
});

test("213841 (5+ Units) never reaches a property with ≤ 4 or unknown units; it does reach 5+", () => {
  for (const units of [0, 1, 2, 3, 4, null]) assert.equal(ok(T213841, MF(units)), false, `units=${units}`);
  assert.equal(ok(T213841, P.sfr), false);
  assert.equal(ok(T213841, MF(5)), true);
  assert.equal(ok(T213841, MF(24)), true);
});

test("unknown units fall back to Any Residential (or Landlord / Multifamily generic copy); unit-specific scopes are refused", () => {
  const mf = MF(1);
  assert.equal(ok(ANY_RES, mf), true, "Any Residential generic copy to multi-family is acceptable");
  assert.equal(ok(LANDLORD_GENERIC, mf), true);
  assert.equal(ok(DUPLEX, mf), false, "a Duplex scope needs a known duplex");
  assert.equal(ok(DUPLEX, MF(2)), true);
  assert.equal(ok({ ...ANY_RES, allowed_property_groups: ["sfr"] }, mf), false, "an allowed list narrowed to sfr excludes multi-family");
  assert.equal(ok({ ...ANY_RES, template_body: "How many units are rented at {{property_address}}?" }, mf), false, "unit wording needs a known unit count");
  assert.equal(ok({ ...ANY_RES, template_body: "Would you sell your house at {{property_address}}?" }, mf), true);
  assert.equal(ok({ ...ANY_RES, template_body: "Would you sell your house at {{property_address}}?" }, {}), false, "house wording never to an unclassified property");
  // a commercial property never takes residential-scoped copy, generic or not
  assert.equal(ok(ANY_RES, P.commercialOther), false);
  assert.equal(ok(COMMERCIAL_S1, P.commercialOther), true);
  assert.equal(ok(COMMERCIAL_S1, P.commercialWithResidentialLabel), true);
});

// ── the campaign feeder's real choice path ──────────────────────────────
function fluent(data) {
  const b = { select: () => b, eq: () => b, ilike: () => b, in: () => b, order: () => b, limit: () => Promise.resolve({ data, error: null }), range: () => Promise.resolve({ data, error: null }), then: (r) => r({ data, error: null }) };
  return b;
}
const supabaseWith = (templates) => ({ from: (table) => fluent(table === "sms_templates" ? templates : []) });

function plannerCandidate(snapshot) {
  const target = {
    id: "ct-1", master_owner_id: "mo-1", property_id: "p-1", market: "Houston, TX", state: "TX", timezone: "America/Chicago",
    property_address: "120 E Main St", owner_name: "Pat Lee", language: "English", identity_status: "probable",
    metadata: { candidate_snapshot: { seller_first_name: "Pat", property_address_full: "120 E Main St, Houston, TX", property_city: "Houston", ...snapshot } },
  };
  return { ...launchCandidateFromTarget(target, { metadata: { stage_code: "S1", template_use_case: "ownership_check" } }), matching_flags: "Likely Owner", seller_first_name: "Pat", owner_display_name: "Pat Lee", agent_name: "Sam" };
}
const RENDER_OPTS = { template_use_case: "ownership_check", within_contact_window_now: false, now: "2026-10-22T18:00:00Z" };
const pickedId = (r) => r.template?.template_id ?? r.selected_template_id ?? null;

test("feeder: the planner candidate carries units_count from the graph snapshot", () => {
  assert.equal(plannerCandidate({ property_type: "Multi-Family", property_class: "Residential", units_count: 6 }).units_count, 6);
  assert.equal(plannerCandidate({ property_type: "Multi-Family", property_class: "Residential" }).units_count, null);
});

test("feeder: a Residential / Multi-Family property (units unknown) never gets 840901/840902/213841 — Any Residential, else hold", async () => {
  const mf = plannerCandidate({ property_type: "Multi-Family", property_class: "Residential", canonical_property_group: "Residential", units_count: 1 });
  const withGeneric = await renderOutboundTemplate(mf, RENDER_OPTS, { supabase: supabaseWith([T840901, T840902, T213841, ANY_RES]) });
  assert.equal(withGeneric.ok, true, withGeneric.reason);
  assert.equal(pickedId(withGeneric), "lc-anyres-1");
  const onlyScoped = await renderOutboundTemplate(mf, RENDER_OPTS, { supabase: supabaseWith([T840901, T840902, T213841]) });
  assert.equal(onlyScoped.ok, false);
  assert.equal(onlyScoped.reason, "no_template_after_fallback");
});

test("feeder: a Commercial / Other property never gets single-family copy (graph label 'Residential' or not)", async () => {
  for (const snapshot of [
    { property_type: "Other", property_class: "Commercial", canonical_property_group: "Commercial" },
    { property_type: "Other", property_class: "Commercial", canonical_property_group: "Residential" },
  ]) {
    const c = plannerCandidate(snapshot);
    const r = await renderOutboundTemplate(c, RENDER_OPTS, { supabase: supabaseWith([T840901, T840902, ANY_RES, COMMERCIAL_S1]) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(pickedId(r), "840914", JSON.stringify(snapshot));
    const none = await renderOutboundTemplate(c, RENDER_OPTS, { supabase: supabaseWith([T840901, T840902, ANY_RES]) });
    assert.equal(none.ok, false, JSON.stringify(snapshot));
  }
});

test("feeder: a 5+ property with a known unit count does get the 5+ template; a single-family home gets 840901", async () => {
  const big = plannerCandidate({ property_type: "Multi-Family", property_class: "Residential", units_count: 12 });
  const r = await renderOutboundTemplate(big, RENDER_OPTS, { supabase: supabaseWith([T840901, T213841]) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(pickedId(r), "213841");
  const house = plannerCandidate({ property_type: "Single Family", property_class: "Residential", units_count: 1 });
  const h = await renderOutboundTemplate(house, RENDER_OPTS, { supabase: supabaseWith([T840901, T213841]) });
  assert.equal(h.ok, true, h.reason);
  assert.equal(pickedId(h), "840901");
});

// ── the send-time guard refuses a mismatched row already queued ─────────
function guardSupabase({ properties = {}, templates = {} } = {}) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        maybeSingle() {
          const src = table === "properties" ? properties[filters.property_id] : templates[filters.template_id];
          return Promise.resolve({ data: src ?? null, error: null });
        },
      };
      return chain;
    },
  };
}

test("send-time guard: queued 213841 / 840901 rows on a units-unknown multi-family and 840902 on commercial are refused", async () => {
  const supabase = guardSupabase({
    properties: { mf: { property_id: "mf", ...MF(0) }, com: { property_id: "com", ...P.commercialOther }, mf6: { property_id: "mf6", ...MF(6) } },
    templates: { 213841: T213841, 840901: T840901, 840902: T840902, "lc-anyres-1": ANY_RES },
  });
  const cases = [
    ["mf", "213841", "Hi Pat, this is Sam. I am looking to acquire more units in Houston. Do you still own 120 E Main St?", false],
    ["mf", "840901", "Hi Pat, my name is Sam. Came across 120 E Main St, are you still the owner?", false],
    ["com", "840902", "Hi Pat, this is Sam. Are you still the owner of 120 E Main St?", false],
    ["mf", "lc-anyres-1", "Hi Pat, this is Sam. Do you still own 120 E Main St?", true],
    ["mf6", "213841", "Hi Pat, this is Sam. I am looking to acquire more units in Houston. Do you still own 120 E Main St?", true],
  ];
  for (const [property_id, selected_template_id, body, allowed] of cases) {
    const verdict = await evaluateTemplateAssetGuard({ supabase, queue_row: { property_id, selected_template_id }, body });
    assert.equal(verdict.allowed, allowed, `${selected_template_id} on ${property_id}: ${verdict.reason}`);
  }
});

// ── DEFECT 3: a commercial owner's "Yes" ────────────────────────────────
const S2_ANY_RES = { template_id: "400065", use_case: "consider_selling", stage_code: "S2", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Any Residential", allowed_property_groups: null, template_body: "Thanks for confirming. Would you consider a proposal for the property?" };
const S2_COMMERCIAL = { template_id: "lc-s2-consider-com-en-test", use_case: "consider_selling", stage_code: "S2", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Commercial (Other)", allowed_property_groups: COM, prohibited_property_groups: [...RES, "land"], template_body: "Thanks for confirming. Would you be open to a proposal on the property?" };
const S3_UNSCOPED = { template_id: "occ_seller_asking_price_en_v1", use_case: "seller_asking_price", stage_code: "S3", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: null, allowed_property_groups: null, template_body: "Got it. What price would you have in mind for the property?" };
const S3_COM_1 = { template_id: "lc-s3-asking-price-commercial-en-01", use_case: "seller_asking_price", stage_code: "S3", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Commercial (Other)", allowed_property_groups: COM, prohibited_property_groups: [...RES, "land"], template_body: "Got it. Do you have an asking price in mind for the property?" };
const S3_COM_2 = { ...S3_COM_1, template_id: "lc-s3-asking-price-com-en-02", template_body: "Thanks. What number would you need for the property?" };

function tableSupabase(tables = {}) {
  const from = (table) => {
    const filters = [];
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => String(r?.[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => (vs || []).map(String).includes(String(r?.[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain, or: () => chain, not: () => chain, neq: () => chain, order: () => chain, ilike: () => chain,
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
const THREAD = "+12815555725";
const PROPERTY = { property_id: "2131479286", property_type: "Other", property_class: "Commercial" };
const lostContext = (summaryExtra = {}) => ({
  found: true, inbound_from: THREAD, ids: { master_owner_id: "mo-1", prospect_id: null, property_id: null }, items: {}, flags: {},
  recent: { recently_used_template_ids: [], touch_count: 1, recent_events: [] },
  summary: { conversation_stage: "ownership_check", property_address: "1 Main St", seller_first_name: "Pat", agent_name: "Sam", language_preference: "English", ...summaryExtra },
});
const YES = { primary_intent: "ownership_confirmed", confidence: 0.9, language: "English", reply_language_source: "seller_reply", automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false }, message: "Yes" };

function runYes({ templates, eventProperty = PROPERTY.property_id, summaryExtra = {}, sendQueue = [], directive = null }) {
  const ctx = lostContext(summaryExtra);
  return executeInboundAutomationDecision({
    message: "Yes", threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+18325550100", ownerId: "mo-1", propertyId: null,
    latestThreadContext: ctx, context: ctx, classification: YES, effectiveStageBefore: "ownership_confirmation", transitionDirective: directive,
    inboundEventId: "evt-yes", inboundReceivedAt: "2026-10-22T18:00:00Z", dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: tableSupabase({
      sms_templates: templates,
      properties: [PROPERTY],
      message_events: eventProperty ? [{ id: "evt-yes", property_id: eventProperty }] : [],
      send_queue: sendQueue,
    }),
  });
}

test("stage: ownership confirmed at S1 → S2 interest (consider_selling), never straight to S3", () => {
  const t = resolveSellerStageTransition({ stage_before: "ownership_confirmation", intent: "ownership_confirmed", classification_confidence: 0.9 });
  assert.equal(t.stage_after, "offer_interest");
  assert.equal(t.required_template_use_case, "consider_selling");
});

test("the reply's property is recovered from the inbound message_events row, then the thread's delivered outbound; ambiguity is reported", async () => {
  const supabase = tableSupabase({
    message_events: [{ id: "evt-1", property_id: "2131479286" }],
    send_queue: [
      { id: "q2", to_phone_number: THREAD, property_id: "p-B", queue_status: "sent", created_at: "2026-10-22T10:00:00Z" },
      { id: "q1", to_phone_number: THREAD, property_id: "p-A", queue_status: "delivered", created_at: "2026-10-21T10:00:00Z" },
    ],
  });
  assert.deepEqual(await resolveReplyAssetPropertyId({ supabase, propertyId: "x-1" }), { property_id: "x-1", source: "explicit", ambiguous: false });
  assert.equal((await resolveReplyAssetPropertyId({ supabase, context: { ids: { property_id: "c-1" } } })).property_id, "c-1");
  assert.equal((await resolveReplyAssetPropertyId({ supabase, inboundEventId: "evt-1", threadKey: THREAD })).source, "inbound_message_event");
  const fromThread = await resolveReplyAssetPropertyId({ supabase, inboundEventId: "evt-missing", threadKey: THREAD });
  assert.equal(fromThread.property_id, "p-B", "the freshest delivered outbound is the question being answered");
  const ambiguous = await resolveReplyAssetPropertyId({
    supabase: tableSupabase({ send_queue: [
      { id: "q3", to_phone_number: THREAD, property_id: null, queue_status: "sent", created_at: "2026-10-22T11:00:00Z" },
      { id: "q2", to_phone_number: THREAD, property_id: "p-B", queue_status: "sent", created_at: "2026-10-22T10:00:00Z" },
      { id: "q1", to_phone_number: THREAD, property_id: "p-A", queue_status: "sent", created_at: "2026-10-21T10:00:00Z" },
    ] }),
    threadKey: THREAD,
  });
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.property_id, null);
});

test("commercial 'Yes' with the property lost upstream: S2 commercial copy, never residential copy", async () => {
  const r = await runYes({ templates: [S2_ANY_RES, S2_COMMERCIAL, S3_UNSCOPED, S3_COM_1, S3_COM_2] });
  assert.equal(r.selected_template?.template_id, "lc-s2-consider-com-en-test", r.automation_decision?.human_review_reason);
  assert.equal(r.automation_decision.route_hint, "consider_selling");
  // the production shape: a context scope label and no property id
  const labelled = await runYes({ templates: [S2_ANY_RES, S2_COMMERCIAL], summaryExtra: { property_type: "Commercial" } });
  assert.equal(labelled.selected_template?.template_id, "lc-s2-consider-com-en-test");
});

test("commercial 'Yes' and NO approved commercial S2 row: an explicit asset hold, never the residential S2, never a skip to S3", async () => {
  for (const summaryExtra of [{}, { property_type: "Commercial" }, { property_type: "Other" }]) {
    const r = await runYes({ templates: [S2_ANY_RES, S3_UNSCOPED, S3_COM_1, S3_COM_2], summaryExtra });
    assert.equal(r.selected_template, null, JSON.stringify(summaryExtra));
    assert.equal(r.queued, false);
    assert.equal(r.automation_decision.human_review_reason, "asset_compatible_template_missing", JSON.stringify(summaryExtra));
    assert.match(String(r.automation_decision.human_review_detail || ""), /other_commercial/);
  }
});

test("commercial owner at S2 who says they'd sell gets the approved COMMERCIAL S3 asking-price row (context scope label no longer vetoes it)", async () => {
  const ctx = lostContext({ conversation_stage: "offer_interest", property_type: "Commercial" });
  const result = await selectSafeAutoReplyTemplate({
    supabaseClient: tableSupabase({ sms_templates: [S3_UNSCOPED, S3_COM_1, S3_COM_2], properties: [PROPERTY], message_events: [{ id: "evt-s3", property_id: PROPERTY.property_id }] }),
    classification: { ...YES, primary_intent: "seller_interested", message: "yes I'd sell" },
    decision: { route_hint: "seller_asking_price", allowed_template_stages: ["seller_asking_price"], required_template_use_case: "seller_asking_price" },
    context: ctx, threadKey: THREAD, inboundEventId: "evt-s3",
  });
  assert.equal(result.ok, true, result.reason);
  assert.match(result.template.template_id, /^lc-s3-asking-price-com/);
});

test("ambiguous property on the thread (no id anywhere, outbounds about two properties) holds the reply", async () => {
  const r = await runYes({
    templates: [S2_ANY_RES, S2_COMMERCIAL],
    eventProperty: null,
    sendQueue: [
      { id: "q3", to_phone_number: THREAD, property_id: null, queue_status: "sent", created_at: "2026-10-22T11:00:00Z" },
      { id: "q2", to_phone_number: THREAD, property_id: "p-B", queue_status: "sent", created_at: "2026-10-22T10:00:00Z" },
      { id: "q1", to_phone_number: THREAD, property_id: "p-A", queue_status: "sent", created_at: "2026-10-21T10:00:00Z" },
    ],
  });
  assert.equal(r.selected_template, null);
  assert.equal(r.automation_decision.human_review_reason, "property_context_ambiguous");
});

test("a single-family owner's 'Yes' is unchanged: the Any Residential S2 row", async () => {
  const ctx = lostContext();
  const r = await executeInboundAutomationDecision({
    message: "Yes", threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+18325550100", ownerId: "mo-1", propertyId: "sfr-1",
    latestThreadContext: ctx, context: ctx, classification: YES, effectiveStageBefore: "ownership_confirmation",
    inboundEventId: "evt-sfr", inboundReceivedAt: "2026-10-22T18:00:00Z", dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: tableSupabase({ sms_templates: [S2_ANY_RES, S2_COMMERCIAL], properties: [{ property_id: "sfr-1", ...P.sfr }] }),
  });
  assert.equal(r.selected_template?.template_id, "400065");
});
