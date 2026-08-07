import test from "node:test";
import assert from "node:assert/strict";
import {
  PROPERTY_COMMUNICATION_CLASSES,
  PROPERTY_COMMUNICATION_CLASS_VALUES,
  normalizeUnitsCount,
  parseUnitsCountFromLabel,
  communicationClassFromUnits,
  communicationClassFromLabel,
  describePropertyCommunicationClass,
  resolvePropertyCommunicationClass,
  communicationClassToPropertyTypeScope,
  communicationClassFromPropertyTypeScope,
  communicationClassToCanonicalPropertyGroup,
  templateWordingViolationsForClass,
  isTemplateAllowedForCommunicationClass,
  forbiddenTemplateFieldsForClass,
  renderedBodyViolationsForClass,
  templateUnitScopedFieldNames,
} from "../../src/lib/domain/properties/property-communication-class.js";

// ─── Units count is authoritative ────────────────────────────────────────────

test("communication class: units count is authoritative for every class", () => {
  assert.equal(resolvePropertyCommunicationClass({ units_count: 1 }), "single_family");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 2 }), "duplex");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 3 }), "triplex");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 4 }), "fourplex");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 5 }), "multifamily_5_plus");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 7 }), "multifamily_5_plus");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 48 }), "multifamily_5_plus");
});

test("communication class: units count overrides a conflicting label", () => {
  // 7-unit property labeled just "Multifamily" — the live-defect scenario.
  assert.equal(
    resolvePropertyCommunicationClass({ units_count: 7, property_type: "Multifamily" }),
    "multifamily_5_plus"
  );
  // Units win even against a specific label.
  assert.equal(
    resolvePropertyCommunicationClass({ units_count: 2, property_type: "Single Family" }),
    "duplex"
  );
  assert.equal(
    resolvePropertyCommunicationClass({ units_count: 1, property_type: "Duplex" }),
    "single_family"
  );
});

test("communication class: numeric strings are accepted, invalid units ignored", () => {
  assert.equal(resolvePropertyCommunicationClass({ units_count: "3" }), "triplex");
  assert.equal(resolvePropertyCommunicationClass({ units_count: 0 }), "unknown");
  assert.equal(resolvePropertyCommunicationClass({ units_count: -2 }), "unknown");
  assert.equal(resolvePropertyCommunicationClass({ units_count: "abc" }), "unknown");
  assert.equal(normalizeUnitsCount("7"), 7);
  assert.equal(normalizeUnitsCount(0), null);
  assert.equal(normalizeUnitsCount(null), null);
});

// ─── Label fallback ──────────────────────────────────────────────────────────

test("communication class: label fallback for the specific classes", () => {
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Duplex" }), "duplex");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Triplex" }), "triplex");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Fourplex" }), "fourplex");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Quadplex" }), "fourplex");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Single Family" }), "single_family");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "SFR" }), "single_family");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Condo" }), "single_family");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "6 Units" }), "multifamily_5_plus");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "5+ Units" }), "multifamily_5_plus");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "2 Units" }), "duplex");
});

test("communication class: feeder group vocabulary is recognized as labels", () => {
  assert.equal(
    resolvePropertyCommunicationClass({ normalized_asset_class: "small_multifamily" }),
    "multifamily_5_plus"
  );
  assert.equal(
    resolvePropertyCommunicationClass({ normalized_asset_class: "multifamily_5_plus" }),
    "multifamily_5_plus"
  );
  assert.equal(resolvePropertyCommunicationClass({ normalized_asset_class: "sfr" }), "single_family");
});

test("communication class: generic multifamily labels resolve to unknown, never a guess", () => {
  for (const label of ["Multifamily", "Multi-Family", "Multifamily 2-4", "Apartment"]) {
    const described = describePropertyCommunicationClass({ property_type: label });
    assert.equal(described.communication_class, "unknown", label);
    assert.equal(described.multifamily_indicated, true, label);
  }
});

test("communication class: absent signals resolve to unknown", () => {
  assert.equal(resolvePropertyCommunicationClass({}), "unknown");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "" }), "unknown");
  assert.equal(resolvePropertyCommunicationClass({ property_type: "Retail Strip" }), "unknown");
  const described = describePropertyCommunicationClass({});
  assert.equal(described.source, "none");
  assert.equal(described.multifamily_indicated, false);
});

test("communication class: conflicting labels (no units) resolve to unknown", () => {
  const described = describePropertyCommunicationClass({
    property_type: "Duplex",
    property_class: "Single Family",
  });
  assert.equal(described.communication_class, "unknown");
  assert.equal(described.conflicting_labels, true);
});

test("communication class: agreeing labels resolve to the shared class", () => {
  assert.equal(
    resolvePropertyCommunicationClass({ property_type: "Duplex", property_class: "duplex" }),
    "duplex"
  );
});

