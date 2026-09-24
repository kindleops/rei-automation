import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalMarketDirectory,
  canonicalGeoKey,
  canonicalMarketBucket,
  loadCanonicalMarketDirectory,
  resetCanonicalMarketDirectoryCache,
  resolveMarketLabel,
  searchCanonicalMarketIds,
  splitMarketLabel,
} from "@/lib/domain/geography/canonical-market.js";
import { queryCampaignFieldOptions } from "@/lib/domain/campaigns/campaign-field-catalog.js";
import { resolveMarketSendingProfile } from "@/lib/config/market-sending-zones.js";

// The production taxonomy (public.canonical_markets, 2026-09-24).
const MARKETS = [
  ["albuquerque-nm", "Albuquerque, NM"], ["atlanta-ga", "Atlanta, GA"], ["austin-tx", "Austin, TX"],
  ["bakersfield-ca", "Bakersfield, CA"], ["baltimore-md", "Baltimore, MD"], ["birmingham-al", "Birmingham, AL"],
  ["boise-id", "Boise, ID"], ["charlotte-nc", "Charlotte, NC"], ["chicago-il", "Chicago, IL"],
  ["cincinnati-oh", "Cincinnati, OH"], ["cleveland-oh", "Cleveland, OH"], ["colorado-springs-co", "Colorado Springs, CO"],
  ["columbus-oh", "Columbus, OH"], ["dallas-tx", "Dallas, TX"], ["des-moines-ia", "Des Moines, IA"],
  ["detroit-mi", "Detroit, MI"], ["durham-nc", "Durham, NC"], ["el-paso-tx", "El Paso, TX"],
  ["fayetteville-nc", "Fayetteville, NC"], ["fresno-ca", "Fresno, CA"], ["hampton-roads-va", "Hampton Roads, VA"],
  ["hartford-ct", "Hartford, CT"], ["houston-tx", "Houston, TX"], ["indianapolis-in", "Indianapolis, IN"],
  ["inland-empire-ca", "Inland Empire, CA"], ["jacksonville-fl", "Jacksonville, FL"], ["kansas-city-mo", "Kansas City, MO"],
  ["las-vegas-nv", "Las Vegas, NV"], ["los-angeles-ca", "Los Angeles, CA"], ["louisville-ky", "Louisville, KY"],
  ["memphis-tn", "Memphis, TN"], ["miami-fl", "Miami, FL"], ["milwaukee-wi", "Milwaukee, WI"],
  ["minneapolis-mn", "Minneapolis, MN"], ["modesto-ca", "Modesto, CA"], ["new-orleans-la", "New Orleans, LA"],
  ["oklahoma-city-ok", "Oklahoma City, OK"], ["omaha-ne", "Omaha, NE"], ["orlando-fl", "Orlando, FL"],
  ["philadelphia-pa", "Philadelphia, PA"], ["phoenix-az", "Phoenix, AZ"], ["pittsburgh-pa", "Pittsburgh, PA"],
  ["providence-ri", "Providence, RI"], ["richmond-va", "Richmond, VA"], ["rochester-ny", "Rochester, NY"],
  ["rocky-mount-nc", "Rocky Mount, NC"], ["sacramento-ca", "Sacramento, CA"], ["salt-lake-city-ut", "Salt Lake City, UT"],
  ["san-antonio-tx", "San Antonio, TX"], ["san-diego-ca", "San Diego, CA"], ["seattle-wa", "Seattle, WA"],
  ["spokane-wa", "Spokane, WA"], ["st-louis-mo", "St. Louis, MO"], ["stockton-ca", "Stockton, CA"],
  ["tampa-fl", "Tampa, FL"], ["tucson-az", "Tucson, AZ"], ["tulsa-ok", "Tulsa, OK"], ["wichita-ks", "Wichita, KS"],
].map(([id, display_name]) => ({ id, display_name, state: display_name.slice(-2), is_active: true }));

function alias(name, state, marketId, type) {
  return { alias_key: `${canonicalGeoKey(name)}|${state}`, alias: `${name}, ${state}`, state, canonical_market_id: marketId, alias_type: type };
}

