import test from "node:test";
import assert from "node:assert/strict";

import {
  getClientOperatorMapFilterRegistry,
  getOperatorMapFilterFields,
  isOperatorLaunchField,
  OPERATOR_FILTER_DEFINITIONS,
} from "../../src/lib/domain/map-filters/operator-filter-catalog.js";

const RAW_ID_KEYS = [
  "property.property_id",
  "property.property_export_id",
  "property.master_owner_id",
  "property.apn_parcel_id",
  "prospect.prospect_id",
  "prospect.canonical_prospect_id",
  "prospect.linked_property_ids_json",
  "master_owner.master_owner_id",
  "master_owner.joined_prospect_ids_json",
  "master_owner.joined_phone_ids_json",
];

const INTERNAL_OPS_KEYS = [
  "property.cash_offer",
  "property.ai_score",
  "property.follow_up_cadence",
  "property.best_channel",
  "prospect.agent_persona",
  "prospect.raw_contact_score",
  "master_owner.agent_persona",
];

test("operator catalog is smaller than full registry and excludes raw IDs", () => {
  const operator = getClientOperatorMapFilterRegistry();
  assert.equal(operator.catalog, "operator");
  assert.ok(operator.catalogFieldCount >= 40, `expected >= 40 operator fields, got ${operator.catalogFieldCount}`);
  assert.ok(operator.catalogFieldCount < operator.registryFieldCount);

  const keys = new Set(operator.fields.map((field) => field.key));
  for (const blocked of [...RAW_ID_KEYS, ...INTERNAL_OPS_KEYS]) {
    assert.ok(!keys.has(blocked), `operator catalog must not expose ${blocked}`);
  }
});

test("every operator catalog entry maps to a live registry field with UI metadata", () => {
  const fields = getOperatorMapFilterFields();
  assert.equal(fields.length, OPERATOR_FILTER_DEFINITIONS.length);

  for (const field of fields) {
    assert.ok(isOperatorLaunchField(field.key), field.key);
    assert.ok(field.uiKey, `${field.key} missing uiKey`);
    assert.ok(field.controlType, `${field.key} missing controlType`);
    assert.ok(field.defaultOperator, `${field.key} missing defaultOperator`);
    assert.equal(field.launchVisible, true);
  }
});

test("operator catalog search only searches curated fields", () => {
  const sms = getOperatorMapFilterFields({ query: "sms eligible" });
  assert.ok(sms.some((field) => field.key === "prospect.sms_eligible"));
  assert.ok(!sms.some((field) => field.key === "property.property_id"));
});