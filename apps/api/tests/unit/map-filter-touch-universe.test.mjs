/**
 * Property universe (All / Uncontacted / Contacted) — touch truth + counts.
 *
 * Prod defect (RC 8.4): "Contacted" = properties.contact_status IS NOT NULL and
 * not 'uncontacted' — but that legacy Podio column only holds 'No Contact' /
 * NULL, so 121,182 never-texted properties showed as Contacted; phones always
 * read 0 because they were counted over an empty bridge table; owners counted
 * only properties.master_owner_id (set on ~41.5K of ~170K properties).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildMapFilterExpressionFromInboxFilters } from "../../src/lib/domain/map-filters/inbox-to-map-filter-expression.js";
import { compileMapFilter } from "../../src/lib/domain/map-filters/map-filter-compiler.js";
import {
  buildMatchingPropertiesCte,
  buildOwnerCountFromMatchingSql,
  buildPhoneCountFromMatchingSql,
  buildPropertyEligibilitySql,
} from "../../src/lib/domain/map-filters/map-filter-predicate-sql.js";
import { MAP_FILTER_PHONE_LINKS_TABLE } from "../../src/lib/domain/map-filters/map-filter-phone-links.js";
import { MAP_FILTER_PROSPECT_LINKS_TABLE } from "../../src/lib/domain/map-filters/map-filter-prospect-links.js";
import { getMapFilterPreset } from "../../src/lib/domain/map-filters/map-filter-presets.js";
import { resolveRegistryFieldKey, getRegistryField } from "../../src/lib/domain/map-filters/active-field-registry.js";
import {
  clearMapFilterCountCache,
  countMapFilterEntities,
  countMapFilterEntitiesUncached,
} from "../../src/lib/domain/map-filters/map-filter-count-service.js";

function bucketSql(mapStatus, extraFilters = {}) {
  const expression = buildMapFilterExpressionFromInboxFilters(extraFilters, { mapStatus });
  const compiled = compileMapFilter(expression);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  return { compiled: compiled.compiled, ...buildPropertyEligibilitySql(compiled.compiled.compiledPredicateAst, compiled.compiled.params) };
}

// ── Bucket predicates ────────────────────────────────────────────────────────

test("All adds no touch predicate", () => {
  assert.equal(bucketSql("all").sql, "TRUE");
});

test("Contacted / Uncontacted compile to the campaign graph touch truth", () => {
  const contacted = bucketSql("contacted").sql;
  const uncontacted = bucketSql("uncontacted").sql;
  assert.match(contacted, /^EXISTS \(\s*SELECT 1 FROM public\.campaign_target_graph tg/);
  assert.match(contacted, /tg\.never_contacted IS FALSE/);
  assert.equal(uncontacted, `NOT ${contacted}`, "uncontacted must be the exact complement → buckets sum to the universe");
});

test("the legacy inverted properties.contact_status column is never used by the universe buckets", () => {
  for (const status of ["all", "contacted", "uncontacted"]) {
    const { sql, compiled } = bucketSql(status);
    assert.doesNotMatch(sql, /contact_status/, status);
    assert.ok(!compiled.referencedFieldKeys.includes("property.contact_status"), status);
  }
  for (const key of ["contacted", "uncontacted"]) {
    const { compiledPredicateAst, params } = compileMapFilter(getMapFilterPreset(key).expression).compiled;
    assert.doesNotMatch(buildPropertyEligibilitySql(compiledPredicateAst, params).sql, /contact_status/, key);
  }
  // Legacy aliases now resolve to the touch field, and the import column is labelled as such.
  assert.equal(resolveRegistryFieldKey("property.contacted"), "property.touch_state");
  assert.equal(resolveRegistryFieldKey("property.uncontacted"), "property.touch_state");
  assert.match(getRegistryField("property.contact_status").label, /Legacy/);
});

test("touch bucket composes with other filters (AND), params stay aligned", () => {
  const { sql, params } = bucketSql("uncontacted", { market: "Dallas, TX" });
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /p\.market/);
  assert.deepEqual(params, ["Dallas, TX"]);
});

test("touch operators take no value and reject unknown operators", () => {
  const bad = compileMapFilter({
    id: "root", type: "group", combinator: "AND", negated: false, enabled: true,
    children: [{ id: "r", type: "rule", fieldKey: "property.touch_state", operator: "equals", value: "x", enabled: true }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith("invalid_operator:property.touch_state")));
});

// ── Owners / phones SQL ──────────────────────────────────────────────────────

test("phones are counted from the graph's canonical_e164, not the empty phone-link bridge", () => {
  const sql = buildPhoneCountFromMatchingSql();
  assert.match(sql, /COUNT\(DISTINCT tg\.canonical_e164\)/);
  assert.match(sql, /campaign_target_graph tg/);
  assert.doesNotMatch(sql, new RegExp(MAP_FILTER_PHONE_LINKS_TABLE));
});

test("owners union properties.master_owner_id with the prospect→owner bridge", () => {
  const sql = buildOwnerCountFromMatchingSql();
  assert.match(sql, /mp\.master_owner_id IS NOT NULL/);
  assert.match(sql, /UNION/);
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  const withPredicate = buildOwnerCountFromMatchingSql("mo.best_language = 'es'");
  assert.match(withPredicate, /INNER JOIN master_owners mo ON mo\.master_owner_id = lo\.master_owner_id/);
});

test("matching CTE stays a plain property scan the counters can join", () => {
  const cte = buildMatchingPropertiesCte(bucketSql("contacted").sql, null, 0).sql;
  assert.match(cte, /FROM public\.properties p/);
  assert.match(cte, /campaign_target_graph/);
});

// ── Count service (fake pool: no network) ────────────────────────────────────

/**
 * A tiny in-memory model of the prod shape: 6 properties, the graph marks two as
 * touched; prospect links resolve owners that properties.master_owner_id lacks.
 * The fake client answers each count by evaluating the bucket over the fixture.
 */
