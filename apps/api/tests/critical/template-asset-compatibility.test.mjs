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
  // genericity is never inferred from copy: a Residential-scoped question,
  // however neutral its words, is not eligible for a storage facility or land
  assert.equal(ok(T.anyResidential, P.storage), false);
  assert.equal(ok(T.sfrOwnership, P.land), false);
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
  // scope says Duplex: duplex-only, even when these words happen to be generic
  assert.equal(ok(T.duplexGeneric, P.sfr), false);
  assert.equal(ok(T.duplexGeneric, P.multi2), true);
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

// ── §8 metadata is the authority; words only narrow ─────────────────────
test("scope metadata decides eligibility; an allowed list can narrow but words never widen", () => {
  const listSaysSfr = { ...T.fivePlus, allowed_property_groups: ["sfr", "duplex", "small_multifamily"] };
  assert.equal(ok(listSaysSfr, P.sfr), false, "a 5+ Units scope never reaches a house, whatever its list says");
  assert.equal(ok(listSaysSfr, P.apartment8), true);
  const residentialNarrowed = { ...T.anyResidential, allowed_property_groups: ["sfr"] };
  assert.equal(ok(residentialNarrowed, P.multi2), false);
  assert.equal(ok(residentialNarrowed, P.sfr), true);
  // prohibited always binds
  assert.equal(ok({ ...T.anyResidential, prohibited_property_groups: ["sfr"] }, P.sfr), false);
  // missing scope → treated as residential, never as commercial (fail conservative)
  assert.equal(ok({ template_id: "n", property_type_scope: null, template_body: "Still own {{property_address}}?" }, P.storage), false);
  assert.equal(ok({ template_id: "n", property_type_scope: null, template_body: "Still own {{property_address}}?" }, P.sfr), true);
  // an unclassified property is treated as a single-family home
  assert.equal(ok(T.storage, {}), false);
  assert.equal(ok(T.anyResidential, {}), true);
});

test("a land label on a property with a structure is not land (classification read, never rewritten)", () => {
  const conflicted = { property_type: "Single Family", asset_class: "Land", asset_subclass: "Vacant Land", building_square_feet: 1450, year_built: 1978, total_bedrooms: 3 };
  assert.equal(canonicalPropertyGroupOf(conflicted), "sfr");
  assert.equal(ok(T.sfrOwnership, conflicted), true);
  assert.equal(ok(T.commercial, conflicted), false);
  assert.equal(conflicted.asset_subclass, "Vacant Land", "the record is not mutated");
  const trueLand = { property_type: "Vacant Land", asset_subclass: "Vacant Land", building_square_feet: 0 };
  assert.equal(canonicalPropertyGroupOf(trueLand), "land");
});

// ── §12/§18 reselection ─────────────────────────────────────────────────
import {
  recoverRenderedValues,
  renderWithValues,
  reselectTemplateForAsset,
  applyAssetReselection,
  ASSET_RESELECTION_REASON,
} from "@/lib/domain/queue/template-asset-reselection.js";

test("the seller's exact identity values are recovered from the rendered body", () => {
  const values = recoverRenderedValues(
    "Hi {first_name}, this is {agent_name}. Quick question, are you still the owner of the self-storage facility at {property_address}?",
    "Hi Jerline, this is Alex. Quick question, are you still the owner of the self-storage facility at 3407 Breckenridge Dr?",
  );
  assert.deepEqual(values, { seller: "Jerline", agent: "Alex", address: "3407 Breckenridge Dr" });
  assert.equal(
    renderWithValues("Hi {{seller_name}}, my name is {{agent_name}}. Came across {{property_address}}, are you still the owner?", values),
    "Hi Jerline, my name is Alex. Came across 3407 Breckenridge Dr, are you still the owner?",
  );
  // a placeholder with no known value fails instead of rendering blank
  assert.equal(renderWithValues("Hi {{seller_name}}, a local investor in {{city}}.", values), null);
  // a body that does not come from the template does not align
  assert.equal(recoverRenderedValues("Hi {first_name}, still own {property_address}?", "Totally different text"), null);
});

