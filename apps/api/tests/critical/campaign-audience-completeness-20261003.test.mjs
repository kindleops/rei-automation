// Campaign audience completeness (2026-10-03): canonical-only scores, projected
// property facts gated on evidence, the funnel's universe + personalization stages.
import test from "node:test";
import assert from "node:assert/strict";

import {
  COLUMN_MISSING,
  PROJECTION_PENDING_COLUMNS,
  graphFieldApplicability,
  loadGraphColumnPopulation,
  resetGraphColumnPopulationCache,
  resolveGraphFilterPlan,
} from "@/lib/domain/campaigns/campaign-graph-filter-plan.js";
import { CAMPAIGN_FIELD_CATALOG, RETIRED_FIELD_KEYS, getCampaignFieldDefinition } from "@/lib/domain/campaigns/campaign-field-catalog.js";
import {
  greetingPersonalization,
  isUniverseFilter,
  sendableAfterPersonalization,
  summarizePersonalization,
} from "@/lib/domain/campaigns/campaign-audience-funnel.js";

test("legacy Podio scores are retired: hidden from the builder, refused by name, never substituted", () => {
  for (const key of ["properties.structured_motivation_score", "properties.deal_strength_score", "properties.tag_distress_score", "master_owners.priority_score"]) {
    assert.ok(RETIRED_FIELD_KEYS.has(key), key);
    const field = getCampaignFieldDefinition(key);
    assert.equal(field.supported_in_preview, false, `${key} must not be offered`);
    assert.equal(field.retired, true, key);
    assert.equal(graphFieldApplicability(key).applicable, false, key);
  }
  // The one legacy score still mapped is labelled as legacy, not as the canonical formula.
  assert.match(getCampaignFieldDefinition("properties.final_acquisition_score").label, /legacy/i);
});

test("canonical property_acquisition_scores fields are offered, and only apply once the graph carries them", () => {
  const keys = ["properties.aos_score", "properties.decision_tier", "properties.acquisition_confidence", "properties.transaction_probability_365", "properties.best_strategy"];
  for (const key of keys) {
    const field = getCampaignFieldDefinition(key);
    assert.ok(field, key);
    assert.equal(field.category, "Acquisition Scores");
    assert.equal(field.supported_in_preview, true, key);
  }
  assert.equal(getCampaignFieldDefinition("properties.aos_score").type, "number");
  // No probe / column not there yet: refused, never applied against a missing column.
  assert.equal(graphFieldApplicability("properties.aos_score").reason, "not_in_audience");
  assert.equal(graphFieldApplicability("properties.aos_score", { population: new Map([["aos_score", COLUMN_MISSING]]) }).reason, "not_in_audience");
  // Column present but empty (101 scored properties today): no audience data.
  assert.equal(graphFieldApplicability("properties.aos_score", { population: new Map([["aos_score", false]]) }).reason, "no_audience_data");
  assert.equal(graphFieldApplicability("properties.aos_score", { population: new Map([["aos_score", true]]) }).column, "aos_score");
});

test("property facts map to their projected columns: beds, baths, sqft, year built, lot, loan, ownership", () => {
  const expected = {
    "properties.total_bedrooms": "beds",
    "properties.total_baths": "baths",
    "properties.building_square_feet": "building_sqft",
    "properties.year_built": "year_built",
    "properties.lot_square_feet": "lot_sqft",
    "properties.total_loan_balance": "total_loan_balance",
    "properties.ownership_years": "ownership_years",
    "properties.tax_delinquent_year": "tax_delinquent_year",
    "properties.building_quality": "building_quality",
    "properties.estimated_repair_cost": "estimated_repair_cost",
  };
  const population = new Map(Object.values(expected).map((column) => [column, true]));
  for (const [key, column] of Object.entries(expected)) {
    assert.ok(PROJECTION_PENDING_COLUMNS.has(column), column);
    assert.equal(getCampaignFieldDefinition(key).supported_in_preview, true, key);
    const verdict = graphFieldApplicability(key, { population });
    assert.equal(verdict.applicable, true, key);
    assert.equal(verdict.column, column, key);
  }
  const plan = resolveGraphFilterPlan([
    { field_key: "properties.total_bedrooms", operator: "gte", value: 3, label: "Beds" },
    { field_key: "properties.year_built", operator: "lte", value: 1960, label: "Year Built" },
  ], { population: new Map([["beds", true]]) });
  assert.deepEqual(plan.applicable.map((f) => f.graph_column), ["beds"]);
  assert.deepEqual(plan.inapplicable.map((f) => [f.field_key, f.reason]), [["properties.year_built", "not_in_audience"]]);
});

test("phone type is a targeting field; the seller flags field reads person flags, property flags read property flags", () => {
  assert.equal(getCampaignFieldDefinition("phones.phone_type").supported_in_preview, true);
  assert.equal(graphFieldApplicability("prospects.person_flags_text").column, "matching_flags_text");
  assert.equal(graphFieldApplicability("properties.property_flags_text").column, "property_flags_text");
  assert.ok(CAMPAIGN_FIELD_CATALOG.some((f) => f.key === "phones.phone_type"));
});

