/**
 * ENTITY-GRAPH-INTELLIGENCE-LOCK-1 -- the filter layer must be executable and
 * must fail closed.
 *
 * Two failures this pins, both of which have already happened in production:
 *
 *   1. AN EXPOSED FILTER THAT CONSTRAINS NOTHING.
 *      The Inbox shipped 8 such controls; `{"storiesMin":3}` returned 8,887 of
 *      8,887 threads. A filter that matches everything answers a question the
 *      operator did not ask.
 *
 *   2. A DROPPED FILTER TREATED AS "NO NARROWING".
 *      The campaign target builder did exactly this on 2026-09-14: it did not
 *      recognise `properties.property_id`, dropped it, and turned a
 *      five-property selection into 64,878 rows on a live campaign.
 *
 * So every field Entity Graph offers must compile to a real predicate against
 * a column that exists on the table that tab reads, and anything it cannot
 * execute must raise rather than run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS,
  ENTITY_GRAPH_FILTERABLE_TABS,
  ENTITY_GRAPH_FILTER_SOURCE_BY_TAB,
  EntityGraphUnsupportedFilterError,
  applyEntityGraphFieldFilters,
  getEntityGraphFilterCatalog,
  getEntityGraphFilterFields,
  parseEntityGraphFieldFilters,
  resolveEntityGraphFieldFilters,
  resolveEntityGraphFieldFiltersOrThrow,
} from "../../src/lib/domain/entity-graph/entity-graph-field-filters.js";
import { CAMPAIGN_FIELD_CATALOG } from "../../src/lib/domain/campaigns/campaign-field-catalog.js";
import { browseEntityGraph } from "../../src/lib/domain/entity-graph/entity-graph-service.js";

/** Records the PostgREST calls a filter compiles to, instead of running them. */
function recordingQuery(calls = []) {
  const query = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "__calls") return calls;
        if (prop === "then") return undefined;
        return (...args) => {
          calls.push({ method: String(prop), args });
          return query;
        };
      },
    },
  );
  return query;
}

function sampleValueFor(field) {
  if (field.type === "number") return 5;
  if (field.type === "date") return "2026-01-01";
  if (field.type === "boolean") return true;
  return "sample";
}

test("every filterable tab maps to the table its browse query reads", () => {
  assert.deepEqual(
    ENTITY_GRAPH_FILTER_SOURCE_BY_TAB,
    { properties: "properties", master_owners: "master_owners", people: "prospects", contact_methods: "phones" },
  );
  // markets and zips are RPC aggregates -- a property column filter cannot be
  // pushed into them, so they must not claim support.
  assert.ok(!ENTITY_GRAPH_FILTERABLE_TABS.includes("zips"));
  assert.ok(!ENTITY_GRAPH_FILTERABLE_TABS.includes("markets"));
});

test("the exposed fields come from the campaign catalog, not a second list", () => {
  const catalogKeys = new Set(CAMPAIGN_FIELD_CATALOG.map((field) => field.key));
  for (const tab of ENTITY_GRAPH_FILTERABLE_TABS) {
    const fields = getEntityGraphFilterFields(tab);
    assert.ok(fields.length > 0, `${tab} exposes no fields`);
    for (const field of fields) {
      assert.ok(catalogKeys.has(field.key), `${field.key} is not a catalog field`);
      assert.equal(
        field.source_table_or_view,
        ENTITY_GRAPH_FILTER_SOURCE_BY_TAB[tab],
        `${field.key} is not on the table ${tab} reads`,
      );
    }
  }
});

test("no field is exposed whose source Entity Graph never reads", () => {
  const exposed = new Set(
    ENTITY_GRAPH_FILTERABLE_TABS.flatMap((tab) => getEntityGraphFilterFields(tab).map((f) => f.key)),
  );
  const feederFields = CAMPAIGN_FIELD_CATALOG
    .filter((field) => field.source_table_or_view === "v_feeder_candidates_fast")
    .map((field) => field.key);
  assert.ok(feederFields.length > 0, "the catalog should still have feeder-sourced fields");
  const leaked = feederFields.filter((key) => exposed.has(key));
  assert.deepEqual(leaked, [], "outreach/sender_coverage fields are not on any Entity Graph source");
});