const ALIASES = [
  ...MARKETS.map((m) => alias(m.display_name.split(",")[0], m.state, m.id, "canonical_name")),
  alias("Tuscon", "AZ", "tucson-az", "misspelling"),
  alias("Clayton", "GA", "atlanta-ga", "legacy_label"),
  alias("Fort Worth", "TX", "dallas-tx", "legacy_label"),
  alias("St Paul", "MN", "minneapolis-mn", "legacy_label"),
  alias("West Palm Beach", "FL", "miami-fl", "legacy_label"),
  alias("Riverside", "CA", "inland-empire-ca", "legacy_label"),
  alias("Norfolk", "VA", "hampton-roads-va", "legacy_label"),
  alias("Diamond Bar", "CA", "los-angeles-ca", "locality_derived"),
  alias("Ontario", "CA", "inland-empire-ca", "locality_derived"),
  alias("Loxahatchee", "FL", "miami-fl", "locality_derived"),
  alias("Wayzata", "MN", "minneapolis-mn", "locality_derived"),
  alias("Seagoville", "TX", "dallas-tx", "locality_derived"),
  alias("Sun City West", "AZ", "phoenix-az", "locality_derived"),
  alias("Saint Louis", "MO", "st-louis-mo", "locality_derived"),
];

const directory = buildCanonicalMarketDirectory({ markets: MARKETS, aliases: ALIASES });

