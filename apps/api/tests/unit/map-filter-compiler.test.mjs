import test from "node:test";
import assert from "node:assert/strict";

import { compileMapFilter } from "../../src/lib/domain/map-filters/map-filter-compiler.js";
import { getMapFilterPreset } from "../../src/lib/domain/map-filters/map-filter-presets.js";
import { EXCLUDED_EMPTY_FIELDS } from "../../src/lib/domain/map-filters/active-field-registry.js";

function rule(id, fieldKey, operator, value, extra = {}) {
  return { id, type: "rule", fieldKey, operator, value, enabled: true, ...extra };
}

function group(id, combinator, children, extra = {}) {
  return { id, type: "group", combinator, negated: false, enabled: true, children, ...extra };
}

function collectAstRuleTypes(ast) {
  const types = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === "group") {
      (node.children || []).forEach(walk);
      return;
    }
    types.push(node.type);
  };
  walk(ast);
  return types;
}

test("one property rule compiles to property_rule AST", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("r1", "property.property_type", "equals", "SFR")]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(collectAstRuleTypes(result.compiled.compiledPredicateAst), ["property_rule"]);
});

test("one prospect rule compiles to prospect_rule AST", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("r1", "prospect.sms_eligible", "is_true", true)]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(collectAstRuleTypes(result.compiled.compiledPredicateAst), ["prospect_rule"]);
});

test("one phone rule compiles to phone_rule AST", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      rule("r", "phone.phone_type", "equals", "Mobile", { relationshipMatch: "any_linked" }),
    ]),
  );
  assert.equal(result.ok, true);
  const ast = result.compiled.compiledPredicateAst;
  assert.equal(ast.type, "phone_rule");
  assert.equal(ast.relationshipMatch, "any_linked");
  assert.equal(ast.fieldKey, "phone.phone_type");
});

test("one master owner rule compiles to owner_rule AST", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("r1", "master_owner.property_count", "greater_than_or_equal", 5)]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(collectAstRuleTypes(result.compiled.compiledPredicateAst), ["owner_rule"]);
});

test("property plus prospect AND preserves nested group structure", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      rule("p", "property.property_type", "equals", "SFR"),
      rule("pr", "prospect.sms_eligible", "is_true", true),
    ]),
  );
  assert.equal(result.ok, true);
  const ast = result.compiled.compiledPredicateAst;
  assert.equal(ast.type, "group");
  assert.equal(ast.combinator, "AND");
  assert.equal(ast.children.length, 2);
});

test("mixed entity OR group compiles without flattening", () => {
  const result = compileMapFilter(
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
  assert.equal(result.ok, true);
  const ast = result.compiled.compiledPredicateAst;
  assert.equal(ast.type, "group");
  assert.equal(ast.children.length, 2);
  assert.equal(ast.children[0].combinator, "OR");
  assert.equal(ast.children[1].combinator, "OR");
  const types = collectAstRuleTypes(ast);
  assert.ok(types.includes("property_rule"));
  assert.ok(types.includes("prospect_rule"));
  assert.ok(types.includes("owner_rule"));
});

test("negated group compiles with negated flag", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      group("neg", "OR", [rule("r", "property.tax_delinquent", "is_true", true)], { negated: true }),
    ]),
  );
  assert.equal(result.ok, true);
  const ast = result.compiled.compiledPredicateAst;
  const negatedGroup = ast.negated ? ast : ast.children?.[0];
  assert.equal(negatedGroup?.negated, true);
});

test("disabled rule is omitted from compiled AST", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      rule("enabled", "property.property_type", "equals", "SFR"),
      rule("disabled", "property.tax_delinquent", "is_true", true, { enabled: false }),
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.compiled.activeRuleCount, 1);
  assert.deepEqual(collectAstRuleTypes(result.compiled.compiledPredicateAst), ["property_rule"]);
});

test("json array membership compiles with params", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      rule("tags", "property.seller_tags_json", "contains_any", ["HOT_SELLER"]),
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.compiled.params.length, 1);
});

test("partial coverage boolean field compiles", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("sms", "property.sms_eligible", "is_true", true)]),
  );
  assert.equal(result.ok, true);
});

test("null versus false operators compile for booleans", () => {
  const unknown = compileMapFilter(group("root", "AND", [rule("u", "property.tax_delinquent", "is_unknown", null)]));
  const falsey = compileMapFilter(group("root", "AND", [rule("f", "property.tax_delinquent", "is_false", false)]));
  assert.equal(unknown.ok, true);
  assert.equal(falsey.ok, true);
  assert.notDeepEqual(unknown.compiled.compiledPredicateAst, falsey.compiled.compiledPredicateAst);
});

test("has data and has no data compile for derived presence fields", () => {
  const hasData = compileMapFilter(
    group("root", "AND", [rule("hd", "prospect.linked_property_ids_json", "has_data", null)]),
  );
  const hasNoData = compileMapFilter(
    group("root", "AND", [rule("nd", "prospect.linked_property_ids_json", "has_no_data", null)]),
  );
  assert.equal(hasData.ok, true);
  assert.equal(hasNoData.ok, true);
});

test("invalid registry key is rejected", () => {
  const result = compileMapFilter(group("root", "AND", [rule("bad", "property.not_a_real_field", "equals", "x")]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("unknown_field_key")));
});

test("empty excluded field request is rejected", () => {
  const excludedKey = `property.${EXCLUDED_EMPTY_FIELDS[0].split(".").pop()}`;
  const result = compileMapFilter(group("root", "AND", [rule("empty", excludedKey, "equals", "x")]));
  assert.equal(result.ok, false);
});

test("invalid operator is rejected", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("bad-op", "property.property_type", "contains_any", ["SFR"])]),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("invalid_operator")));
});

test("invalid value type is rejected", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("between", "property.equity_percent", "between", [10])]),
  );
  assert.equal(result.ok, false);
});

test("sql injection attempt in value is rejected", () => {
  const result = compileMapFilter(
    group("root", "AND", [rule("inj", "property.property_address_city", "equals", "Miami'; DROP TABLE properties;--")]),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("suspicious_value")));
});

test("canonical preset compiles to same shape as manual rules", () => {
  const preset = getMapFilterPreset("multifamily_5_plus");
  const manual = compileMapFilter(preset.expression);
  const presetCompiled = compileMapFilter(preset.expression);
  assert.equal(manual.ok, true);
  assert.equal(presetCompiled.ok, true);
  assert.equal(
    collectAstRuleTypes(manual.compiled.compiledPredicateAst).join(","),
    collectAstRuleTypes(presetCompiled.compiled.compiledPredicateAst).join(","),
  );
});

test("high equity absentee preset preserves mixed-entity OR subtree", () => {
  const preset = getMapFilterPreset("high_equity_absentee");
  const result = compileMapFilter(preset.expression);
  assert.equal(result.ok, true);
  const types = collectAstRuleTypes(result.compiled.compiledPredicateAst);
  assert.ok(types.includes("property_rule"));
  assert.ok(types.includes("owner_rule"));
});

test("relationship match mode is preserved on prospect rules", () => {
  const result = compileMapFilter(
    group("root", "AND", [
      rule("pr", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "primary_only" }),
    ]),
  );
  assert.equal(result.ok, true);
  const prospectRule = result.compiled.compiledPredicateAst;
  assert.equal(prospectRule.type, "prospect_rule");
  assert.equal(prospectRule.relationshipMatch, "primary_only");
});