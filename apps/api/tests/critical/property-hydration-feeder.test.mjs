import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hydratePropertyForCandidate,
  runSupabaseCandidateFeeder,
} from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

// ── Mock builder ───────────────────────────────────────────────────────────────

function makeBuilder(rows) {
  let filteredRows = [...rows];
  const b = {
    select: () => b,
    eq(col, val) {
      filteredRows = filteredRows.filter((r) => String(r[col] ?? "") === String(val ?? ""));
      return b;
    },
    in(col, vals) {
      const strs = Array.isArray(vals) ? vals.map(String) : [];
      filteredRows = filteredRows.filter((r) => strs.includes(String(r[col] ?? "")));
      return b;
    },
    order: () => b,
    range(start = 0, end) {
      const slice = filteredRows.slice(start, end != null ? end + 1 : undefined);
      return Promise.resolve({ data: slice, error: null });
    },
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: filteredRows[0] ?? null, error: null }),
    then(resolve) {
      return resolve({ data: filteredRows, error: null });
    },
  };
  return b;
}

function makeMockSupabase({ candidateSource = "v_sms_ready_contacts", candidateRows = [], propertyRows = [], masterOwnerRows = [] } = {}) {
  return {
    from(table) {
      if (table === candidateSource) return makeBuilder(candidateRows);
      if (table === "properties") return makeBuilder(propertyRows);
      if (table === "master_owners") return makeBuilder(masterOwnerRows);
      return makeBuilder([]);
    },
  };
}

// A candidate row as it would come from v_sms_ready_contacts (no property_id).
// Omit contact_window so computeNextSchedulableTime returns now and candidate goes to queued_count.
function makeSmsReadyCandidate(id, overrides = {}) {
  return {
    master_owner_id: `mo_${id}`,
    // no property_id — this is the key characteristic of v_sms_ready_contacts rows
    best_phone_id: `ph_${id}`,
    phone_id: `ph_${id}`,
    canonical_e164: `+12085550${String(100 + id).slice(-3)}`,
    market: "houston",
    property_address_state: "TX",
    seller_first_name: "Test",
    owner_display_name: "Test Owner",
    prospect_full_name: "Test Owner",
    ...overrides,
  };
}