/** PostgREST-shaped fake: select / eq / in / ilike / order / limit / range, thenable. */
function fakeSupabase(tables) {
  const calls = [];
  function from(table) {
    const state = { table, filters: [], limit: null, range: null, options: null };
    calls.push(state);
    const run = () => {
      let rows = (tables[table] || []).filter((row) => state.filters.every(([op, column, value]) => {
        if (op === "eq") return row[column] === value;
        if (op === "in") return value.includes(row[column]);
        if (op === "ilike") return String(row[column] ?? "").toLowerCase().includes(value.replace(/%/g, "").toLowerCase());
        return true;
      }));
      const count = rows.length;
      if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
      if (state.limit != null) rows = rows.slice(0, state.limit);
      return { data: rows, error: null, count };
    };
    const chain = {
      select(_columns, options) { state.options = options ?? null; return chain; },
      eq(column, value) { state.filters.push(["eq", column, value]); return chain; },
      in(column, value) { state.filters.push(["in", column, value]); return chain; },
      ilike(column, value) { state.filters.push(["ilike", column, value]); return chain; },
      not() { return chain; },
      order() { return chain; },
      limit(n) { state.limit = n; return chain; },
      range(a, b) { state.range = [a, b]; return chain; },
      maybeSingle() { return Promise.resolve({ ...run(), data: run().data[0] ?? null }); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return chain;
  }
  return { from, calls };
}

function marketFacets() {
  // One row per canonical market, as refresh_campaign_target_graph_facets() writes them.
  return [
    ["Miami, FL", 20395], ["Los Angeles, CA", 16794], ["Dallas, TX", 7738], ["Inland Empire, CA", 6206],
    ["Minneapolis, MN", 5000], ["Phoenix, AZ", 6175], ["Tucson, AZ", 1200], ["Atlanta, GA", 3000],
  ].map(([value, target_count]) => ({
    field_key: "properties.market", value, label: value, target_count,
    clean_count: target_count, queueable_count: target_count, sender_covered_count: 0, sms_eligible_count: target_count,
    updated_at: "2026-09-24T14:18:01Z",
  }));
}

function cityFacets() {
  return [
    ["Diamond Bar", 410], ["Ontario", 600], ["Los Angeles", 9000],
  ].map(([value, target_count]) => ({
    field_key: "properties.property_address_city", value, label: value, target_count,
    clean_count: 0, queueable_count: 0, sender_covered_count: 0, sms_eligible_count: 0, updated_at: "2026-09-24T14:18:01Z",
  }));
}

function catalogSupabase() {
  return fakeSupabase({
    canonical_markets: MARKETS,
    market_aliases: ALIASES,
    campaign_target_graph: [],
    campaign_target_graph_refresh_runs: [],
    campaign_target_graph_facets: [...marketFacets(), ...cityFacets()],
  });
}

// A. key normalisation matches SQL canonical_geo_key()
test("A: canonicalGeoKey matches the SQL key function", () => {
  assert.equal(canonicalGeoKey("Saint Louis"), "st louis");
  assert.equal(canonicalGeoKey("St. Louis"), "st louis");
  assert.equal(canonicalGeoKey("ST LOUIS"), "st louis");
  assert.equal(canonicalGeoKey("Ft. Worth"), "fort worth");
  assert.equal(canonicalGeoKey("Winston-Salem"), "winston salem");
  assert.equal(canonicalGeoKey("  "), null);
  assert.equal(canonicalGeoKey(null), null);
  // "st" inside a word is not a Saint abbreviation
  assert.equal(canonicalGeoKey("Stockton"), "stockton");
});

// B. labels split into place + state
test("B: splitMarketLabel separates place and state", () => {
  assert.deepEqual(splitMarketLabel("Diamond Bar, CA"), { name: "Diamond Bar", state: "CA" });
  assert.deepEqual(splitMarketLabel("St. Louis, mo"), { name: "St. Louis", state: "MO" });
  assert.deepEqual(splitMarketLabel("Miami"), { name: "Miami", state: null });
  assert.deepEqual(splitMarketLabel(""), { name: null, state: null });
});

// C. the resolver's label step
test("C: canonical names, ids and aliases resolve to one market id", () => {
  assert.equal(resolveMarketLabel(directory, "Los Angeles, CA").market_id, "los-angeles-ca");
  assert.equal(resolveMarketLabel(directory, "los-angeles-ca").market_name, "Los Angeles, CA");
  assert.equal(resolveMarketLabel(directory, "Diamond Bar, CA").market_name, "Los Angeles, CA");
  assert.equal(resolveMarketLabel(directory, "Ontario, CA").market_name, "Inland Empire, CA");
  assert.equal(resolveMarketLabel(directory, "Loxahatchee, FL").market_name, "Miami, FL");
  assert.equal(resolveMarketLabel(directory, "Tuscon, AZ").market_name, "Tucson, AZ");
  assert.equal(resolveMarketLabel(directory, "Saint Louis, MO").market_name, "St. Louis, MO");
  assert.equal(resolveMarketLabel(directory, "Clayton, GA").market_name, "Atlanta, GA");
  assert.equal(resolveMarketLabel(directory, "Fort Worth, TX").market_name, "Dallas, TX");
  assert.equal(resolveMarketLabel(directory, "St. Paul, MN").market_name, "Minneapolis, MN");
  assert.equal(resolveMarketLabel(directory, "Norfolk, VA").market_name, "Hampton Roads, VA");
});

test("D: a label is trusted only inside its own state and never guessed", () => {
  // 1,819 Franklin County OH rows were labelled "Tampa, FL"
  assert.equal(resolveMarketLabel(directory, "Tampa, FL", "OH"), null);
  // a bare city carries no state context
  assert.equal(resolveMarketLabel(directory, "Diamond Bar"), null);
  // same place name, wrong state
  assert.equal(resolveMarketLabel(directory, "Ontario, OR"), null);
  // a place the taxonomy doesn't know
  assert.equal(resolveMarketLabel(directory, "Cheyenne, WY"), null);
  assert.equal(resolveMarketLabel(directory, "Unmapped"), null);
  assert.equal(resolveMarketLabel(null, "Miami, FL"), null);
});

test("E: historical buckets derive the canonical market and keep unplaceable labels as-is", () => {
  assert.equal(canonicalMarketBucket(directory, "West Palm Beach, FL"), "Miami, FL");
  assert.equal(canonicalMarketBucket(directory, "Clayton, GA"), "Atlanta, GA");
  assert.equal(canonicalMarketBucket(directory, "miami"), "miami");
  assert.equal(canonicalMarketBucket(directory, ""), null);
  assert.equal(canonicalMarketBucket(null, "Clayton, GA"), "Clayton, GA");
});

test("F: search reaches a market through any of its aliases", () => {
  assert.deepEqual(searchCanonicalMarketIds(directory, "Diamond Bar"), ["los-angeles-ca"]);
  assert.deepEqual(searchCanonicalMarketIds(directory, "fort worth"), ["dallas-tx"]);
  assert.deepEqual(searchCanonicalMarketIds(directory, "st paul"), ["minneapolis-mn"]);
  assert.deepEqual(searchCanonicalMarketIds(directory, "Saint Louis"), ["st-louis-mo"]);
  assert.deepEqual(searchCanonicalMarketIds(directory, ""), []);
});

test("G: the directory loads every alias page and is cached", async () => {
  resetCanonicalMarketDirectoryCache();
  const many = Array.from({ length: 2300 }, (_, i) => alias(`Place ${i}`, "CA", "los-angeles-ca", "locality_derived"));
  const supabase = fakeSupabase({ canonical_markets: MARKETS, market_aliases: [...ALIASES, ...many] });
  const loaded = await loadCanonicalMarketDirectory({ supabase });
  assert.equal(loaded.size, 58);
  assert.equal(resolveMarketLabel(loaded, "Place 2299, CA").market_id, "los-angeles-ca");
  const callsAfterFirst = supabase.calls.length;
  await loadCanonicalMarketDirectory({ supabase });
  assert.equal(supabase.calls.length, callsAfterFirst, "second load served from cache");
  resetCanonicalMarketDirectoryCache();
});

// H–K: the campaign selector contract
test("H: market options return {market_id, market_name, count} from the canonical graph facets", async () => {
  resetCanonicalMarketDirectoryCache();
  const result = await queryCampaignFieldOptions({ field_key: "properties.market", deps: { supabase: catalogSupabase() } });
  assert.equal(result.ok, true);
  assert.equal(result.options.length, 8);
  for (const option of result.options) {
    assert.ok(option.market_id, `${option.value} carries a market id`);
    assert.equal(option.market_name, option.value);
    assert.equal(option.count_source, "campaign_target_graph");
  }
  const la = result.options.find((o) => o.market_id === "los-angeles-ca");
  assert.equal(la.count, 16794);
  assert.equal(la.label, "Los Angeles, CA");
  // one option per market — no city ever appears as a market
  assert.equal(new Set(result.options.map((o) => o.market_id)).size, result.options.length);
  assert.ok(!result.options.some((o) => o.value === "Diamond Bar" || o.value === "Diamond Bar, CA"));
});

test("I: searching a locality returns its operating market, not the locality", async () => {
  resetCanonicalMarketDirectoryCache();
  const supabase = catalogSupabase();
  const diamond = await queryCampaignFieldOptions({ field_key: "properties.market", search: "Diamond Bar", deps: { supabase } });
  assert.deepEqual(diamond.options.map((o) => [o.market_id, o.count]), [["los-angeles-ca", 16794]]);
  const ontario = await queryCampaignFieldOptions({ field_key: "properties.market", search: "ontario", deps: { supabase } });
  assert.deepEqual(ontario.options.map((o) => o.market_id), ["inland-empire-ca"]);
  const tuscon = await queryCampaignFieldOptions({ field_key: "properties.market", search: "Tuscon", deps: { supabase } });
  assert.deepEqual(tuscon.options.map((o) => o.market_id), ["tucson-az"]);
  const nothing = await queryCampaignFieldOptions({ field_key: "properties.market", search: "Cheyenne", deps: { supabase } });
  assert.deepEqual(nothing.options, []);
});

test("J: City stays a separate filter with raw localities and no market identity", async () => {
  resetCanonicalMarketDirectoryCache();
  const result = await queryCampaignFieldOptions({ field_key: "properties.property_address_city", deps: { supabase: catalogSupabase() } });
  assert.deepEqual(result.options.map((o) => o.value).sort(), ["Diamond Bar", "Los Angeles", "Ontario"]);
  assert.ok(result.options.every((o) => !("market_id" in o)));
});

test("K: a missing directory degrades to plain facets with a warning, never to city options", async () => {
  resetCanonicalMarketDirectoryCache();
  const supabase = fakeSupabase({
    campaign_target_graph: [], campaign_target_graph_refresh_runs: [],
    campaign_target_graph_facets: [...marketFacets(), ...cityFacets()],
  });
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    if (table === "canonical_markets" || table === "market_aliases") {
      const chain = { select: () => chain, order: () => chain, range: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) };
      return chain;
    }
    return originalFrom(table);
  };
  const result = await queryCampaignFieldOptions({ field_key: "properties.market", deps: { supabase } });
  assert.equal(result.options.length, 8);
  assert.ok(result.warnings.some((w) => w.startsWith("canonical_market_directory_unavailable")));
  assert.ok(result.options.every((o) => o.market_id === null));
  resetCanonicalMarketDirectoryCache();
});

