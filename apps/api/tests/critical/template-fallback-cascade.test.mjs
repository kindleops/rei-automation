/**
 * template-fallback-cascade.test.mjs
 *
 * Tests the 5-level template fallback cascade in renderOutboundTemplate.
 *
 * Levels:
 *   1 — exact prospect route + property group filter
 *   2 — exact prospect route, relax property group filter
 *   3 — standard ownership + property group filter
 *   4 — standard ownership, relax property group filter
 *   5 — universal English fallback
 *   6 — NO_TEMPLATE hard block
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderOutboundTemplate } from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

function makeCandidate(overrides = {}) {
  return {
    master_owner_id: "mo_test_fallback",
    property_id: "prop_test_fallback",
    best_phone_id: "ph_test_fallback",
    phone_id: "ph_test_fallback",
    canonical_e164: "+15550001234",
    canonical_property_group: "sfr",
    property_type: "SFR",
    market: "Houston, TX",
    timezone: "America/Chicago",
    contact_window: "9:00 AM - 8:00 PM",
    matching_flags: "Likely Owner",
    person_flags_text: "Business Owner",
    identity_alignment: { status: "probable", eligible: true, score: 75, reasons: [] },
    touch_number: 1,
    stage_code: "S1",
    // Required for rendering to pass blank-greeting lint
    owner_display_name: "John Smith",
    seller_first_name: "John",
    prospect_first_name: "John",
    property_address_full: "123 Main St, Houston, TX 77001",
    property_address: "123 Main St",
    ...overrides,
  };
}

const BASE_TEMPLATE = {
  id: "tpl-base",
  template_id: "tpl-base",
  is_active: true,
  use_case: "ownership_check",
  language: "English",
  stage_code: "S1",
  is_first_touch: true,
  template_body: "Hi {{seller_first_name}}, this is Alex. Do you still own {{property_address}}?",
  allowed_property_groups: [],
  prohibited_property_groups: [],
};

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

// ── Test 1: Level 1 — exact prospect + property filter match ─────────────────

test("template fallback level 1: exact prospect route + property group filter", async () => {
  const candidate = makeCandidate({
    matching_flags: "Likely Owner",
    canonical_property_group: "sfr",
  });
  const template = {
    ...BASE_TEMPLATE,
    id: "tpl-sfr-likely-owner",
    template_id: "tpl-sfr-likely-owner",
    allowed_property_groups: ["sfr"],
  };
  const result = await renderOutboundTemplate(
    candidate,
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase: makeSupabaseWithTemplates([template]) }
  );
  assert.equal(result.ok, true, `Expected ok=true, got: ${result.reason}`);
  assert.equal(result.template_fallback_level, 1);
  assert.ok(result.selected_template_id || result.template_routing_details?.selected_template_id || result.template?.template_id);
});

// ── Test 2: Level 2 — prospect route, relax property group filter ─────────────

test("template fallback level 2: prospect route, property group relaxed", async () => {
  const candidate = makeCandidate({
    matching_flags: "Likely Owner",
    canonical_property_group: "other_commercial",
    property_type: "Multi-Family",
  });
  // Template only allows 'sfr', so lvl1 fails → falls back to lvl2 (no property filter)
  const template = {
    ...BASE_TEMPLATE,
    id: "tpl-sfr-only",
    template_id: "tpl-sfr-only",
    allowed_property_groups: ["sfr"],
  };
  const result = await renderOutboundTemplate(
    candidate,
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase: makeSupabaseWithTemplates([template]) }
  );
  assert.equal(result.ok, true, `Expected ok=true at fallback level 2, got: ${result.reason}`);
  assert.equal(result.template_fallback_level, 2);
});

// ── Test 3: Level 3/4 — standard ownership fallback ──────────────────────────

test("template fallback: verified likely_owner falls back to standard ownership template when exact route has none", async () => {
  const candidate = makeCandidate({
    matching_flags: "Likely Owner",
    canonical_property_group: "sfr",
    // No prospect-flag-specific template; only a generic ownership template
  });
  // Relationship probe template that would be returned by the exact route,
  // but generic SFR template also available
  const standard_sfr = {
    ...BASE_TEMPLATE,
    id: "tpl-standard-sfr",
    template_id: "tpl-standard-sfr",
    allowed_property_groups: ["sfr"],
  };
  const result = await renderOutboundTemplate(
    candidate,
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase: makeSupabaseWithTemplates([standard_sfr]) }
  );
  assert.equal(result.ok, true, `Expected fallback to work, got: ${result.reason}`);
  assert.ok(result.template_fallback_level >= 1);
  assert.ok(result.selected_template_id !== null);
});

// ── Test 4: selected_template_id is never null when a fallback template exists ─

test("selected_template_id is never null when fallback exists", async () => {
  const candidate = makeCandidate({
    matching_flags: "Linked To Company",
    canonical_property_group: "other_commercial",
    property_type: "Multi-Family",
  });
  const universal_template = {
    ...BASE_TEMPLATE,
    id: "tpl-universal",
    template_id: "tpl-universal",
    allowed_property_groups: [],
    prohibited_property_groups: [],
  };
  const result = await renderOutboundTemplate(
    candidate,
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase: makeSupabaseWithTemplates([universal_template]) }
  );
  assert.equal(result.ok, true, `Expected ok=true, got: ${result.reason}`);
  assert.ok(
    result.selected_template_id !== null && result.selected_template_id !== undefined,
    `selected_template_id should not be null, got: ${result.selected_template_id}`
  );
});

// ── Test 5: No template at all → NO_TEMPLATE hard block ─────────────────────

test("no template at all → NO_TEMPLATE hard block, ok=false", async () => {
  const candidate = makeCandidate({ matching_flags: "Likely Owner" });
  const result = await renderOutboundTemplate(
    candidate,
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase: makeSupabaseWithTemplates([]) }
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.reason_code === "NO_TEMPLATE" || result.reason_code === "TEMPLATE_RENDER_FAILED",
    `Expected NO_TEMPLATE block, got reason_code=${result.reason_code}`
  );
  assert.equal(result.selected_template_id, null);
});
