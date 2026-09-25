import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalPropertyGroupOf,
  isTemplateCompatibleWithProperty,
  filterTemplatesForProperty,
  templateAssetRequirement,
} from "@/lib/domain/templates/template-asset-compatibility.js";
import { evaluateTemplateAssetGuard } from "@/lib/domain/queue/template-asset-guard.js";

// Production templates, 2026-09-25 (bodies abbreviated, wording preserved).
const T = {
  storage: { template_id: "840910", property_type_scope: "Self-Storage", use_case: "ownership_check", template_body: "Hi {first_name}, this is {agent_name}. Quick question, are you still the owner of the self-storage facility at {property_address}?" },
  retail: { template_id: "840912", property_type_scope: "Strip Center / Retail", use_case: "ownership_check", template_body: "Hi {first_name}, this is {agent_name}. Are you the owner of the retail center at {property_address}?" },
  commercial: { template_id: "840914", property_type_scope: "Commercial (Other)", use_case: "ownership_check", template_body: "Hi {first_name}, this is {agent_name}. Quick question, do you still own the commercial property at {property_address}?" },
  sfrOwnership: { template_id: "840900", property_type_scope: "single_family,residential", stage_code: "S1", use_case: "ownership_check", template_body: "Hi {{seller_first_name}}, this is {{agent_name}}, a local investor in {{city}}. Wanted to reach out about {{property_address}}." },
  anyResidential: { template_id: "lc-1", property_type_scope: "Any Residential", use_case: "ownership_check", template_body: "Hola {{seller_first_name}}, soy {{agent_name}}. ¿Sigue siendo usted el dueño de {{property_address}}?" },
  fivePlus: { template_id: "5p", property_type_scope: "5+ Units", template_body: "If the numbers made sense, would you look at an offer on the building?" },
  mfUnits: { template_id: "1185", property_type_scope: "Landlord / Multifamily", stage_code: "MF2", template_body: "What's current occupancy on {{property_address}}, how many units are filled today?" },
  duplexNamed: { template_id: "dx", property_type_scope: "Duplex", template_body: "Hi {{seller_first_name}}, I buy duplex properties in {{city}}. Still own {{property_address}}?" },
  duplexGeneric: { template_id: "dxg", property_type_scope: "Duplex", template_body: "Hi {{seller_first_name}}, still own {{property_address}}?" },
  tenantsOk: { template_id: "1181", property_type_scope: "Landlord / Multifamily", stage_code: "S6C", template_body: "No issue there, occupied properties are normal for me. If the number works, we can still move forward." },
};

const P = {
  sfr: { property_type: "Single Family", property_class: "Residential", units_count: 1 },
  sfrLaunchSnapshot: { canonical_property_group: "Residential", property_type: "Single Family" },
  apartment8: { property_type: "Apartment", property_class: "Residential", units_count: 8 },
  multi2: { property_type: "Multi-Family", property_class: "Residential", units_count: 2 },
  storage: { property_type: "Other", property_class: "Commercial", asset_class: "Commercial", asset_subclass: "Storage Facility", is_self_storage: true },
  retail: { property_type: "Other", property_class: "Commercial", asset_class: "Commercial", asset_subclass: "Strip Center / Retail" },
  commercialOther: { property_type: "Other", property_class: "Commercial" },
  land: { property_type: "Vacant Land", property_class: "Vacant" },
};

const ok = (template, property) => isTemplateCompatibleWithProperty({ template, property }).compatible;

test("the canonical group comes from the specific classification, not a class label", () => {
  assert.equal(canonicalPropertyGroupOf(P.sfr), "sfr");
  // the launch path's snapshot: a class LABEL first, the specific type second
  assert.equal(canonicalPropertyGroupOf(P.sfrLaunchSnapshot), "sfr");
  assert.equal(canonicalPropertyGroupOf(P.apartment8), "small_multifamily");
  assert.equal(canonicalPropertyGroupOf(P.multi2), "duplex");
  assert.equal(canonicalPropertyGroupOf(P.storage), "self_storage");
  assert.equal(canonicalPropertyGroupOf(P.retail), "retail");
  assert.equal(canonicalPropertyGroupOf(P.commercialOther), "other_commercial");
  assert.equal(canonicalPropertyGroupOf(P.land), "land");
  assert.equal(canonicalPropertyGroupOf({ property_class: "Residential" }), "residential");
  assert.equal(canonicalPropertyGroupOf({}), "unknown");
});

test("a single-family owner never receives storage, retail or commercial language", () => {
  for (const t of [T.storage, T.retail, T.commercial]) {
    assert.equal(ok(t, P.sfr), false, t.template_id);
    assert.equal(ok(t, P.sfrLaunchSnapshot), false, `${t.template_id} via launch snapshot`);
  }
  assert.equal(ok(T.sfrOwnership, P.sfr), true);
  assert.equal(ok(T.anyResidential, P.sfr), true);
});

test("a multifamily owner never receives storage or retail language", () => {
  for (const t of [T.storage, T.retail, T.commercial]) assert.equal(ok(t, P.apartment8), false, t.template_id);
  assert.equal(ok(T.fivePlus, P.apartment8), true);
  assert.equal(ok(T.mfUnits, P.apartment8), true);
});