test("every exposed field compiles to at least one predicate", () => {
  const dead = [];
  for (const tab of ENTITY_GRAPH_FILTERABLE_TABS) {
    for (const field of getEntityGraphFilterFields(tab)) {
      const operator = field.operators?.[0]?.key;
      const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, [
        { field_key: field.key, operator, value: sampleValueFor(field) },
      ]);
      if (unsupported.length) {
        dead.push(`${field.key} -> ${unsupported[0].reason}`);
        continue;
      }
      const calls = [];
      applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
      if (calls.length === 0) dead.push(`${field.key} (${operator}) compiled to nothing`);
    }
  }
  assert.deepEqual(dead, [], `these fields are exposed but constrain nothing:\n  ${dead.join("\n  ")}`);
});

test("every operator the catalog advertises for a field is executable", () => {
  const broken = [];
  for (const tab of ENTITY_GRAPH_FILTERABLE_TABS) {
    for (const field of getEntityGraphFilterFields(tab)) {
      for (const { key: operator } of field.operators || []) {
        const value = operator === "between" ? [1, 9] : sampleValueFor(field);
        const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, [
          { field_key: field.key, operator, value },
        ]);
        if (unsupported.length) {
          broken.push(`${field.key} ${operator} -> ${unsupported[0].reason}`);
          continue;
        }
        const calls = [];
        applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
        if (calls.length === 0) broken.push(`${field.key} ${operator} compiled to nothing`);
      }
    }
  }
  assert.deepEqual(broken, [], `advertised but not executable:\n  ${broken.join("\n  ")}`);
});

test("the filter compiles against the catalog's source column", () => {
  const { resolved } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.tax_delinquent", operator: "is_true" },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].source_column, "tax_delinquent");
  const calls = [];
  applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
  assert.deepEqual(calls, [{ method: "eq", args: ["tax_delinquent", true] }]);
});

test("a legacy field key normalizes to its canonical column", () => {
  // properties.property_state is a sparse mirror; the catalog aliases it to the
  // canonical address column. Entity Graph must resolve it the same way the
  // campaign builder does, or the same saved cohort means two things.
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.property_state", operator: "is_any_of", value: ["MN"] },
  ]);
  assert.deepEqual(unsupported, []);
  assert.equal(resolved[0].field_key, "properties.property_address_state");
  assert.equal(resolved[0].source_column, "property_address_state");
});

test("a number range compiles to both bounds", () => {
  const { resolved } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.equity_percent", operator: "between", value: [40, 90] },
  ]);
  const calls = [];
  applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
  assert.deepEqual(calls, [
    { method: "gte", args: ["equity_percent", 40] },
    { method: "lte", args: ["equity_percent", 90] },
  ]);
});

test("an unknown field fails closed", () => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.does_not_exist", operator: "eq", value: "x" },
  ]);
  assert.deepEqual(resolved, []);
  assert.equal(unsupported[0].reason, "unknown_campaign_field");
});

test("a field from another domain fails closed rather than being dropped", () => {
  // master_owners.priority_tier is real -- just not a column on `properties`.
  // PostgREST would fail the whole query on it; dropping it would return all
  // 169,802 properties under a cohort's label.
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "master_owners.priority_tier", operator: "is_any_of", value: ["A"] },
  ]);
  assert.deepEqual(resolved, []);
  assert.equal(unsupported[0].reason, "field_not_on_entity_graph_source");
  assert.equal(unsupported[0].field_source, "master_owners");
  assert.equal(unsupported[0].tab_source, "properties");
});

test("an operator the field does not advertise fails closed", () => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.equity_percent", operator: "contains", value: "40" },
  ]);
  assert.deepEqual(resolved, []);
  assert.equal(unsupported[0].reason, "unsupported_operator");
});

test("an operator that needs a value and has none fails closed", () => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.property_address_city", operator: "contains", value: "" },
  ]);
  assert.deepEqual(resolved, []);
  assert.equal(unsupported[0].reason, "missing_value");
});