// L–N: sender routing consumes canonical identity with the same clusters
test("L: every canonical market has a sender cluster", () => {
  for (const market of MARKETS) {
    const profile = resolveMarketSendingProfile(market.display_name);
    assert.equal(profile.ok, true, `${market.display_name} routes`);
    assert.ok(profile.allowed_phone_markets.length > 0);
  }
});

test("M: corrected markets route to their own region, not the mislabel's", () => {
  // Franklin County OH was labelled "Tampa, FL" (jacksonville cluster); canonical Columbus routes Midwest.
  assert.equal(resolveMarketSendingProfile("Tampa, FL").primary_cluster, "jacksonville_cluster");
  assert.equal(resolveMarketSendingProfile("Columbus, OH").primary_cluster, "minneapolis_cluster");
  // Markets split out of "Charlotte, NC" keep Charlotte's sender cluster.
  for (const name of ["Durham, NC", "Fayetteville, NC", "Rocky Mount, NC", "Hampton Roads, VA"]) {
    assert.equal(resolveMarketSendingProfile(name).primary_cluster, "charlotte_cluster", name);
  }
  assert.equal(resolveMarketSendingProfile("Inland Empire, CA").primary_cluster, "los_angeles_cluster");
  assert.equal(resolveMarketSendingProfile("St. Louis, MO").primary_cluster, "minneapolis_cluster");
  assert.equal(resolveMarketSendingProfile("Atlanta, GA").primary_cluster, "atlanta_cluster");
});

test("N: routing still refuses unmapped and missing markets", () => {
  assert.equal(resolveMarketSendingProfile("Unmapped").ok, false);
  assert.equal(resolveMarketSendingProfile(null).reason, "missing_market");
});
