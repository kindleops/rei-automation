import test from "node:test";
import assert from "node:assert/strict";

import { TABLE_ROW_BASELINES } from "../../src/lib/domain/map-filters/active-field-registry-source.js";
import { compileMapFilter } from "../../src/lib/domain/map-filters/map-filter-compiler.js";
import {
  buildContactedContactExpression,
  buildContactedTouchSql,
  buildUncontactedContactExpression,
  buildUncontactedTouchSql,
} from "../../src/lib/domain/map-filters/contact-status-semantics.js";
import { getMapFilterPreset } from "../../src/lib/domain/map-filters/map-filter-presets.js";
import { MAP_FILTER_PHONE_LINKS_TABLE } from "../../src/lib/domain/map-filters/map-filter-phone-links.js";
import { MAP_FILTER_PROSPECT_LINKS_TABLE } from "../../src/lib/domain/map-filters/map-filter-prospect-links.js";
import {
  buildMatchingPropertiesCte,
  buildPropertyEligibilitySql,
} from "../../src/lib/domain/map-filters/map-filter-predicate-sql.js";

const EMPTY_EXPRESSION = {
  id: "root",
  type: "group",
  combinator: "AND",
  negated: false,
  enabled: true,
  children: [],
};

function compileSql(expression) {
  const compiled = compileMapFilter(expression);
  assert.equal(compiled.ok, true);
  return buildPropertyEligibilitySql(compiled.compiled.compiledPredicateAst, compiled.compiled.params);
}

test("1. no filters compiles to TRUE and full-property CTE without geo gate", () => {
  const { sql } = compileSql(EMPTY_EXPRESSION);
  assert.equal(sql, "TRUE");

  const countCte = buildMatchingPropertiesCte(sql, null, 0, { requireGeo: false });
  assert.match(countCte.sql, /FROM public\.properties p/i);
  assert.doesNotMatch(countCte.sql, /latitude IS NOT NULL/i);

  const mapCte = buildMatchingPropertiesCte(sql, null, 0, { requireGeo: true });
  assert.match(mapCte.sql, /latitude IS NOT NULL/i);
});

test("2. empty predicate does not reference prospect or phone bridges", () => {
  const { sql } = compileSql(EMPTY_EXPRESSION);
  assert.doesNotMatch(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.doesNotMatch(sql, new RegExp(MAP_FILTER_PHONE_LINKS_TABLE));
  assert.doesNotMatch(sql, /seller_work_items/i);
});

test("3. uncontacted preset reads the campaign graph touch truth, not contact_status", () => {
  const { sql, params } = compileSql(buildUncontactedContactExpression());
  assert.match(sql, /^NOT EXISTS/);
  assert.match(sql, /campaign_target_graph/);
  assert.match(sql, /never_contacted IS FALSE/);
  assert.doesNotMatch(sql, /contact_status/);
  assert.deepEqual(params, []);
});

test("4. contacted preset = a graph row with never_contacted false", () => {
  const { sql } = compileSql(buildContactedContactExpression());
  assert.match(sql, /^EXISTS/);
  assert.match(sql, /tg\.property_id = p\.property_id/);
  assert.match(sql, /never_contacted IS FALSE/);
  assert.doesNotMatch(sql, /contact_status/);
});

test("5. prospect SMS eligible only applies with explicit prospect rule", () => {
  const { sql } = compileSql(
    getMapFilterPreset("sms_eligible").expression,
  );
  assert.match(sql, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
  assert.match(sql, /EXISTS/i);

  const empty = compileSql(EMPTY_EXPRESSION).sql;
  assert.doesNotMatch(empty, new RegExp(MAP_FILTER_PROSPECT_LINKS_TABLE));
});

test("6. has phone preset uses phone bridge not prospect has_phone", () => {
  const preset = getMapFilterPreset("has_phone");
  assert.equal(preset.entity, "phone");
  const { sql } = compileSql(preset.expression);
  assert.match(sql, new RegExp(MAP_FILTER_PHONE_LINKS_TABLE));
  assert.doesNotMatch(sql, /prospect\.has_phone/i);
});

test("7. uncontacted is the exact complement of contacted, so the buckets partition the universe", () => {
  assert.equal(buildUncontactedTouchSql("p"), `NOT ${buildContactedTouchSql("p")}`);
  assert.match(buildContactedTouchSql("x"), /tg\.property_id = x\.property_id/);
});

test("8. uncontacted and contacted presets exist as system presets", () => {
  assert.ok(getMapFilterPreset("uncontacted"));
  assert.ok(getMapFilterPreset("contacted"));
  assert.ok(getMapFilterPreset("all_properties"));
});

test("9. property table baseline remains 124046", () => {
  assert.equal(TABLE_ROW_BASELINES.properties, 124046);
});