test("is_empty needs no value and still compiles", () => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters("properties", [
    { field_key: "properties.master_owner_id", operator: "is_empty" },
  ]);
  assert.deepEqual(unsupported, []);
  const calls = [];
  applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
  assert.deepEqual(calls, [{ method: "is", args: ["master_owner_id", null] }]);
});

test("a malformed payload is not read as 'no filters'", () => {
  const requested = parseEntityGraphFieldFilters({ field_filters: "{not json" });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].parse_error, "field_filters_not_json");
  const { unsupported } = resolveEntityGraphFieldFilters("properties", requested);
  assert.equal(unsupported[0].reason, "field_filters_not_json");
});

test("a field filter on an aggregate tab fails closed", () => {
  const requested = parseEntityGraphFieldFilters({
    field_filters: JSON.stringify([{ field_key: "properties.equity_percent", operator: "gte", value: 50 }]),
  });
  const { unsupported } = resolveEntityGraphFieldFilters("zips", requested);
  assert.equal(unsupported[0].reason, "tab_does_not_support_field_filters");
});

test("browseEntityGraph raises BEFORE it queries anything", async () => {
  // The proof that "fail closed" is not just a flag on the response: no query
  // may reach the database at all, because a query that runs is a query whose
  // rows someone can act on.
  const touched = [];
  const supabase = {
    from(table) {
      touched.push(table);
      throw new Error("the database must not be touched for an unsupported filter");
    },
  };
  await assert.rejects(
    () => browseEntityGraph(
      {
        tab: "properties",
        field_filters: JSON.stringify([{ field_key: "properties.not_a_column", operator: "eq", value: 1 }]),
      },
      { supabase },
    ),
    (error) => {
      assert.ok(error instanceof EntityGraphUnsupportedFilterError);
      assert.equal(error.code, "unsupported_entity_graph_filters");
      assert.equal(error.status, 422);
      assert.equal(error.unsupported_filters[0].reason, "unknown_campaign_field");
      return true;
    },
  );
  assert.deepEqual(touched, [], "no table may be read when a filter cannot be executed");
});

test("resolveEntityGraphFieldFiltersOrThrow passes clean filters through", () => {
  const { resolved, requested_count: requestedCount } = resolveEntityGraphFieldFiltersOrThrow("properties", {
    field_filters: JSON.stringify([
      { field_key: "properties.tax_delinquent", operator: "is_true" },
      { field_key: "properties.equity_percent", operator: "gte", value: 60 },
    ]),
  });
  assert.equal(requestedCount, 2);
  assert.equal(resolved.length, 2);
  const calls = [];
  applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
  assert.deepEqual(calls, [
    { method: "eq", args: ["tax_delinquent", true] },
    { method: "gte", args: ["equity_percent", 60] },
  ]);
});

test("no filters requested means no predicates and no error", () => {
  const { resolved, requested_count: requestedCount } = resolveEntityGraphFieldFiltersOrThrow("properties", {});
  assert.deepEqual(resolved, []);
  assert.equal(requestedCount, 0);
  const calls = [];
  applyEntityGraphFieldFilters(recordingQuery(calls), resolved);
  assert.deepEqual(calls, [], "an empty filter set must not touch the query");
});

test("columns measured empty are flagged, not silently offered", () => {
  const fields = getEntityGraphFilterCatalog("properties").groups.flatMap((group) => group.fields);
  for (const key of Object.keys(ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS)) {
    const field = fields.find((entry) => entry.key === key);
    assert.ok(field, `${key} should still be offered -- the campaign builder offers it`);
    assert.equal(field.data_coverage, "empty");
    assert.match(field.data_coverage_note, /sample/);
  }
  const flagged = fields.filter((field) => field.data_coverage === "empty").map((field) => field.key);
  assert.deepEqual(flagged.sort(), Object.keys(ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS).sort());
});

test("the catalog is grouped by category and reaches every executable field", () => {
  const catalog = getEntityGraphFilterCatalog("properties");
  assert.equal(catalog.source, "properties");
  const grouped = catalog.groups.flatMap((group) => group.fields);
  assert.equal(grouped.length, catalog.total_fields);
  assert.equal(grouped.length, getEntityGraphFilterFields("properties").length);
  assert.ok(catalog.groups.length > 5, "the property catalog has more than five categories");
});