function makePropertyRow(id, masterOwnerId, overrides = {}) {
  return {
    id: `prop_${id}`,
    property_id: `prop_${id}`,
    master_owner_id: masterOwnerId,
    property_address_full: `${id} Oak Lane, Houston, TX 77001`,
    property_address_city: "Houston",
    property_address_state: "TX",
    property_address_zip: "77001",
    market: "houston",
    property_type: "SFR",
    estimated_value: 250000,
    final_acquisition_score: 85,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Unit tests for hydratePropertyForCandidate ─────────────────────────────────

test("hydratePropertyForCandidate Strategy 1: resolves property via master_owner_id match", async () => {
  const supabase = makeMockSupabase({
    propertyRows: [makePropertyRow(1, "mo_1")],
  });

  const result = await hydratePropertyForCandidate(
    { master_owner_id: "mo_1" },
    { supabase }
  );

  assert.equal(result.ok, true);
  assert.equal(result.hydration_source, "master_owner_id_match");
  assert.equal(result.property_id, "prop_1");
  assert.equal(result.market, "houston");
  assert.equal(result.property_address_full, "1 Oak Lane, Houston, TX 77001");
});

test("hydratePropertyForCandidate Strategy 2: resolves via joined_property_ids_json when Strategy 1 fails", async () => {
  const supabase = makeMockSupabase({
    // No property with master_owner_id = "mo_2"
    propertyRows: [makePropertyRow(99, "mo_OTHER")],
    masterOwnerRows: [
      { id: "mo_2", joined_property_ids_json: ["prop_99"] },
    ],
  });

  // Add prop_99 row with correct `id` so `in("id", ["prop_99"])` finds it
  supabase._propRows = [makePropertyRow(99, "mo_OTHER", { id: "prop_99", property_id: "prop_99" })];
  // Override from to return the extended list for properties
  const baseSupa = supabase;
  const extended = {
    from(table) {
      if (table === "properties") return makeBuilder([makePropertyRow(99, "mo_OTHER", { id: "prop_99", property_id: "prop_99" })]);
      return baseSupa.from(table);
    },
  };

  const result = await hydratePropertyForCandidate(
    { master_owner_id: "mo_2" },
    { supabase: extended }
  );

  assert.equal(result.ok, true);
  assert.equal(result.hydration_source, "joined_property_ids_json");
  assert.equal(result.property_id, "prop_99");
});

test("hydratePropertyForCandidate returns ok:false when no property found anywhere", async () => {
  const supabase = makeMockSupabase({
    propertyRows: [],
    masterOwnerRows: [{ id: "mo_3", joined_property_ids_json: [] }],
  });

  const result = await hydratePropertyForCandidate(
    { master_owner_id: "mo_3" },
    { supabase }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_property_found");
});

test("hydratePropertyForCandidate returns ok:false when no master_owner_id", async () => {
  const supabase = makeMockSupabase();
  const result = await hydratePropertyForCandidate({}, { supabase });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_master_owner_id");
});

// ── Integration tests: runSupabaseCandidateFeeder with v_sms_ready_contacts ────

// Shared input options — supply values that would otherwise trigger 12s system-flag fetches
const sharedOptions = {
  allow_weak_identity_outbound: true,
  identity_blocked_markets: [],
  within_contact_window_now: false,
  routing_safe_only: false,
  identity_gate_mode: "relaxed",
  template_use_case: "ownership_check",
};

const sharedDeps = {
  hasDuplicateQueueItem: async () => false,
  chooseTextgridNumber: async () => ({
    ok: true,
    routing_allowed: true,
    routing_tier: "exact_market_match",
    selection_reason: "exact_market_match",
    routing_rule_name: "exact_market_match",
    selected: { id: "tn_1", phone_number: "+18325550101", market: "houston" },
  }),
  renderOutboundTemplate: async () => ({
    ok: true,
    template: { item_id: "tpl_hydration", source: "supabase" },
    template_use_case: "ownership_check",
    rendered_message_body: "Quick question about your property.",
  }),
  createSendQueueItem: async () => ({
    ok: true,
    queued: true,
    queue_key: "dry-run-key",
    queue_row_id: null,
  }),
};

test("v_sms_ready_contacts dry_run: hydrated candidate appears in sample_created_queue_items", async () => {
  const candidateRows = [makeSmsReadyCandidate(1)];
  const propertyRows = [makePropertyRow(1, "mo_1")];

  const result = await runSupabaseCandidateFeeder(
    {
      ...sharedOptions,
      dry_run: true,
      candidate_source: "v_sms_ready_contacts",
      limit: 5,
      scan_limit: 5,
      campaign_session_id: "session-hydration-test",
    },
    {
      ...sharedDeps,
      supabase: makeMockSupabase({ candidateRows, propertyRows }),
    }
  );

  assert.equal(result.ok, true, `feeder failed: ${result.error || result.candidate_source_error}`);
  assert.equal(result.candidate_source, "v_sms_ready_contacts");
  assert.equal(result.property_hydration_attempt_count, 1, "should attempt hydration");
  assert.equal(result.property_hydration_success_count, 1, "should succeed");
  assert.equal(result.property_hydration_failed_count, 0, "no hydration failures");
  assert.equal(result.missing_property_id_after_hydration_count, 0, "no post-hydration misses");
  assert.equal(result.eligible_count, 1, "hydrated candidate should pass eligibility");
  // queued or scheduled depending on current time — either confirms the candidate completed the pipeline
  assert.ok(result.queued_count + result.scheduled_count >= 1, "hydrated candidate should queue or schedule");
  assert.ok(result.sample_created_queue_items.length >= 1, "should have a sample queue item");

  const item = result.sample_created_queue_items[0];
  assert.ok(item.property_id, "sample queue item should have property_id after hydration");
});

test("v_sms_ready_contacts dry_run: failed hydration increments missing_property_id_after_hydration_count", async () => {
  const candidateRows = [makeSmsReadyCandidate(7)];

  const result = await runSupabaseCandidateFeeder(
    {
      ...sharedOptions,
      dry_run: true,
      candidate_source: "v_sms_ready_contacts",
      limit: 5,
      scan_limit: 5,
      campaign_session_id: "session-hydration-fail",
    },
    {
      ...sharedDeps,
      supabase: makeMockSupabase({ candidateRows, propertyRows: [], masterOwnerRows: [] }),
    }
  );

  assert.equal(result.ok, true, `feeder failed: ${result.error || result.candidate_source_error}`);
  assert.equal(result.property_hydration_attempt_count, 1, "should attempt hydration");
  assert.equal(result.property_hydration_failed_count, 1, "hydration should fail");
  assert.equal(result.missing_property_id_after_hydration_count, 1, "should count post-hydration miss");
  assert.equal(result.queued_count, 0, "candidate without property_id should not queue");
});

test("v_sms_ready_contacts: candidate with existing property_id skips hydration", async () => {
  const candidateRows = [makeSmsReadyCandidate(2, { property_id: "prop_already_set" })];

  const result = await runSupabaseCandidateFeeder(
    {
      ...sharedOptions,
      dry_run: true,
      candidate_source: "v_sms_ready_contacts",
      limit: 5,
      scan_limit: 5,
      campaign_session_id: "session-already-hydrated",
    },
    {
      ...sharedDeps,
      supabase: makeMockSupabase({ candidateRows }),
    }
  );

  assert.equal(result.ok, true, `feeder failed: ${result.error || result.candidate_source_error}`);
  assert.equal(result.property_hydration_attempt_count, 0, "no hydration needed for candidate with property_id");
  assert.equal(result.eligible_count, 1, "pre-hydrated candidate should be eligible");
  assert.ok(result.queued_count + result.scheduled_count >= 1, "pre-hydrated candidate should queue or schedule");
});

test("v_sms_ready_contacts: mixed batch — some hydrated, some not, counters correct", async () => {
  const candidateRows = [
    makeSmsReadyCandidate(10),                                          // needs hydration — will succeed
    makeSmsReadyCandidate(11, { property_id: "prop_pre_set" }),        // already has property_id
    makeSmsReadyCandidate(12),                                          // needs hydration — will fail
  ];
  const propertyRows = [makePropertyRow(10, "mo_10")];                  // only mo_10 has a property

  const result = await runSupabaseCandidateFeeder(
    {
      ...sharedOptions,
      dry_run: true,
      candidate_source: "v_sms_ready_contacts",
      limit: 10,
      scan_limit: 10,
      campaign_session_id: "session-mixed-batch",
    },
    {
      ...sharedDeps,
      supabase: makeMockSupabase({ candidateRows, propertyRows }),
    }
  );

  assert.equal(result.ok, true, `feeder failed: ${result.error || result.candidate_source_error}`);
  assert.equal(result.property_hydration_attempt_count, 2, "two candidates need hydration");
  assert.equal(result.property_hydration_success_count, 1, "one hydration succeeds");
  assert.equal(result.property_hydration_failed_count, 1, "one hydration fails");
  assert.equal(result.missing_property_id_after_hydration_count, 1, "one post-hydration miss");
  assert.equal(result.eligible_count, 2, "hydrated + pre-set candidates should be eligible");
  assert.ok(result.queued_count + result.scheduled_count >= 2, "two candidates should queue or schedule");
});
