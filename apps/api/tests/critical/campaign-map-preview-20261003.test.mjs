/**
 * CAMPAIGN MAP PREVIEW — the eligible cohort's geography (part=geo).
 *
 *   1. The Map never computes the audience: the preview's eligible set is the
 *      whole-cohort pipeline's ready set under the SAME rule as the Composer's
 *      "Eligible" (sendable market, greeting renders), and it reconciles.
 *   2. Missing / unusable coordinates are counted, never fabricated; a point
 *      exists only for a property the cohort returned.
 *   3. Coordinates are read in ONE batched call for the whole set (no N+1),
 *      the cohort run is shared with part=cohort (cache + single flight), and
 *      the cohort response never carries member rows.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  _resetComposerPreviewCaches,
  eligibleMembers,
  readComposerCohort,
  readComposerGeography,
} from "@/lib/domain/campaigns/campaign-composer.js";
import { sendableAfterPersonalization } from "@/lib/domain/campaigns/campaign-audience-funnel.js";

const FILTERS = { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Minneapolis, MN", "Dallas, TX", "Phoenix, AZ"] }] };
const SENDERS = [
  { market: "Minneapolis, MN", sellers: 4, sendable: true },
  { market: "Dallas, TX", sellers: 3, sendable: true },
  { market: "Phoenix, AZ", sellers: 2, sendable: false },
];
const MEMBERS = [
  { property_id: "m1", market: "Minneapolis, MN", greeting: "first_name" },
  { property_id: "m2", market: "Minneapolis, MN", greeting: "deed_name" },
  { property_id: "m3", market: "Minneapolis, MN", greeting: "none" },
  { property_id: "m4", market: "Minneapolis, MN", greeting: "first_name" },
  { property_id: "d1", market: "Dallas, TX", greeting: "first_name" },
  { property_id: "d2", market: "Dallas, TX", greeting: "first_name" },
  { property_id: "d3", market: "Dallas, TX", greeting: "first_name" },
  { property_id: "p1", market: "Phoenix, AZ", greeting: "first_name" },
  { property_id: "p2", market: "Phoenix, AZ", greeting: "none" },
];
const COORDS = new Map([
  ["m1", { lat: 44.98, lng: -93.27 }],
  ["m2", { lat: 45.01, lng: -93.3 }],
  ["m4", { lat: 0, lng: 0 }], // a placeholder, not a location
  ["d1", { lat: 32.78, lng: -96.8 }],
  ["d2", { lat: 32.9, lng: -96.7 }],
  // d3: no coordinates on record
  ["p1", { lat: 33.45, lng: -112.07 }], // not eligible (no sender route): must never be drawn
]);

function cohortDeps(counter) {
  return {
    countCampaignAudienceCohort: async (input) => {
      counter.cohort += 1;
      assert.equal(input.include_members, true, "the preview asks the pipeline for its ready set");
      await new Promise((r) => setTimeout(r, 15));
      const ready = MEMBERS.length;
      const personalization = { first_name: 6, deed_name: 1, none: 2, none_by_market: { "Minneapolis, MN": 1, "Phoenix, AZ": 1 } };
      return {
        ok: true, queue_eligible_in_audience: 11, rows_read: 11, capped_by_build_limit: false, build_limit: 100000,
        recipients: 10, duplicate_phones_collapsed: 1, ready, held: 1, held_by_reason: { entity_contact_requires_review: 1 },
        sendable_now: 7, no_sendable_number: 2, sender_markets: SENDERS, personalization,
        sendable_after_personalization: sendableAfterPersonalization(7, SENDERS, personalization),
        ready_by_zone: {}, ready_by_market: {}, timings_ms: { read: 1, total: 2 },
        members: MEMBERS,
      };
    },
    readPropertyCoordinates: async (ids) => {
      counter.coords += 1;
      counter.ids = ids;
      return new Map(ids.filter((id) => COORDS.has(id)).map((id) => [id, COORDS.get(id)]));
    },
  };
}

test("eligibility per target reproduces the Composer's whole-cohort Eligible exactly", () => {
  const personalization = { none_by_market: { "Minneapolis, MN": 1, "Phoenix, AZ": 1 } };
  const r = eligibleMembers(MEMBERS, SENDERS);
  assert.equal(r.eligible.length, sendableAfterPersonalization(7, SENDERS, personalization));
  assert.equal(r.eligible.length, 6);
  assert.equal(r.not_routable, 2);
  assert.equal(r.no_greeting, 1);
  assert.deepEqual(r.eligible.map((m) => m.property_id), ["m1", "m2", "m4", "d1", "d2", "d3"]);
  // unknown routing (sendable null) is not eligible — never assumed routable
  assert.equal(eligibleMembers([{ property_id: "x", market: "Nowhere", greeting: "first_name" }], [{ market: "Nowhere", sendable: null }]).eligible.length, 0);
});

test("geography: eligible / mapped / without coordinates, per market, never fabricated", async () => {
  _resetComposerPreviewCaches();
  const counter = { cohort: 0, coords: 0, ids: null };
  const g = await readComposerGeography({ filters: FILTERS, template_use_case: "ownership_check" }, cohortDeps(counter));
  assert.equal(g.ok, true);
  assert.equal(g.eligible, 6);
  assert.equal(g.mapped, 4); // m1 m2 d1 d2
  assert.equal(g.unmapped, 2); // m4 (0,0 placeholder) + d3 (no record)
  assert.deepEqual(g.reconciliation, { composer_eligible: 6, matches: true, delta: 0 });
  assert.deepEqual(g.excluded, { held_by_build: 1, not_routable: 2, no_greeting: 1 });
  assert.deepEqual([...g.points.ids].sort(), ["d1", "d2", "m1", "m2"]);
  assert.equal(g.points.ids.includes("p1"), false, "a non-eligible property with coordinates is not drawn");
  assert.equal(g.points.lng.length, g.points.ids.length);
  assert.equal(g.points.lat.length, g.points.ids.length);
  const byName = Object.fromEntries(g.markets.map((m) => [m.market, m]));
  assert.equal(byName["Minneapolis, MN"].eligible, 3);
  assert.equal(byName["Minneapolis, MN"].mapped, 2);
  assert.equal(byName["Minneapolis, MN"].unmapped, 1);
  assert.equal(byName["Minneapolis, MN"].no_greeting, 1);
  assert.equal(byName["Dallas, TX"].unmapped, 1);
  assert.equal(byName["Phoenix, AZ"].eligible, 0, "a selected market with no eligible seller still appears");
  assert.equal(byName["Phoenix, AZ"].not_routable, 2);
  assert.equal(byName["Phoenix, AZ"].bbox, null);
  // every point's market index names the market row it belongs to
  for (let i = 0; i < g.points.ids.length; i += 1) {
    const market = g.markets[g.points.market[i]].market;
    assert.equal(g.points.ids[i].startsWith(market[0].toLowerCase()), true);
  }
  // one batched coordinate read for the whole eligible set (no N+1), eligible ids only
  assert.equal(counter.coords, 1);
  assert.deepEqual([...counter.ids].sort(), ["d1", "d2", "d3", "m1", "m2", "m4"]);
});

test("geography shares the cohort's run (single flight + cache); the cohort never returns members", async () => {
  _resetComposerPreviewCaches();
  const counter = { cohort: 0, coords: 0, ids: null };
  const deps = cohortDeps(counter);
  const spec = { filters: FILTERS, template_use_case: "ownership_check" };
  const [cohort, geo] = await Promise.all([readComposerCohort(spec, deps), readComposerGeography(spec, deps)]);
  assert.equal(counter.cohort, 1, "Composer + Map asking together cost one cohort run");
  assert.equal(cohort.ok, true);
  assert.equal("members" in cohort, false, "no member rows leave the server through part=cohort");
  assert.equal(geo.eligible, cohort.sendable_after_personalization);
  const again = await readComposerGeography(spec, deps);
  assert.equal(again.cached, true);
  assert.equal(counter.cohort, 1);
  assert.equal(counter.coords, 1);
});

test("geography fails closed and named when coordinates cannot be read", async () => {
  _resetComposerPreviewCaches();
  const counter = { cohort: 0, coords: 0, ids: null };
  const deps = { ...cohortDeps(counter), readPropertyCoordinates: async () => { throw new Error("statement timeout"); } };
  const g = await readComposerGeography({ filters: FILTERS, template_use_case: "ownership_check" }, deps);
  assert.equal(g.ok, false);
  assert.equal(g.error, "coordinates_unavailable");
});