test("parseUnitsCountFromLabel consolidates the property_scope.js patterns", () => {
  assert.equal(parseUnitsCountFromLabel("Duplex"), 2);
  assert.equal(parseUnitsCountFromLabel("3 units"), 3);
  assert.equal(parseUnitsCountFromLabel("Fourplex"), 4);
  assert.equal(parseUnitsCountFromLabel("12 Units"), 12);
  assert.equal(parseUnitsCountFromLabel("5+ Units"), 5);
  assert.equal(parseUnitsCountFromLabel("5 plus units"), 5);
  assert.equal(parseUnitsCountFromLabel("Single Family"), null);
  assert.equal(communicationClassFromUnits(null), null);
  assert.equal(communicationClassFromLabel("Office"), null);
});

// ─── Scope mapping (template-side vocabulary) ────────────────────────────────

test("communicationClassToPropertyTypeScope maps into the template scope vocabulary", () => {
  assert.equal(communicationClassToPropertyTypeScope("single_family"), "Residential");
  assert.equal(communicationClassToPropertyTypeScope("duplex"), "Duplex");
  assert.equal(communicationClassToPropertyTypeScope("triplex"), "Triplex");
  assert.equal(communicationClassToPropertyTypeScope("fourplex"), "Fourplex");
  assert.equal(communicationClassToPropertyTypeScope("multifamily_5_plus"), "5+ Units");
  assert.equal(communicationClassToPropertyTypeScope("unknown"), "Any Residential");
});

test("communicationClassFromPropertyTypeScope derives class claims, null for non-claims", () => {
  assert.equal(communicationClassFromPropertyTypeScope("Residential"), "single_family");
  assert.equal(communicationClassFromPropertyTypeScope("Any Residential"), "unknown");
  assert.equal(communicationClassFromPropertyTypeScope("Duplex"), "duplex");
  assert.equal(communicationClassFromPropertyTypeScope("5+ Units"), "multifamily_5_plus");
  assert.equal(communicationClassFromPropertyTypeScope("Landlord / Multifamily"), null);
  assert.equal(communicationClassFromPropertyTypeScope("Probate / Trust"), null);
  assert.equal(communicationClassFromPropertyTypeScope("Corporate / Institutional"), null);
  assert.equal(communicationClassFromPropertyTypeScope(null), null);
});

test("communicationClassToCanonicalPropertyGroup preserves feeder vocabulary", () => {
  assert.equal(communicationClassToCanonicalPropertyGroup("single_family"), "sfr");
  assert.equal(communicationClassToCanonicalPropertyGroup("duplex"), "duplex");
  assert.equal(communicationClassToCanonicalPropertyGroup("multifamily_5_plus", 7), "small_multifamily");
  assert.equal(communicationClassToCanonicalPropertyGroup("multifamily_5_plus", 11), "multifamily_5_plus");
  assert.equal(communicationClassToCanonicalPropertyGroup("multifamily_5_plus", null), "multifamily_5_plus");
  assert.equal(communicationClassToCanonicalPropertyGroup("unknown"), null);
});

// ─── Hard wording / placeholder guarantees ───────────────────────────────────

test("hard guard: unit-worded template is unselectable for single_family and unknown", () => {
  const unitTemplate = {
    template_body: "Hi {{seller_first_name}}, is the duplex at {{property_address}} still yours?",
  };
  for (const cls of ["single_family", "unknown"]) {
    const verdict = isTemplateAllowedForCommunicationClass(unitTemplate, cls);
    assert.equal(verdict.allowed, false, cls);
    assert.ok(verdict.violations.includes("unit_wording_forbidden:duplex"), cls);
  }
  // 'units' as a word is also forbidden — including the question form the old
  // feeder guard ("units?") used to exempt.
  const unitsQuestion = { template_body: "How many units? Just checking on the property." };
  assert.equal(isTemplateAllowedForCommunicationClass(unitsQuestion, "single_family").allowed, false);
  assert.equal(isTemplateAllowedForCommunicationClass(unitsQuestion, "unknown").allowed, false);
});

test("hard guard: unit placeholders are unselectable for single_family and unknown", () => {
  const placeholderTemplate = {
    template_body: "Hi {{seller_first_name}}, what are the rents at {{property_address}}? {{monthly_rents}}",
  };
  const verdict = isTemplateAllowedForCommunicationClass(placeholderTemplate, "single_family");
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.violations.includes("unit_placeholder_forbidden:monthly_rents"));

  const aliasTemplate = {
    template_body: "Hi {{seller_first_name}}, quick one about {{property_address}}.",
    variables: ["units", "occupancy"],
  };
  const aliasVerdict = isTemplateAllowedForCommunicationClass(aliasTemplate, "unknown");
  assert.equal(aliasVerdict.allowed, false);
  assert.ok(aliasVerdict.violations.includes("unit_placeholder_forbidden:unit_count"));
  assert.ok(aliasVerdict.violations.includes("unit_placeholder_forbidden:occupied_units"));
});