test("the population probe records a column the table lacks as missing (a HEAD error has no body)", async () => {
  resetGraphColumnPopulationCache();
  const asked = [];
  const supabase = {
    from() {
      const q = {
        _col: null,
        _head: false,
        select(cols, opts) { q._head = Boolean(opts?.head); if (!opts) q._col = cols; return q; },
        not(col) { q._col = col; return q; },
        limit() {
          asked.push([q._col, q._head]);
          const missing = q._col === "beds";
          if (q._head) return Promise.resolve(missing ? { count: null, error: { message: "", code: "" } } : { count: 500, error: null });
          return Promise.resolve(missing ? { data: null, error: { code: "42703", message: "column campaign_target_graph.beds does not exist" } } : { data: [], error: null });
        },
      };
      return q;
    },
  };
  const population = await loadGraphColumnPopulation(supabase, { force: true });
  assert.equal(population.get("beds"), COLUMN_MISSING);
  assert.equal(population.get("market"), true);
  assert.ok(asked.some(([col, head]) => col === "beds" && head === false), "missing column confirmed with a bodied read");
  resetGraphColumnPopulationCache();
});

test("universe filters are location only: market, ZIP, county, drawn area, pinned ids", () => {
  const def = (key) => getCampaignFieldDefinition(key);
  assert.equal(isUniverseFilter({ field_key: "properties.market" }, def("properties.market")), true);
  assert.equal(isUniverseFilter({ field_key: "properties.property_address_zip" }, def("properties.property_address_zip")), true);
  assert.equal(isUniverseFilter({ field_key: "properties.property_id" }, def("properties.property_id")), true);
  assert.equal(isUniverseFilter({ field_key: "properties.drawn_area" }, { type: "geo_area" }), true);
  assert.equal(isUniverseFilter({ field_key: "properties.equity_percent" }, def("properties.equity_percent")), false);
  assert.equal(isUniverseFilter({ field_key: "properties.tax_delinquent" }, def("properties.tax_delinquent")), false);
});

test("greeting personalization mirrors the render lint: first name, deed name, or refused", () => {
  assert.equal(greetingPersonalization({ seller_first_name: "Ebony" }), "first_name");
  assert.equal(greetingPersonalization({ metadata: { candidate_snapshot: { seller_first_name: "Ebony" } } }), "first_name");
  // "Hey Brett A Bublitz": no first name, individual owner → deed-name greeting.
  assert.equal(greetingPersonalization({ owner_name: "Brett A Bublitz", is_corporate_owner: false }), "deed_name");
  // "Rci Holdings Inc", entity-owned, no representative first name → TEMPLATE_RENDER_LINT_FAILURE.
  assert.equal(greetingPersonalization({ owner_name: "Rci Holdings Inc", is_corporate_owner: true }), "none");
  assert.equal(greetingPersonalization({}), "none");

  const summary = summarizePersonalization([
    { market: "Minneapolis, MN", seller_first_name: "Ebony" },
    { market: "Minneapolis, MN", owner_name: "Brett A Bublitz" },
    { market: "Minneapolis, MN", owner_name: "Rci Holdings Inc", is_corporate_owner: true },
    { market: "Houston, TX", owner_name: "Acme LLC", is_corporate_owner: true },
  ]);
  assert.deepEqual({ first: summary.first_name, deed: summary.deed_name, none: summary.none }, { first: 1, deed: 1, none: 2 });
  assert.deepEqual(summary.none_by_market, { "Minneapolis, MN": 1, "Houston, TX": 1 });
  // Refusals only reduce the sendable count where a sender can carry the seller.
  const markets = [{ market: "Minneapolis, MN", sendable: true }, { market: "Houston, TX", sendable: false }];
  assert.equal(sendableAfterPersonalization(3, markets, summary), 2);
  assert.equal(sendableAfterPersonalization(null, markets, summary), null);
  assert.equal(sendableAfterPersonalization(3, markets, null), 3);
});

test("the composer cohort passes personalization through; target rows still never leave the server", async () => {
  const { readComposerCohort } = await import("@/lib/domain/campaigns/campaign-composer.js");
  const deps = {
    fresh: true,
    countCampaignAudienceCohort: async () => ({
      ok: true, queue_eligible_in_audience: 3400, rows_read: 3400, capped_by_build_limit: false, build_limit: 100000,
      recipients: 3104, duplicate_phones_collapsed: 296, ready: 2552, held: 552, held_by_reason: {}, sendable_now: 2552, no_sendable_number: 0,
      sender_markets: [{ market: "Minneapolis, MN", sellers: 2552, sendable: true }],
      personalization: { first_name: 500, deed_name: 1700, none: 352, none_by_market: { "Minneapolis, MN": 352 } },
      sendable_after_personalization: 2200,
      ready_by_zone: {}, ready_by_market: {}, timings_ms: { read: 1, total: 2 }, rows: ["must not leak"],
    }),
  };
  const c = await readComposerCohort({ filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Minneapolis, MN"] }] }, template_use_case: "ownership_check" }, deps);
  assert.deepEqual(c.personalization, { first_name: 500, deed_name: 1700, none: 352 });
  assert.equal(c.sendable_after_personalization, 2200);
  assert.equal("rows" in c, false);
});