function memorySupabase({ properties = {}, templates = [], queue = [] } = {}) {
  const tables = { properties: Object.values(properties), sms_templates: templates, send_queue: queue, v_template_performance: [] };
  const updates = [];
  function builder(table) {
    const filters = [];
    let patch = null;
    const rowsNow = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select() { return chain; },
      eq(col, v) { filters.push((r) => String(r[col] ?? "") === String(v ?? "")); return chain; },
      in(col, vs) { filters.push((r) => vs.map(String).includes(String(r[col]))); return chain; },
      limit() { return chain; },
      update(p) { patch = p; return chain; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      then(resolve, reject) {
        const hit = rowsNow();
        if (patch) { for (const r of hit) Object.assign(r, patch); updates.push({ table, patch, ids: hit.map((r) => r.id) }); }
        return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: builder, updates, tables };
}

const PROD_TEMPLATES = [
  { template_id: "840910", use_case: "ownership_check", language: "English", stage_code: null, property_type_scope: "Self-Storage", allowed_property_groups: ["self_storage"], is_active: true, quarantine_state: "active", template_body: "Hi {first_name}, this is {agent_name}. Quick question, are you still the owner of the self-storage facility at {property_address}?" },
  { template_id: "840914", use_case: "ownership_check", language: "English", stage_code: null, property_type_scope: "Commercial (Other)", allowed_property_groups: ["self_storage", "retail", "other_commercial"], is_active: true, quarantine_state: "active", template_body: "Hi {first_name}, this is {agent_name}. Quick question, do you still own the commercial property at {property_address}?" },
  { template_id: "840901", use_case: "ownership_check", language: "English", stage_code: "S1", property_type_scope: "single_family,residential", is_active: true, quarantine_state: "active", template_body: "Hi {{seller_name}}, my name is {{agent_name}}. Came across {{property_address}}, are you still the owner?" },
  { template_id: "840907", use_case: "ownership_check", language: "Spanish", stage_code: "S1", property_type_scope: "single_family,residential", is_active: true, quarantine_state: "active", template_body: "Hola {{seller_name}}, mi nombre es {{agent_name}}. Vi la propiedad en {{property_address}}, ¿sigues siendo el propietario?" },
  { template_id: "5p-own", use_case: "ownership_check", language: "English", stage_code: "S1", property_type_scope: "5+ Units", is_active: true, quarantine_state: "active", template_body: "Hi {{seller_name}}, do you still own the building at {{property_address}}?" },
  { template_id: "q-own", use_case: "ownership_check", language: "English", stage_code: "S1", property_type_scope: "Any Residential", is_active: true, quarantine_state: "quarantined", template_body: "Hi {{seller_name}}, still own {{property_address}}?" },
  { template_id: "offer", use_case: "offer_reveal_cash", language: "English", stage_code: "S5A", property_type_scope: "Any Residential", is_active: true, quarantine_state: "active", template_body: "I'd be around {{offer_price}} for {{property_address}}." },
];

const BAD_ROW = () => ({
  id: "b6fdd8c9", property_id: "2131004767", property_type: "Single Family", queue_status: "scheduled",
  selected_template_id: "840910", template_id: "840910", use_case_template: "ownership_check", language: "English",
  scheduled_for: "2026-09-25T17:10:00Z", logical_communication_id: "lc-1", dedupe_key: "dk-1", queue_key: "qk-1",
  from_phone_number: "+18325550100", to_phone_number: "+18329284333",
  message_body: "Hi Jerline, this is Alex. Quick question, are you still the owner of the self-storage facility at 3407 Breckenridge Dr?",
  metadata: { campaign_id: "df0671fa", template_snapshot: { template_use_case: "ownership_check", language: "English" } },
});

test("reselection keeps use case, stage and language and only picks asset-eligible copy", async () => {
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.map((t) => ({ ...t })) });
  const r = await reselectTemplateForAsset({ supabase, queue_row: BAD_ROW(), body: BAD_ROW().message_body });
  assert.equal(r.resolved, true);
  assert.equal(r.template_id, "840901", "the only active, eligible English ownership_check for a house");
  assert.equal(r.use_case, "ownership_check");
  assert.equal(r.language, "English");
  assert.equal(r.message_body, "Hi Jerline, my name is Alex. Came across 3407 Breckenridge Dr, are you still the owner?");
  assert.equal(r.previous_template_id, "840910");
});