const FIXTURE = {
  properties: [
    { property_id: "1", master_owner_id: "A" },
    { property_id: "2", master_owner_id: null },
    { property_id: "3", master_owner_id: null },
    { property_id: "4", master_owner_id: "B" },
    { property_id: "5", master_owner_id: null },
    { property_id: "6", master_owner_id: null }, // no graph row → uncontacted
  ],
  graph: [
    { property_id: "1", never_contacted: false, canonical_e164: "+12145550001" },
    { property_id: "2", never_contacted: true, canonical_e164: "+12145550002" },
    { property_id: "3", never_contacted: false, canonical_e164: "+12145550003" },
    { property_id: "4", never_contacted: true, canonical_e164: null },
    { property_id: "5", never_contacted: true, canonical_e164: "+12145550002" },
  ],
  links: [
    { property_id: "2", master_owner_id: "C" },
    { property_id: "3", master_owner_id: "D" },
    { property_id: "5", master_owner_id: "C" },
  ],
};

function bucketOf(sql) {
  if (/NOT EXISTS/.test(sql)) return "uncontacted";
  if (/EXISTS/.test(sql)) return "contacted";
  return "all";
}

function evaluate(bucket) {
  const touched = new Set(FIXTURE.graph.filter((g) => g.never_contacted === false).map((g) => g.property_id));
  const props = FIXTURE.properties.filter((p) =>
    bucket === "all" ? true : bucket === "contacted" ? touched.has(p.property_id) : !touched.has(p.property_id));
  const ids = new Set(props.map((p) => p.property_id));
  const owners = new Set([
    ...props.map((p) => p.master_owner_id).filter(Boolean),
    ...FIXTURE.links.filter((l) => ids.has(l.property_id)).map((l) => l.master_owner_id),
  ]);
  const phones = new Set(FIXTURE.graph.filter((g) => ids.has(g.property_id) && g.canonical_e164).map((g) => g.canonical_e164));
  return { properties: props.length, owners: owners.size, phones: phones.size };
}