test("a storage owner gets storage language and nothing residential", () => {
  const houseLanguage = { template_id: "h", property_type_scope: "Any Residential", template_body: "Would you consider an offer on your house at {{property_address}}?" };
  assert.equal(ok(T.storage, P.storage), true);
  assert.equal(ok(T.commercial, P.storage), true);
  assert.equal(ok(T.retail, P.storage), false);
  assert.equal(ok(houseLanguage, P.storage), false);
  assert.equal(ok(houseLanguage, P.land), false);
  assert.equal(ok(houseLanguage, P.sfr), true);
  // an asset-neutral ownership question is true of any property
  assert.equal(ok(T.anyResidential, P.storage), true);
  assert.equal(ok(T.sfrOwnership, P.land), true);
  // an unconfirmed commercial property is not assumed to be storage
  assert.equal(ok(T.storage, P.commercialOther), false);
  assert.equal(ok(T.commercial, P.commercialOther), true);
});

test("unit language only reaches properties that have units", () => {
  assert.equal(ok(T.fivePlus, P.sfr), false);
  assert.equal(ok(T.mfUnits, P.sfr), false);
  assert.equal(ok(T.duplexNamed, P.sfr), false);
  assert.equal(ok(T.duplexNamed, P.multi2), true);
  assert.equal(ok(T.duplexNamed, P.apartment8), false);
  // scope says Duplex but the words are generic: harmless to a house
  assert.equal(ok(T.duplexGeneric, P.sfr), true);
  // tenants / occupancy are not unit language — a rented house has both
  assert.equal(ok(T.tenantsOk, P.sfr), true);
});

test("a unit designator in the address is not multi-unit language", () => {
  // the one false positive over 600 delivered production messages
  const rendered = { template_body: "Hi Ryan, this is Scott. Do you still own 4157 Pillsbury Ave S Unit B? I'm reaching out about it." };
  assert.equal(ok(rendered, P.sfr), true);
  assert.equal(ok({ template_body: "Still own 12 Oak St Apt 4?" }, P.sfr), true);
  assert.equal(ok({ template_body: "Still own 9 Elm Ave #12?" }, P.sfr), true);
  // real unit language still counts
  assert.equal(ok({ template_body: "How many units are occupied at 9 Elm Ave Unit 3?" }, P.sfr), false);
  assert.equal(ok({ template_body: "What does each unit rent for, roughly per unit?" }, P.sfr), false);
});

test("the words are judged even when the metadata lies", () => {
  const mislabelled = { template_id: "x", property_type_scope: "Any Residential", template_body: "Are you the owner of the self-storage facility at {{property_address}}?" };
  assert.equal(templateAssetRequirement(mislabelled).kind, "commercial");
  assert.equal(ok(mislabelled, P.sfr), false);
});

test("eligibility filters BEFORE ranking: a pool of mixed templates keeps only compatible ones", () => {
  const { kept, rejected } = filterTemplatesForProperty(
    [T.storage, T.sfrOwnership, T.retail, T.anyResidential, T.commercial, T.fivePlus],
    { property: P.sfrLaunchSnapshot },
  );
  assert.deepEqual(kept.map((t) => t.template_id).sort(), ["840900", "lc-1"]);
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((r) => r.reason && r.template_id));
});

// ── The dispatch boundary ───────────────────────────────────────────────
function fakeSupabase({ properties = {}, templates = {} } = {}) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        maybeSingle() {
          const src = table === "properties" ? properties[filters.property_id] : templates[filters.template_id];
          return Promise.resolve({ data: src ?? null, error: null });
        },
      };
      return chain;
    },
  };
}

test("dispatch blocks the production case: a storage body queued to a single-family owner", async () => {
  const supabase = fakeSupabase({ properties: { "273519253": P.sfr }, templates: { "840910": T.storage } });
  const verdict = await evaluateTemplateAssetGuard({
    supabase,
    queue_row: { property_id: "273519253", selected_template_id: "840910", property_type: "Single Family" },
    body: "Hi Ebony, this is Alex. Quick question, are you still the owner of the self-storage facility at 12 Elm St?",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.property_group, "sfr");
  assert.match(verdict.reason, /commercial_template_self_storage_on_sfr_property/);
});

test("dispatch judges the rendered body even when the template id is unknown (local/deferred/rotated)", async () => {
  const supabase = fakeSupabase({ properties: { p1: P.sfr } });
  const blocked = await evaluateTemplateAssetGuard({
    supabase,
    queue_row: { property_id: "p1", template_id: "lc-ownership-check-en-9" },
    body: "Are you the owner of the retail center at 5 Main St?",
  });
  assert.equal(blocked.allowed, false);
  const allowed = await evaluateTemplateAssetGuard({
    supabase,
    queue_row: { property_id: "p1", template_id: "lc-ownership-check-en-9" },
    body: "Hi Ann, this is Alex. Do you still own 5 Main St?",
  });
  assert.equal(allowed.allowed, true);
});

test("dispatch falls back to the row's own property type when the property record is unavailable", async () => {
  const verdict = await evaluateTemplateAssetGuard({
    supabase: fakeSupabase(),
    queue_row: { property_id: "missing", property_type: "Single Family" },
    body: "Do you still own the commercial property at 9 Oak Ave?",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.property_group, "sfr");
});

test("dispatch lets a compatible pair through", async () => {
  const supabase = fakeSupabase({ properties: { s1: P.storage }, templates: { "840910": T.storage } });
  const verdict = await evaluateTemplateAssetGuard({
    supabase,
    queue_row: { property_id: "s1", selected_template_id: "840910" },
    body: "Hi Sam, are you still the owner of the self-storage facility at 1 Depot Rd?",
  });
  assert.equal(verdict.allowed, true);
});
