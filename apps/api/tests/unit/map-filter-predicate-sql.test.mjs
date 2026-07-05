import test from "node:test";
import assert from "node:assert/strict";

import { compileMapFilter } from "../../src/lib/domain/map-filters/map-filter-compiler.js";
import {
  buildPropertyCountSql,
  buildPropertyEligibilitySql,
  buildProspectCountSql,
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

test("property count SQL uses COUNT DISTINCT", () => {
  const { sql } = compileSql(group("root", "AND", [rule("r", "property.property_type", "equals", "SFR")]));
  const propertyCount = buildPropertyCountSql(sql);
  assert.match(propertyCount.sql, /COUNT\(DISTINCT p\.property_id\)/i);
});

test("prospect count SQL uses COUNT DISTINCT", () => {
  const { sql } = compileSql(group("root", "AND", [rule("r", "property.property_type", "equals", "SFR")]));
  const prospectCount = buildProspectCountSql(sql);
  assert.match(prospectCount.sql, /COUNT\(DISTINCT pr\.prospect_id\)/i);
});

test("relationship any_linked uses EXISTS with linked_property_ids_json", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  );
  assert.match(sql, /EXISTS/i);
  assert.match(sql, /linked_property_ids_json/i);
  assert.doesNotMatch(sql, /is_primary_prospect/i);
});

test("relationship primary_only requires primary prospect", () => {
  const { sql } = compileSql(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "primary_only" }),
    ]),
  );
  assert.match(sql, /is_primary_prospect IS TRUE/i);
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
  assert.match(sql, /linked_property_ids_json/i);
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
  assert.match(sql, /linked_property_ids_json/i);
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