function fakePool({ failPhase = null } = {}) {
  const log = [];
  let bucket = "all";
  const client = {
    async query(sql) {
      log.push(sql);
      if (/^CREATE TEMP TABLE/.test(sql)) { bucket = bucketOf(sql); return { rows: [] }; }
      if (/^(SET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql.trim())) return { rows: [] };
      const truth = evaluate(bucket);
      if (/COUNT\(\*\)::bigint AS count FROM _map_filter_matching_properties$/.test(sql.trim())) return { rows: [{ count: String(truth.properties) }] };
      if (/prospect_id/.test(sql) && !/master_owner_id/.test(sql)) return { rows: [{ count: "0" }] };
      if (/canonical_e164/.test(sql)) {
        if (failPhase === "phone") throw Object.assign(new Error("boom"), { code: "57014" });
        return { rows: [{ count: String(truth.phones) }] };
      }
      if (/master_owner_id/.test(sql)) {
        if (failPhase === "owner") throw Object.assign(new Error("boom"), { code: "XX000" });
        return { rows: [{ count: String(truth.owners) }] };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
  return { log, getPool: () => ({ connect: async () => client }), hasDb: () => true };
}

async function countBucket(status, deps) {
  const { compiled } = bucketSql(status);
  return countMapFilterEntitiesUncached(compiled, {}, deps);
}

test("bucket counts sum to the universe and phones are non-zero where the data has phones", async () => {
  const all = await countBucket("all", fakePool());
  const contacted = await countBucket("contacted", fakePool());
  const uncontacted = await countBucket("uncontacted", fakePool());

  assert.equal(all.counts.matchingProperties, 6);
  assert.equal(contacted.counts.matchingProperties + uncontacted.counts.matchingProperties, all.counts.matchingProperties);
  assert.equal(contacted.counts.matchingProperties, 2);
  assert.equal(uncontacted.counts.matchingProperties, 4, "a property with no graph row is uncontacted, not dropped");

  // Owners include bridge-only owners (C, D); properties.master_owner_id alone would say 2.
  assert.equal(all.counts.matchingMasterOwners, 4);
  assert.ok(all.counts.matchingPhones > 0);
  assert.equal(all.counts.matchingPhones, 3);
  assert.equal(contacted.counts.matchingPhones, 2);
  assert.equal(all.meta.phoneSource, "campaign_target_graph.canonical_e164");
  assert.equal(all.meta.touchSource, "campaign_target_graph.never_contacted");
});

test("an owner/phone count that cannot be computed is null (UI '—'), never 0, and rolls back only its savepoint", async () => {
  const pool = fakePool({ failPhase: "phone" });
  const res = await countBucket("contacted", pool);
  assert.equal(res.counts.matchingProperties, 2);
  assert.equal(res.counts.matchingMasterOwners, 2);
  assert.equal(res.counts.matchingPhones, null);
  assert.equal(res.meta.phaseErrors.phone, "phone_count_timeout");
  assert.ok(pool.log.includes("ROLLBACK TO SAVEPOINT map_filter_phone"));
  assert.ok(pool.log.includes("COMMIT"));
});

test("repeat clicks on the same bucket are served from the short-lived cache", async () => {
  clearMapFilterCountCache();
  let runs = 0;
  let t = 1_000;
  const run = async () => { runs += 1; return { counts: { matchingProperties: runs }, timing: {}, meta: { phaseErrors: {} } }; };
  const { compiled } = bucketSql("contacted");
  const a = await countMapFilterEntities(compiled, {}, { now: () => t, run });
  t += 60_000;
  const b = await countMapFilterEntities(compiled, {}, { now: () => t, run });
  assert.equal(runs, 1);
  assert.equal(b.counts.matchingProperties, a.counts.matchingProperties);
  assert.equal(b.timing.cacheHit, true);
  t += 61_000; // past the 120s TTL
  await countMapFilterEntities(compiled, {}, { now: () => t, run });
  assert.equal(runs, 2);
  // A different bucket is a different key.
  await countMapFilterEntities(bucketSql("uncontacted").compiled, {}, { now: () => t, run });
  assert.equal(runs, 3);
  clearMapFilterCountCache();
});

test("results with a failed phase are not cached", async () => {
  clearMapFilterCountCache();
  let runs = 0;
  const run = async () => { runs += 1; return { counts: {}, timing: {}, meta: { phaseErrors: { phone: "phone_count_timeout" } } }; };
  const { compiled } = bucketSql("all", { market: "Dallas, TX" });
  await countMapFilterEntities(compiled, {}, { now: () => 0, run });
  await countMapFilterEntities(compiled, {}, { now: () => 1, run });
  assert.equal(runs, 2);
  clearMapFilterCountCache();
});
