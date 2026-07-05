import test from "node:test";
import assert from "node:assert/strict";

import { compileMapFilter } from "../../src/lib/domain/map-filters/map-filter-compiler.js";
import { MAP_FILTER_PROSPECT_LINKS_TABLE } from "../../src/lib/domain/map-filters/map-filter-prospect-links.js";
import {
  buildOwnerCountSql,
  buildPropertyCountSql,
  buildPropertyEligibilitySql,
  buildProspectCountSql,
  buildUnifiedCountSql,
} from "../../src/lib/domain/map-filters/map-filter-predicate-sql.js";

function rule(id, fieldKey, operator, value, extra = {}) {
  return { id, type: "rule", fieldKey, operator, value, enabled: true, ...extra };
}

function group(id, combinator, children, extra = {}) {
  return { id, type: "group", combinator, negated: false, enabled: true, children, ...extra };
}

function compileSql(expression) {
  const compiled = compileMapFilter(expression);
  assert.equal(compiled.ok, true);
  return buildPropertyEligibilitySql(compiled.compiled.compiledPredicateAst, compiled.compiled.params);
}

test("property count SQL uses matching_properties CTE", () => {
  const { sql, params } = compileSql(group("root", "AND", [rule("r", "property.property_type", "equals", "SFR")]));
  const propertyCount = buildPropertyCountSql(sql, null, params.length);
  assert.match(propertyCount.sql, /matching_properties AS MATERIALIZED/i);
  assert.match(propertyCount.sql, /COUNT\(\*\)::bigint AS count/i);
});

test("prospect count SQL uses bridge and COUNT DISTINCT prospect_id", () => {
  const { sql, params } = compileSql(group("root", "AND", [rule("r", "property.property_type", "equals", "SFR")]));
  const prospectCount = buildProspectCountSql(sql, params.length);
  assert.match(prospectCount.sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.match(prospectCount.sql, /COUNT\(DISTINCT link\.prospect_id\)/i);
  assert.doesNotMatch(prospectCount.sql, /linked_property_ids_json/i);
});

test("relationship any_linked uses bridge EXISTS", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  );
  assert.match(sql, /EXISTS/i);
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.doesNotMatch(sql, /linked_property_ids_json/i);
  assert.doesNotMatch(sql, /is_primary_prospect/i);
});

test("relationship primary_only requires primary prospect via bridge", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "primary_only" }),
    ]),
  );
  assert.match(sql, /is_primary_prospect IS TRUE/i);
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
});

test("relationship none_linked negates linked EXISTS", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "none_linked" }),
    ]),
  );
  assert.match(sql, /NOT \(EXISTS/i);
});

test("relationship all_linked requires linked records and no failing linked records", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "all_linked" }),
    ]),
  );
  assert.match(sql, /EXISTS/i);
  assert.match(sql, /NOT EXISTS/i);
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.doesNotMatch(sql, /linked_property_ids_json/i);
});

test("owner rules compile as EXISTS against master_owners", () => {
  const { sql } = compileSql(
    group("root", "AND", [rule("o", "master_owner.property_count", "greater_than_or_equal", 5)]),
  );
  assert.match(sql, /FROM master_owners mo/i);
  assert.match(sql, /mo\.property_count >=/i);
});

test("mixed entity OR compiles to single boolean expression", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      group("or-1", "OR", [
        rule("mf", "property.property_type", "equals", "Multifamily 5+"),
        rule("sms", "prospect.sms_eligible", "is_true", true),
      ]),
      group("or-2", "OR", [
        rule("pc", "master_owner.property_count", "greater_than_or_equal", 5),
        rule("eq", "property.equity_percent", "greater_than_or_equal", 70),
      ]),
    ]),
  );
  assert.match(sql, /OR/i);
  assert.match(sql, /AND/i);
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.match(sql, /master_owners mo/i);
});

test("negated group wraps predicate in NOT", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      group("neg", "OR", [rule("r", "property.tax_delinquent", "is_true", true)], { negated: true }),
    ]),
  );
  assert.match(sql, /NOT \(/i);
});

test("all_linked requires at least one linked prospect and is not vacuously true", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "all_linked" }),
    ]),
  );
  assert.match(sql, /EXISTS/i);
  assert.match(sql, /NOT EXISTS/i);
  assert.doesNotMatch(sql, /NOT EXISTS[\s\S]*NOT EXISTS[\s\S]*TRUE/i);
});

test("unified count SQL computes all entities from one matching_properties CTE", () => {
  const { sql, params } = compileSql(group("root", "AND", [rule("r", "property.property_type", "equals", "SFR")]));
  const unified = buildUnifiedCountSql(sql, null, params.length);
  const cteMatches = unified.sql.match(/matching_properties AS MATERIALIZED/gi) || [];
  assert.equal(cteMatches.length, 1);
  assert.match(unified.sql, /AS matching_prospects/i);
  assert.match(unified.sql, /AS matching_master_owners/i);
});

test("owner count SQL uses properties.master_owner_id not joined_property_ids_json", () => {
  const { sql, params } = compileSql(
    group("root", "AND", [rule("o", "master_owner.property_count", "greater_than_or_equal", 5)]),
  );
  const ownerSql = buildOwnerCountSql(sql, params.length);
  assert.match(ownerSql, /master_owner_id/i);
  assert.doesNotMatch(ownerSql, /joined_property_ids_json/i);
});

test("property count with bounds offsets parameter indices after predicate params", () => {
  const { sql, params } = compileSql(
    group("root", "AND", [
      rule("p", "property.market", "equals", "TAMPA"),
      rule("pr", "prospect.sms_eligible", "is_true", true),
    ]),
  );
  const bounds = { lat_min: 27.8, lat_max: 28.2, lng_min: -82.6, lng_max: -82.2 };
  const propertyCount = buildPropertyCountSql(sql, bounds, params.length);
  assert.match(propertyCount.sql, /\$2 AND \$3/);
  assert.match(propertyCount.sql, /\$4 AND \$5/);
  assert.equal(propertyCount.extraParams.length, 4);
});