test("hard guard: duplex/triplex/fourplex may use their own wording, not each other's", () => {
  const duplexTemplate = { template_body: "Is your duplex with both units still rented?" };
  assert.equal(isTemplateAllowedForCommunicationClass(duplexTemplate, "duplex").allowed, true);
  assert.equal(isTemplateAllowedForCommunicationClass(duplexTemplate, "triplex").allowed, false);
  assert.equal(isTemplateAllowedForCommunicationClass(duplexTemplate, "fourplex").allowed, false);
  assert.equal(isTemplateAllowedForCommunicationClass(duplexTemplate, "single_family").allowed, false);
  assert.equal(isTemplateAllowedForCommunicationClass(duplexTemplate, "unknown").allowed, false);

  const triplexTemplate = { template_body: "Your triplex — are all 3 units occupied?" };
  assert.equal(isTemplateAllowedForCommunicationClass(triplexTemplate, "triplex").allowed, true);
  assert.equal(isTemplateAllowedForCommunicationClass(triplexTemplate, "duplex").allowed, false);
});

test("hard guard: 5+ gets building/units language but never plex wording", () => {
  const buildingTemplate = {
    template_body: "How many of the {{unit_count}} units in your building are occupied?",
    variables: ["unit_count", "occupied_units"],
  };
  assert.equal(isTemplateAllowedForCommunicationClass(buildingTemplate, "multifamily_5_plus").allowed, true);
  assert.equal(isTemplateAllowedForCommunicationClass(buildingTemplate, "single_family").allowed, false);
  assert.equal(isTemplateAllowedForCommunicationClass(buildingTemplate, "unknown").allowed, false);

  const plexTemplate = { template_body: "Is the fourplex still yours?" };
  assert.equal(isTemplateAllowedForCommunicationClass(plexTemplate, "multifamily_5_plus").allowed, false);
});

test("hard guard: property-neutral template is allowed for every class", () => {
  const neutralTemplate = {
    template_body: "Hi {{seller_first_name}}, are you the owner of {{property_address}}?",
  };
  for (const cls of PROPERTY_COMMUNICATION_CLASS_VALUES) {
    assert.equal(isTemplateAllowedForCommunicationClass(neutralTemplate, cls).allowed, true, cls);
  }
});

test("hard guard: null/empty class means no class claim — no violations invented", () => {
  const unitTemplate = { template_body: "Is the duplex still yours?" };
  assert.deepEqual(templateWordingViolationsForClass(unitTemplate, null), []);
  assert.deepEqual(templateWordingViolationsForClass(unitTemplate, ""), []);
});

test("hard guard: Spanish unit wording is caught (unidades, dúplex)", () => {
  const spanishTemplate = {
    template_body: "Hola {{seller_first_name}}, ¿el dúplex sigue siendo suyo? ¿Cuántas unidades?",
  };
  const verdict = isTemplateAllowedForCommunicationClass(spanishTemplate, "single_family");
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.violations.includes("unit_wording_forbidden:duplex"));
  assert.ok(verdict.violations.includes("unit_wording_forbidden:units"));
});

test("render-time assert: rendered bodies are checked with the same rules", () => {
  assert.ok(
    renderedBodyViolationsForClass("Your duplex at 12 Main St", "single_family").length > 0
  );
  assert.deepEqual(renderedBodyViolationsForClass("Your home at 12 Main St", "single_family"), []);
  assert.ok(renderedBodyViolationsForClass("all 4 units rented", "unknown").length > 0);
  assert.deepEqual(
    renderedBodyViolationsForClass("How many of the 12 units are rented?", "multifamily_5_plus"),
    []
  );
  // Placeholder tokens do not trip the units-word check ({{unit_count}} is a
  // placeholder name, not wording).
  assert.deepEqual(
    renderedBodyViolationsForClass("Checking {{unit_count}} now", "single_family"),
    []
  );
});

test("forbiddenTemplateFieldsForClass: unit placeholders forbidden for single_family/unknown only", () => {
  assert.deepEqual(forbiddenTemplateFieldsForClass("single_family"), [
    "unit_count",
    "occupied_units",
    "monthly_rents",
    "monthly_expenses",
  ]);
  assert.deepEqual(forbiddenTemplateFieldsForClass("unknown"), [
    "unit_count",
    "occupied_units",
    "monthly_rents",
    "monthly_expenses",
  ]);
  assert.deepEqual(forbiddenTemplateFieldsForClass("duplex"), []);
  assert.deepEqual(forbiddenTemplateFieldsForClass("multifamily_5_plus"), []);
});

test("templateUnitScopedFieldNames reads declared variables and body placeholders", () => {
  assert.deepEqual(
    templateUnitScopedFieldNames({
      template_body: "Rents: {{monthly_rents}}, expenses: {monthly_expenses}",
      variables: [{ name: "unit_count" }, "seller_first_name"],
    }).sort(),
    ["monthly_expenses", "monthly_rents", "unit_count"]
  );
  assert.deepEqual(templateUnitScopedFieldNames({ template_body: "No units placeholders here?" }), []);
});

test("class constants are the six canonical values", () => {
  assert.deepEqual(
    [...PROPERTY_COMMUNICATION_CLASS_VALUES].sort(),
    ["duplex", "fourplex", "multifamily_5_plus", "single_family", "triplex", "unknown"]
  );
  assert.equal(PROPERTY_COMMUNICATION_CLASSES.UNKNOWN, "unknown");
});
