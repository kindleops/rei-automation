import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRegistryIntegrity,
  getActiveMapFilterFields,
  getClientMapFilterRegistry,
  getRegistryField,
  resolveRegistryFieldKey,
  sanitizeFieldForClient,
  validateRegistryFieldOperator,
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  FIELD_ALIASES,
} from "../../src/lib/domain/map-filters/active-field-registry.js";
import { getMapFilterPresets, validatePresetCatalog } from "../../src/lib/domain/map-filters/map-filter-presets.js";
import { REMOVED_PLACEHOLDER_PRESETS } from "../../src/lib/domain/map-filters/removed-placeholders.js";
import { MAP_FILTER_COUNT_SEMANTICS } from "../../src/lib/domain/map-filters/count-semantics.js";
import { RELATIONSHIP_MATCH_SEMANTICS } from "../../src/lib/domain/map-filters/relationship-semantics.js";
import { buildFilterTokenDigest, exposeFilterTokenDigest } from "../../src/lib/domain/map-filters/filter-scope.js";

test("phone entity fields are registered", () => {
  const phoneFields = getActiveMapFilterFields().filter((f) => f.entity === "phone");
  assert.ok(phoneFields.length >= 20, `expected phone fields, got ${phoneFields.length}`);
  assert.ok(phoneFields.some((f) => f.key === "phone.phone_type"));
  assert.ok(phoneFields.some((f) => f.key === "phone.activity_status"));
  assert.ok(!phoneFields.some((f) => f.key === "phone.sms_eligible"));
});

test("registry integrity passes with no empty or sensitive exposures", () => {
  const errors = assertRegistryIntegrity();
  assert.deepEqual(errors, [], `integrity errors: ${errors.join(", ")}`);
});

test("every exposed field has positive population", () => {
  for (const field of getActiveMapFilterFields()) {
    assert.ok(field.populatedRows > 0, `${field.key} has zero population`);
    assert.equal(field.safeToExpose, true);
  }
});

test("empty columns from spec are excluded from registry", () => {
  const keys = new Set(getActiveMapFilterFields().map((f) => f.key));
  for (const excluded of EXCLUDED_EMPTY_FIELDS) {
    const short = excluded.split(".").pop();
    assert.ok(!keys.has(`property.${short}`), `empty field exposed: property.${short}`);
  }
});

test("sensitive demographic fields are excluded", () => {
  const keys = new Set(getActiveMapFilterFields().map((f) => f.key));
  for (const excluded of EXCLUDED_SENSITIVE_FIELDS) {
    const short = excluded.split(".").pop();
    assert.ok(!keys.has(`prospect.${short}`), `sensitive field exposed: prospect.${short}`);
  }
});

test("every operator is valid for its field data type", () => {
  for (const field of getActiveMapFilterFields()) {
    for (const operator of field.operators) {
      const result = validateRegistryFieldOperator(field.key, operator);
      assert.equal(result.ok, true, `${field.key}.${operator}`);
    }
  }
});

test("JSON fields declare explicit storage shapes", () => {
  for (const field of getActiveMapFilterFields()) {
    if (field.dataType === "json_text_array" || field.dataType === "json_object_array") {
      assert.ok(field.jsonStorageShape, `${field.key} missing jsonStorageShape`);
    }
    if (["phones_json", "emails_json", "owner_locations_json"].includes(field.column)) {
      assert.notEqual(field.jsonStorageShape, "text_array", `${field.key} unsafe text_array shape`);
    }
  }
});

test("aliases resolve to one canonical field", () => {
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    assert.equal(resolveRegistryFieldKey(alias), canonical);
    assert.ok(getRegistryField(canonical), `missing canonical for alias ${alias}`);
    assert.equal(getRegistryField(alias), null, `alias registered as primary key: ${alias}`);
  }
});

test("client registry output contains no internal SQL identifiers", () => {
  const payload = JSON.stringify(getClientMapFilterRegistry());
  assert.ok(!payload.includes("SELECT "), "raw SQL leaked");
  assert.ok(!payload.includes("FROM properties"), "table name leaked");
  assert.ok(!payload.includes('"column"'), "column metadata leaked");
  assert.ok(!payload.includes("jsonCompilerKey"), "compiler key leaked");

  for (const field of getClientMapFilterRegistry().fields) {
    assert.equal(field.table, undefined);
    assert.equal(field.column, undefined);
  }
});

test("sanitizeFieldForClient maps master_owner entity to owner", () => {
  const field = getRegistryField("master_owner.property_count");
  const client = sanitizeFieldForClient(field);
  assert.equal(client.entity, "owner");
});

test("canonical presets reference only registry field keys", () => {
  const errors = validatePresetCatalog((fieldKey) => getRegistryField(fieldKey));
  assert.deepEqual(errors, [], errors.join(", "));
});

test("preset catalog exposes only verified launch quick filters", () => {
  const presetKeys = new Set(getMapFilterPresets().map((p) => p.key));
  const removedKeys = new Set(REMOVED_PLACEHOLDER_PRESETS.map((p) => p.key));

  for (const key of [
    "all_properties",
    "multifamily_2_4",
    "multifamily_5_plus",
    "high_equity",
    "sms_eligible",
    "has_phone",
    "portfolio_owner",
  ]) {
    assert.ok(presetKeys.has(key), `missing verified preset ${key}`);
  }

  for (const blocked of ["tax_delinquent", "active_lien", "vacant", "uncontacted", "contacted"]) {
    assert.ok(!presetKeys.has(blocked), `blocked preset still exposed: ${blocked}`);
  }

  for (const removed of removedKeys) {
    if (removed === "delinquent" || removed === "out_of_state" || removed === "institutional_excl") continue;
    assert.ok(!presetKeys.has(removed), `removed preset still present: ${removed}`);
  }
});

test("count and relationship semantics are documented", () => {
  assert.ok(MAP_FILTER_COUNT_SEMANTICS.matchingProperties.definition.includes("Distinct"));
  assert.ok(MAP_FILTER_COUNT_SEMANTICS.matchingProspects.definition.includes("no prospect-specific predicates"));
  assert.ok(RELATIONSHIP_MATCH_SEMANTICS.all_linked.description.includes("no linked records exist"));
});

test("filter token digest uses scope inputs and exposes 128-bit url token", () => {
  const digest = buildFilterTokenDigest({
    organizationId: "org-1",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-06.1",
    normalizedExpression: { id: "root", type: "group", combinator: "AND", negated: false, enabled: true, children: [] },
  });
  assert.equal(digest.length, 64);
  assert.equal(exposeFilterTokenDigest(digest).length, 32);

  const digestB = buildFilterTokenDigest({
    organizationId: "org-2",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-06.1",
    normalizedExpression: { id: "root", type: "group", combinator: "AND", negated: false, enabled: true, children: [] },
  });
  assert.notEqual(digest, digestB);
});