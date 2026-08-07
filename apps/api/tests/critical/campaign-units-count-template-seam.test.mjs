/**
 * campaign-units-count-template-seam.test.mjs
 *
 * Regression tests for the G1 seam fix (spine §7): the campaign path read
 * `snapshot.unit_count ?? snapshot.units`, but the graph/target snapshot
 * column is `units_count` — so unit counts NEVER reached template
 * property-scope resolution and a 7-unit property could not select a
 * `5+ Units` template.
 *
 * Also proves the hard class guarantees on the campaign path:
 *   - a 7-unit property selects 5+ Units wording
 *   - an SFR can never select a unit-worded template (filter, not score)
 *   - deterministic selection is stable and keyed by communication class
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  launchCandidateFromTarget,
  candidateSnapshotForMetadata,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import { assignTemplateForTargetFast } from "@/lib/domain/campaigns/campaign-target-template-assignment.js";
import { renderOutboundTemplate } from "@/lib/domain/outbound/supabase-candidate-feeder.js";

const CAMPAIGN = {
  id: "camp-units-seam",
  objective: "ownership_check",
  language_policy: "English",
  metadata: { stage_code: "S1", template_use_case: "ownership_check" },
};

function makeTarget(snapshotOverrides = {}, targetOverrides = {}) {
  return {
    id: "target-1",
    master_owner_id: "mo_units_seam",
    prospect_id: "prospect-1",
    property_id: "prop-1",
    phone_id: "ph-1",
    to_phone_number: "+15550001234",
    market: "houston",
    state: "TX",
    timezone: "America/Chicago",
    language: "English",
    owner_name: "Maria Lopez",
    property_address: "12 Main St",
    routing_status: "ready",
    target_status: "ready",
    metadata: {
      candidate_snapshot: {
        master_owner_id: "mo_units_seam",
        prospect_id: "prospect-1",
        property_id: "prop-1",
        phone_id: "ph-1",
        to_phone_number: "+15550001234",
        market: "houston",
        state: "TX",
        timezone: "America/Chicago",
        language: "English",
        seller_first_name: "Maria",
        seller_full_name: "Maria Lopez",
        property_address_full: "12 Main St, Houston, TX 77001",
        property_city: "Houston",
        property_type: "Multifamily",
        ...snapshotOverrides,
      },
      outreach_snapshot: { never_contacted: true },
    },
    ...targetOverrides,
  };
}

// ─── launchCandidateFromTarget (campaign-automation-service.js seam) ─────────

test("units seam: snapshot.units_count reaches property scope resolution (7 units → 5+ Units)", () => {
  const candidate = launchCandidateFromTarget(makeTarget({ units_count: 7 }), CAMPAIGN);
  assert.equal(candidate.units_count, 7);
  assert.equal(candidate.property_communication_class, "multifamily_5_plus");
  assert.equal(candidate.raw.property_type_scope, "5+ Units");
  assert.equal(candidate.raw.units_count, 7);
  assert.equal(candidate.raw.property_communication_class, "multifamily_5_plus");
});

test("units seam: duplex/triplex/fourplex classes resolve from units_count", () => {
  assert.equal(
    launchCandidateFromTarget(makeTarget({ units_count: 2 }), CAMPAIGN).raw.property_type_scope,
    "Duplex"
  );
  assert.equal(
    launchCandidateFromTarget(makeTarget({ units_count: 3 }), CAMPAIGN).raw.property_type_scope,
    "Triplex"
  );
  assert.equal(
    launchCandidateFromTarget(makeTarget({ units_count: 4 }), CAMPAIGN).raw.property_type_scope,
    "Fourplex"
  );
  assert.equal(
    launchCandidateFromTarget(makeTarget({ units_count: 4 }), CAMPAIGN)
      .property_communication_class,
    "fourplex"
  );
});

test("units seam: legacy snapshot keys (unit_count / units) still work as fallback", () => {
  const legacy = launchCandidateFromTarget(makeTarget({ unit_count: 6 }), CAMPAIGN);
  assert.equal(legacy.units_count, 6);
  assert.equal(legacy.property_communication_class, "multifamily_5_plus");

  const older = launchCandidateFromTarget(makeTarget({ units: 2 }), CAMPAIGN);
  assert.equal(older.units_count, 2);
  assert.equal(older.property_communication_class, "duplex");
});

test("units seam: no units + generic multifamily label → unknown class, neutral scope path", () => {
  const candidate = launchCandidateFromTarget(makeTarget({}), CAMPAIGN);
  assert.equal(candidate.units_count, null);
  assert.equal(candidate.property_communication_class, "unknown");
  // property_scope vocabulary stays stable: generic multifamily label maps to
  // the Landlord / Multifamily scope for existing scope consumers.
  assert.equal(candidate.raw.property_type_scope, "Landlord / Multifamily");
});

test("units seam: single-family property resolves single_family class", () => {
  const candidate = launchCandidateFromTarget(
    makeTarget({ property_type: "Single Family", units_count: 1 }),
    CAMPAIGN
  );
  assert.equal(candidate.property_communication_class, "single_family");
  assert.equal(candidate.raw.property_type_scope, "Residential");
});

test("units seam: candidateSnapshotForMetadata persists units_count", () => {
  const snapshot = candidateSnapshotForMetadata({
    master_owner_id: "mo_units_seam",
    property_id: "prop-1",
    units_count: 7,
    property_type: "Multifamily",
  });
  assert.equal(snapshot.units_count, 7);

  const viaRaw = candidateSnapshotForMetadata({
    master_owner_id: "mo_units_seam",
    raw: { units_count: 3 },
  });
  assert.equal(viaRaw.units_count, 3);

  const absent = candidateSnapshotForMetadata({ master_owner_id: "mo_units_seam" });
  assert.equal(absent.units_count, null);
});

// ─── assignTemplateForTargetFast (campaign-target-template-assignment.js) ────

const FIVE_PLUS_TEMPLATE = {
  id: "tpl-5plus",
  template_id: "tpl-5plus",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "5+ Units",
  template_name: "5+ Units Ownership",
  template_body:
    "Hi {{seller_first_name}}, do you still own the building at {{property_address}}? How many units is it now?",
};

const NEUTRAL_TEMPLATE = {
  id: "tpl-neutral",
  template_id: "tpl-neutral",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "Any Residential",
  template_name: "Neutral Ownership",
  template_body: "Hi {{seller_first_name}}, do you still own {{property_address}}?",
};

// A poisoned template: neutral scope tag but unit wording in the body. The
// wording hard filter must catch it regardless of its scope tag.
const MISLABELED_UNIT_TEMPLATE = {
  id: "tpl-mislabeled",
  template_id: "tpl-mislabeled",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "Any Residential",
  template_name: "Mislabeled Duplex",
  template_body: "Hi {{seller_first_name}}, is your duplex at {{property_address}} still rented?",
};

test("assignment seam: 7-unit property selects the 5+ Units template", () => {
  const target = makeTarget({ units_count: 7 });
  const result = assignTemplateForTargetFast(target, CAMPAIGN, [
    FIVE_PLUS_TEMPLATE,
    NEUTRAL_TEMPLATE,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.template_id, "tpl-5plus");
  assert.equal(result.property_communication_class, "multifamily_5_plus");
  assert.equal(result.units_count, 7);
});

test("assignment seam: SFR can never select a unit-worded template (hard filter, not score)", () => {
  const target = makeTarget({ property_type: "Single Family", units_count: 1 });
  // Catalog offers ONLY the mislabeled unit-worded template plus a neutral one:
  // the SFR must land on the neutral template.
  const withNeutral = assignTemplateForTargetFast(target, CAMPAIGN, [
    MISLABELED_UNIT_TEMPLATE,
    NEUTRAL_TEMPLATE,
  ]);
  assert.equal(withNeutral.ok, true);
  assert.equal(withNeutral.template_id, "tpl-neutral");
  assert.equal(withNeutral.property_communication_class, "single_family");

  // With ONLY class-unsafe templates the target blocks — visibly, with a
  // dedicated reason — instead of sending duplex wording to an SFR.
  const onlyUnsafe = assignTemplateForTargetFast(target, CAMPAIGN, [MISLABELED_UNIT_TEMPLATE]);
  assert.equal(onlyUnsafe.ok, false);
  assert.equal(onlyUnsafe.block_reason, "no_template_for_communication_class");
});

test("assignment seam: unknown class gets property-neutral templates only", () => {
  const target = makeTarget({}); // generic "Multifamily" label, no units
  const result = assignTemplateForTargetFast(target, CAMPAIGN, [
    MISLABELED_UNIT_TEMPLATE,
    NEUTRAL_TEMPLATE,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.template_id, "tpl-neutral");
  assert.equal(result.property_communication_class, "unknown");
});

test("assignment seam: deterministic selection is stable across repeated calls", () => {
  const target = makeTarget({ units_count: 7 });
  const catalog = [
    FIVE_PLUS_TEMPLATE,
    { ...FIVE_PLUS_TEMPLATE, id: "tpl-5plus-b", template_id: "tpl-5plus-b" },
    NEUTRAL_TEMPLATE,
  ];
  const first = assignTemplateForTargetFast(target, CAMPAIGN, catalog);
  for (let i = 0; i < 5; i += 1) {
    const again = assignTemplateForTargetFast(target, CAMPAIGN, catalog);
    assert.equal(again.template_id, first.template_id);
  }
});

// ─── renderOutboundTemplate (campaign queue-plan render path) ────────────────

function makeFluentBuilder(resolvedData) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    ilike: () => builder,
    limit: () => Promise.resolve(resolvedData),
    order: () => builder,
    range: () => Promise.resolve(resolvedData),
    then: (resolve) => resolve(resolvedData),
  };
  return builder;
}

function makeSupabaseWithTemplates(templatesList) {
  return {
    from(table) {
      if (table === "sms_templates") return makeFluentBuilder({ data: templatesList, error: null });
      return makeFluentBuilder({ data: [], error: null });
    },
  };
}

const RENDER_OPTIONS = {
  template_use_case: "ownership_check",
  within_contact_window_now: false,
  now: "2026-08-07T12:00:00.000Z",
  day_bucket: "2026-08-07",
};

const RENDER_DEPS_BASE = { getRecentTemplateIds: async () => ({ ok: true, template_ids: [], errors: [] }) };

function renderDeps(templates) {
  return { ...RENDER_DEPS_BASE, supabase: makeSupabaseWithTemplates(templates) };
}

function makeRenderCandidate(overrides = {}) {
  // Shape mirrors launchCandidateFromTarget output for the graph campaign path.
  return {
    master_owner_id: "mo_units_seam",
    property_id: "prop-1",
    best_phone_id: "ph-1",
    phone_id: "ph-1",
    canonical_e164: "+15550001234",
    market: "houston",
    timezone: "America/Chicago",
    contact_window: "9:00 AM - 8:00 PM",
    matching_flags: "Likely Owner",
    identity_alignment: { status: "probable", eligible: true, score: 75, reasons: [] },
    touch_number: 1,
    stage_code: "S1",
    owner_display_name: "Maria Lopez",
    seller_first_name: "Maria",
    seller_full_name: "Maria Lopez",
    property_address_full: "12 Main St, Houston, TX 77001",
    property_address: "12 Main St",
    ...overrides,
  };
}

test("render seam: 7-unit campaign candidate may receive building/units wording", async () => {
  const candidate = makeRenderCandidate({
    canonical_property_group: "small_multifamily",
    property_type: "Multifamily",
    units_count: 7,
    property_communication_class: "multifamily_5_plus",
    raw: { units_count: 7, property_type: "Multifamily", property_communication_class: "multifamily_5_plus" },
  });
  const unitWorded = {
    ...FIVE_PLUS_TEMPLATE,
    allowed_property_groups: [],
    prohibited_property_groups: [],
    template_body: "Hi {{seller_first_name}}, do you still own the building at {{property_address}}? Are all 7 units rented?",
  };
  const result = await renderOutboundTemplate(candidate, RENDER_OPTIONS, renderDeps([unitWorded]));
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
  assert.equal(result.property_communication_class, "multifamily_5_plus");
  assert.match(result.rendered_message_body, /units/i);
});

test("render seam: SFR candidate is blocked when only unit-worded templates exist", async () => {
  const candidate = makeRenderCandidate({
    canonical_property_group: "sfr",
    property_type: "Single Family",
    units_count: 1,
    property_communication_class: "single_family",
    raw: { units_count: 1, property_type: "Single Family", property_communication_class: "single_family" },
  });
  const unitWorded = {
    ...MISLABELED_UNIT_TEMPLATE,
    allowed_property_groups: [],
    prohibited_property_groups: [],
  };
  const result = await renderOutboundTemplate(candidate, RENDER_OPTIONS, renderDeps([unitWorded]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_class_safe_template");
  assert.equal(result.property_communication_class, "single_family");
});

test("render seam: SFR candidate selects the neutral template when both exist", async () => {
  const candidate = makeRenderCandidate({
    canonical_property_group: "sfr",
    property_type: "Single Family",
    units_count: 1,
    property_communication_class: "single_family",
    raw: { units_count: 1, property_type: "Single Family", property_communication_class: "single_family" },
  });
  const result = await renderOutboundTemplate(
    candidate,
    RENDER_OPTIONS,
    renderDeps([
      { ...MISLABELED_UNIT_TEMPLATE, allowed_property_groups: [], prohibited_property_groups: [] },
      { ...NEUTRAL_TEMPLATE, allowed_property_groups: [], prohibited_property_groups: [] },
    ])
  );
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
  assert.equal(result.template?.template_id || result.selected_template_id, "tpl-neutral");
  assert.ok(!/duplex|units/i.test(result.rendered_message_body));
});

test("render seam: rotation is deterministic — repeated renders select the same template", async () => {
  const candidate = makeRenderCandidate({
    canonical_property_group: "small_multifamily",
    property_type: "Multifamily",
    units_count: 7,
    property_communication_class: "multifamily_5_plus",
    raw: { units_count: 7, property_communication_class: "multifamily_5_plus" },
  });
  const catalog = [
    { ...FIVE_PLUS_TEMPLATE, allowed_property_groups: [], prohibited_property_groups: [] },
    {
      ...FIVE_PLUS_TEMPLATE,
      id: "tpl-5plus-b",
      template_id: "tpl-5plus-b",
      allowed_property_groups: [],
      prohibited_property_groups: [],
    },
    { ...NEUTRAL_TEMPLATE, allowed_property_groups: [], prohibited_property_groups: [] },
  ];
  const first = await renderOutboundTemplate(candidate, RENDER_OPTIONS, renderDeps(catalog));
  assert.equal(first.ok, true, `expected ok, got ${first.reason}`);
  const firstId = first.template?.template_id;
  for (let i = 0; i < 3; i += 1) {
    const again = await renderOutboundTemplate(candidate, RENDER_OPTIONS, renderDeps(catalog));
    assert.equal(again.template?.template_id, firstId);
  }
});