test("a Spanish conversation is reselected in Spanish, never English", async () => {
  const row = { ...BAD_ROW(), language: "Spanish", selected_template_id: "840910" };
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.map((t) => ({ ...t, language: t.template_id === "840910" ? "Spanish" : t.language })) });
  const r = await reselectTemplateForAsset({ supabase, queue_row: row, body: row.message_body });
  assert.equal(r.resolved, true);
  assert.equal(r.template_id, "840907");
  assert.match(r.message_body, /^Hola Jerline, mi nombre es Alex\. Vi la propiedad en 3407 Breckenridge Dr/);
});

test("no eligible template → unresolved (the dispatch guard then blocks; nothing sends)", async () => {
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.filter((t) => ["840910", "840914", "5p-own", "q-own"].includes(t.template_id)).map((t) => ({ ...t })) });
  const r = await reselectTemplateForAsset({ supabase, queue_row: BAD_ROW(), body: BAD_ROW().message_body });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, "no_asset_eligible_template");
});

test("applying a reselection rewrites only template + body; identity, schedule, sender and keys are preserved", async () => {
  const row = BAD_ROW();
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.map((t) => ({ ...t })), queue: [row] });
  const before = { ...row };
  const r = await reselectTemplateForAsset({ supabase, queue_row: { ...row }, body: row.message_body });
  const applied = await applyAssetReselection({ supabase, queue_row: { ...before }, reselection: r, now: "2026-09-25T08:00:00Z", expectStatus: "scheduled" });
  assert.equal(applied.ok, true);
  const stored = supabase.tables.send_queue[0];
  for (const k of ["id", "property_id", "scheduled_for", "logical_communication_id", "dedupe_key", "queue_key", "from_phone_number", "to_phone_number", "queue_status"]) {
    assert.equal(stored[k], before[k], k);
  }
  assert.equal(stored.selected_template_id, "840901");
  assert.equal(stored.metadata.template_reselection_reason, ASSET_RESELECTION_REASON);
  assert.equal(stored.metadata.template_reselected_from.template_id, "840910");
  assert.equal(stored.metadata.campaign_id, "df0671fa", "existing metadata survives");
  // second application is a no-op: the row no longer carries the bad template
  const again = await applyAssetReselection({ supabase, queue_row: { ...before }, reselection: r, expectStatus: "scheduled" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "reselection_row_changed_concurrently");
});

test("a row that already left 'scheduled' is never rewritten (history is immutable)", async () => {
  const row = { ...BAD_ROW(), queue_status: "sent" };
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.map((t) => ({ ...t })), queue: [row] });
  const r = await reselectTemplateForAsset({ supabase, queue_row: { ...row }, body: row.message_body });
  const applied = await applyAssetReselection({ supabase, queue_row: { ...row }, reselection: r, expectStatus: "scheduled" });
  assert.equal(applied.ok, false);
  assert.equal(supabase.tables.send_queue[0].selected_template_id, "840910");
  assert.match(supabase.tables.send_queue[0].message_body, /self-storage/);
});

test("the reselected body passes the dispatch guard", async () => {
  const supabase = memorySupabase({ properties: { a: { property_id: "2131004767", ...P.sfr } }, templates: PROD_TEMPLATES.map((t) => ({ ...t })) });
  const r = await reselectTemplateForAsset({ supabase, queue_row: BAD_ROW(), body: BAD_ROW().message_body });
  const verdict = await evaluateTemplateAssetGuard({ supabase, queue_row: { ...BAD_ROW(), selected_template_id: r.template_id }, body: r.message_body });
  assert.equal(verdict.allowed, true);
});

test("the feeder's 'other_commercial' default for a missing type is unknown, not commercial", () => {
  assert.equal(canonicalPropertyGroupOf({ canonical_property_group: "other_commercial", property_type: "" }), "unknown");
  assert.equal(ok(T.anyResidential, { canonical_property_group: "other_commercial" }), true);
  assert.equal(ok(T.storage, { canonical_property_group: "other_commercial" }), false);
  // a record that IS commercial still says so
  assert.equal(canonicalPropertyGroupOf({ canonical_property_group: "other_commercial", property_type: "Other", property_class: "Commercial" }), "other_commercial");
});
