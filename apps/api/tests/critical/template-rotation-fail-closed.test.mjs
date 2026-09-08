/**
 * template-rotation-fail-closed.test.mjs
 *
 * Defect B (2026-09-08): six of eleven governed templates referenced {{city}},
 * which the outbound merge builder never supplied. Pausing them collapsed the
 * English pool to ONE template and 125 recipients received identical copy.
 * These pin: canonical city from properties.property_address_city only; a
 * template that cannot render fails for THAT target only; rotation-controlled
 * traffic refuses when a language's renderable pool is below the minimum;
 * non-rotation single-template sends still work; assignment is deterministic
 * and actually distributes across variants.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildOutboundMergeValues, OUTBOUND_MERGE_KEYS } from "@/lib/domain/campaigns/outbound-agent-identity.js";
import { renderTemplateBody, requiredMergeFields } from "@/lib/domain/campaigns/template-render-validation.js";
import {
  assignTemplateForTargetFast,
  isStaticallyRenderable,
  renderableRotationPool,
  MIN_ROTATION_VARIANTS,
  INSUFFICIENT_ROTATION_REASON,
} from "@/lib/domain/campaigns/campaign-target-template-assignment.js";

const OWNER = { master_owner_id: "o-1", agent_persona: "ryan" };
const TARGET = {
  id: "t-1", master_owner_id: "o-1", property_id: "p-1", phone_id: "ph-1",
  language: "English", property_address: "7630 S Seeley Ave", market: "Miami, FL",
  metadata: { candidate_snapshot: { seller_first_name: "Maria", property_type: "Residential" } },
};
const tpl = (id, body, language = "English", extra = {}) => ({
  template_id: id, id, template_body: body, language, is_active: true,
  use_case: "ownership_check", stage_code: "S1", property_type_scope: "any residential", ...extra,
});
const CITY_TPL = tpl("c1", "Hi {{seller_first_name}}, {{agent_name}} here about {{property_address}} in {{city}}.");
const NOCITY_TPL = tpl("n1", "Hi {{seller_first_name}}, {{agent_name}} here about {{property_address}}.");
const BAD_TOKEN_TPL = tpl("b1", "Hi {{seller_first_name}}, about {{property_address}} ({{county}}).");

// ── B1: canonical city ─────────────────────────────────────────────────────

test("city comes from properties.property_address_city and nowhere else", () => {
  const withCity = buildOutboundMergeValues({ target: TARGET, masterOwner: OWNER, property: { property_address_city: "FORT LAUDERDALE" } });
  assert.equal(withCity.ok, true);
  assert.equal(withCity.values.city, "FORT LAUDERDALE");
  // market says Miami; the property is in Fort Lauderdale. Market must NOT leak in.
  const noProperty = buildOutboundMergeValues({ target: TARGET, masterOwner: OWNER });
  assert.equal(noProperty.values.city, "", "no structured city => empty, never inferred from market");
  assert.deepEqual(Object.keys(withCity.values).sort(), [...OUTBOUND_MERGE_KEYS].sort());
});

test("a {{city}} template renders from canonical city and fails ONLY when city is absent", () => {
  const ok = buildOutboundMergeValues({ target: TARGET, masterOwner: OWNER, property: { property_address_city: "Hollywood" } }).values;
  assert.equal(renderTemplateBody(CITY_TPL.template_body, ok).ok, true);
  const missing = buildOutboundMergeValues({ target: TARGET, masterOwner: OWNER, property: { property_address_city: null } }).values;
  const r = renderTemplateBody(CITY_TPL.template_body, missing);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["city"]);
  // and the same target still renders a template that does not need city
  assert.equal(renderTemplateBody(NOCITY_TPL.template_body, missing).ok, true);
});

// ── B3: renderability + fail-closed pool ──────────────────────────────────

test("static renderability = every token is a key the merge builder can supply", () => {
  assert.equal(isStaticallyRenderable(CITY_TPL), true, "city is now a supplied key");
  assert.equal(isStaticallyRenderable(NOCITY_TPL), true);
  assert.equal(isStaticallyRenderable(BAD_TOKEN_TPL), false, "{{county}} can never render");
  assert.deepEqual(requiredMergeFields(BAD_TOKEN_TPL.template_body), ["seller_first_name", "property_address", "county"]);
});

test("the rotation pool counts only governed AND renderable templates of that language", () => {
  const pool = renderableRotationPool([CITY_TPL, NOCITY_TPL, BAD_TOKEN_TPL, tpl("s1", "Hola {{seller_first_name}}", "Spanish")], "English");
  assert.deepEqual(pool.map((t) => t.template_id).sort(), ["c1", "n1"]);
});

test("rotation-controlled traffic REFUSES when a language has fewer than the minimum variants", () => {
  assert.equal(MIN_ROTATION_VARIANTS, 2);
  const campaign = { id: "camp-1", metadata: { stage_code: "S1", template_use_case: "ownership_check" } };
  const r = assignTemplateForTargetFast(TARGET, campaign, [NOCITY_TPL, BAD_TOKEN_TPL]);
  assert.equal(r.ok, false);
  assert.equal(r.template_state, "awaiting_template");
  assert.equal(r.template_id, null);
  assert.equal(r.reason, INSUFFICIENT_ROTATION_REASON);
  assert.equal(r.renderable_pool_size, 1);
  assert.match(r.block_reason, /^insufficient_template_rotation_pool:English:1<2$/);
});

test("a legitimate non-rotation single-template send is NOT refused", () => {
  const campaign = { id: "camp-2", metadata: { stage_code: "S1", template_use_case: "manual_reply" } };
  const only = tpl("m1", "Thanks {{seller_first_name}}, {{agent_name}} will follow up on {{property_address}}.", "English", { use_case: "manual_reply" });
  const r = assignTemplateForTargetFast(TARGET, campaign, [only]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.template_state, "assigned");
  assert.equal(r.template_id, "m1");
  assert.equal(r.eligible_pool_size, 1, "a pool of one is legitimate for non-rotation traffic");
});

// ── B4: real rotation, deterministic ───────────────────────────────────────

const EN_POOL = ["e1", "e2", "e3", "e4", "e5"].map((id) => tpl(id, `V${id} {{seller_first_name}} {{agent_name}} {{property_address}} {{city}}`));
const ES_POOL = ["s1", "s2", "s3", "s4"].map((id) => tpl(id, `V${id} {{seller_first_name}} {{agent_name}} {{property_address}}`, "Spanish"));
const CAMPAIGN = { id: "camp-3", metadata: { stage_code: "S1", template_use_case: "ownership_check" } };
const synthetic = (i, language) => ({
  ...TARGET, id: `t-${language}-${i}`, master_owner_id: `o-${i}`, property_id: `p-${i}`, phone_id: `ph-${i}`, language,
});
function distribution(language, pool, n = 120) {
  const counts = {};
  for (let i = 0; i < n; i += 1) {
    const r = assignTemplateForTargetFast(synthetic(i, language), CAMPAIGN, pool);
    assert.equal(r.template_state, "assigned", JSON.stringify(r));
    const id = r.template_id;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

test("English assignments actually span multiple variants (not merely 'variants exist')", () => {
  const counts = distribution("English", EN_POOL);
  const used = Object.keys(counts);
  assert.ok(used.length >= 3, `expected >=3 English variants in use, got ${JSON.stringify(counts)}`);
  const max = Math.max(...Object.values(counts));
  assert.ok(max < 120 * 0.6, `one variant dominates: ${JSON.stringify(counts)}`);
});

test("Spanish assignments still rotate", () => {
  const counts = distribution("Spanish", ES_POOL);
  assert.ok(Object.keys(counts).length >= 2, JSON.stringify(counts));
});

test("same target + same inputs => same template (deterministic, no hidden randomness)", () => {
  const a = assignTemplateForTargetFast(synthetic(7, "English"), CAMPAIGN, EN_POOL);
  const b = assignTemplateForTargetFast(synthetic(7, "English"), CAMPAIGN, [...EN_POOL].reverse());
  const idOf = (r) => r.template_id;
  assert.equal(idOf(a), idOf(b), "pool order must not change the pick");
});
