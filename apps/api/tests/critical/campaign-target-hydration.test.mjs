// ─── campaign-target-hydration.test.mjs ─────────────────────────────────────
// Deterministic, local, no-network proof of the upstream campaign-target
// creation path this PR hardens:
//
//   campaign definition -> campaign_target_graph -> buildCampaignTargets
//   -> campaign_targets -> (identity/owner/phone/timezone/suppression
//   evidence) -> ready-vs-blocked target state
//
// buildCampaignTargets (campaign-automation-service.js) runs for real here,
// unmodified in shape, against a storage-only fake Supabase
// (tests/helpers/campaign-queue-plan-store.mjs — the same fixture
// campaign-queue-plan-hydration.test.mjs uses for createCampaignQueuePlan /
// activateCampaignWithHydration, extended here with a generic `.is()`
// PostgREST matcher; no business decision lives in the fixture). Every
// eligibility, dedupe, and readiness decision below is made by production
// code, not by the fixture. All timestamps are fixed; nothing here depends
// on wall-clock time. No production Supabase, no real provider, no
// deployment, no live campaign activation.
//
// campaign_target_graph itself is a real Postgres TABLE rebuilt by a
// plpgsql RPC (refresh_campaign_target_graph -> ..._staged -> ..._stage_batch
// / ..._stage_commit), not a view. Docker/local Postgres is not available in
// this environment, so the SQL that produces graph rows is proven by
// inspection of apps/api/supabase/migrations/20260601230627_campaign_target_
// graph.sql, 20260602021726_staged_campaign_target_graph_refresh.sql, and
// 20260606041905_campaign_sender_coverage_safe_route_lockin.sql (the final,
// live-wired queue_eligible/sender_coverage computation) only — never
// pretended to have executed. Every fixture row below encodes queue_eligible
// / identity_alignment / timezone / suppression exactly as that inspected
// SQL would compute them for the scenario being proven; it does not invent
// new semantics.
//
// HARDENING (this revision): buildTargetSnapshotFromGraphRow previously
// derived status/target_status/template_status from campaign_target_graph
// .queue_eligible alone -- a purely mechanical messaging-eligibility flag
// (sms_eligible/suppression/wrong_number/pending_touch/active_queue/
// sender_covered) with no owner-identity, timezone, or phone-ownership-
// ambiguity signal. Because buildCampaignTargets only ever fetches
// queue_eligible=true graph rows, every target it wrote was marked 'ready'
// regardless of identity_alignment, timezone, or ambiguous phone ownership.
// resolveCampaignTargetReadiness() now additionally requires: full identity
// linkage (master_owner_id/prospect_id/phone_id/canonical phone), a
// canonical-policy-eligible identity_alignment (reusing evaluatePreSendEligibility
// / isIdentityEligibleForLiveOutbound -- the same fail-closed allowlist
// createCampaignQueuePlan already gates on, not a new invented policy), a
// resolved timezone, and no ambiguous_phone_ownership. See the "renter",
// "explicit non-owner", "ambiguous/unverified", "missing linkage",
// "timezone", and "cross-property" tests below.
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCampaignTargets,
  createCampaignQueuePlan,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import { makeCampaignQueuePlanStore, makeCampaignQueuePlanDeps } from "../helpers/campaign-queue-plan-store.mjs";

// Monday 2026-05-04, 10:00 America/Chicago (15:00 UTC, CDT). Fixed throughout;
// no test in this file reads the real wall clock.
const NOW = "2026-05-04T15:00:00.000Z";
const MARKET = "Houston, TX";

function makeCampaign(id, overrides = {}) {
  return {
    id,
    name: `Proof Campaign ${id}`,
    status: "built",
    objective: "ownership_check",
    market: MARKET,
    auto_queue_enabled: true,
    auto_send_enabled: false,
    auto_reply_mode: "disabled",
    emergency_stop_at: null,
    daily_cap: 25,
    total_cap: 25,
    batch_max: 25,
    market_cap: 25,
    per_sender_cap: 25,
    send_interval_seconds: 60,
    contact_window_start: "09:00",
    contact_window_end: "20:00",
    metadata: {},
    scheduled_for: null,
    activated_at: null,
    queued_count: 0,
    sent_count: 0,
    delivered_count: 0,
    hydration_cursor: null,
    last_activation_idempotency_key: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const BASE_TEMPLATE = {
  id: "tpl_ownership_check_en",
  template_id: "tpl_ownership_check_en",
  is_active: true,
  use_case: "ownership_check",
  language: "English",
  stage_code: "S1",
  is_first_touch: true,
  template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?",
  allowed_property_groups: [],
  prohibited_property_groups: [],
};

const BASE_TEXTGRID_NUMBER = {
  id: "tg_1",
  phone_number: "+15559990001",
  market_name: MARKET,
  status: "active",
  allow_nationwide_fallback: false,
  allow_cluster_fallback: false,
  is_nationwide: false,
  messages_sent_today: 0,
  last_used_at: null,
};

// A single campaign_target_graph row exactly as the inspected SQL
// (refresh_campaign_target_graph_stage_batch + ..._sender_coverage) computes
// it for a verified, fully clean, deliverable owner/phone. Individual tests
// override only the field(s) under test.
function makeGraphRow(overrides = {}) {
  return {
    graph_id: "graph_1",
    property_id: "prop_1",
    property_export_id: "exp_1",
    master_owner_id: "mo_1",
    prospect_id: "pr_1",
    canonical_prospect_id: "pr_1",
    phone_id: "ph_1",
    canonical_e164: "+15551230001",
    market: MARKET,
    state: "TX",
    property_city: "Houston",
    property_zip: "77002",
    property_type: "SFR",
    property_class: "Residential",
    canonical_property_group: "SFR",
    language: "English",
    owner_type_guess: "individual",
    priority_tier: "A",
    sms_eligible: true,
    true_post_contact_suppression: false,
    wrong_number: false,
    pending_prior_touch: false,
    active_queue_item: false,
    sender_covered: true,
    sender_market: MARKET,
    timezone: "America/Chicago",
    best_phone_score: 90,
    phone_owner: "John Smith",
    phone_activity_status: "active",
    usage_12_months: "12",
    usage_2_months: "2",
    template_use_case: "ownership_check",
    contact_window: null,
    latest_contact_at: null,
    last_outbound_at: null,
    last_inbound_at: null,
    routing_tier: "exact_market_match",
    identity_alignment: "verified",
    acquisition_score: 75,
    podio_tags: null,
    matching_flags: {},
    matching_flags_text: null,
    owner_name: "John Smith",
    seller_first_name: "John",
    seller_full_name: "John Smith",
    property_address_full: "123 Main St, Houston, TX 77002",
    estimated_value: 250000,
    equity_amount: 100000,
    equity_percent: 40,
    cash_offer: null,
    touch_count: 0,
    current_touch_number: 1,
    never_contacted: true,
    queue_eligible: true,
    queue_block_reason: null,
    graph_source: "campaign_target_graph.refresh.direct_staged",
    linkage_counts: {},
    blocker_flags: {},
    source_updated_at: NOW,
    generated_at: NOW,
    ...overrides,
  };
}

/** Fresh store with one campaign, ready for a single test's scenario. */
function setup(campaignOverrides = {}) {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_1", campaignOverrides);
  store.seedRow("campaigns", campaign);
  const deps = makeCampaignQueuePlanDeps(store);
  return { store, deps, campaignId: campaign.id };
}

function target(store, campaignId) {
  const rows = store.rows("campaign_targets").filter((row) => row.campaign_id === campaignId);
  return rows;
}

// ── 1. Verified owner happy path ─────────────────────────────────────────────

test("verified owner happy path: produces exactly one ready campaign_target with coherent evidence", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow());

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.built_count, 1);

  const targets = target(store, campaignId);
  assert.equal(targets.length, 1);
  const row = targets[0];
  assert.equal(row.property_id, "prop_1");
  assert.equal(row.master_owner_id, "mo_1");
  assert.equal(row.prospect_id, "pr_1");
  assert.equal(row.phone_id, "ph_1");
  assert.equal(row.to_phone_number, "+15551230001");
  assert.equal(row.identity_status, "verified");
  assert.equal(row.timezone, "America/Chicago");
  assert.equal(row.target_status, "ready");
  assert.equal(row.status, "ready");
  assert.equal(row.template_status, "pending");
  assert.equal(row.block_reason, null);
  assert.ok(row.metadata.candidate_snapshot, "candidate_snapshot must be present");
  assert.ok(row.metadata.outreach_snapshot, "outreach_snapshot must be present");
  assert.equal(row.metadata.candidate_snapshot.master_owner_id, "mo_1");
  assert.equal(row.metadata.outreach_snapshot.true_post_contact_suppression, false);
});

// ── 2. Renter ─────────────────────────────────────────────────────────────────

test("renter: identity_alignment=renter_risk is persisted blocked, never ready (production semantics: campaign_target_graph.queue_eligible does not encode identity, so the row IS created -- just not ready)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ identity_alignment: "renter_risk" }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.built_count, 1);

  const [row] = target(store, campaignId);
  assert.equal(row.identity_status, "renter_risk");
  assert.equal(row.target_status, "blocked");
  assert.equal(row.status, "blocked");
  // isIdentityEligibleForLiveOutbound has no explicit renter_risk branch (the
  // graph's identity_alignment CASE never surfaces raw likely_owner/
  // likely_renting to the shared policy -- see campaign-automation-
  // service.js:6233-6240's own comment on this), so it falls through to the
  // fail-closed default-deny branch. Still correctly blocked -- proving the
  // fail-closed default, not a bespoke renter rule.
  assert.equal(row.block_reason, "identity_unknown_policy");
});

// ── 3. Explicit non-owner / mismatch ─────────────────────────────────────────

test("explicit identity mismatch: never becomes ready (defense-in-depth -- campaign_target_graph's current CASE never emits 'mismatch' itself, but the shared policy hard-blocks it if a future signal source sets it)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ identity_alignment: "mismatch" }));

  await buildCampaignTargets(campaignId, {}, deps);
  const [row] = target(store, campaignId);
  assert.equal(row.target_status, "blocked");
  assert.equal(row.block_reason, "identity_mismatch");
});

// ── 4. Ambiguous / unverified identity ───────────────────────────────────────

test("ambiguous identity: unknown must never become ready", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ identity_alignment: "unknown" }));

  await buildCampaignTargets(campaignId, {}, deps);
  const [row] = target(store, campaignId);
  assert.equal(row.target_status, "blocked");
  assert.equal(row.block_reason, "identity_not_verified");
});

test("documented policy exception: identity_alignment=probable IS treated ready (isIdentityEligibleForLiveOutbound's explicit 'identity_safe' branch for verified+probable -- an existing policy, not invented here)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ identity_alignment: "probable" }));

  await buildCampaignTargets(campaignId, {}, deps);
  const [row] = target(store, campaignId);
  assert.equal(row.target_status, "ready");
  assert.equal(row.block_reason, null);
});

test("ambiguous phone ownership: same phone linked to two different master_owner_id graph rows blocks the collapsed recipient even though identity/timezone/linkage are otherwise clean", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_a", property_id: "prop_a", master_owner_id: "mo_a", prospect_id: "pr_a",
  }));
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_b", property_id: "prop_b", master_owner_id: "mo_b", prospect_id: "pr_b",
  }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  // collapseGraphRowsToRecipients buckets by phone+touch first, so the two
  // conflicting-owner rows for the same phone collapse to exactly one
  // recipient (real production dedupe behavior, not special-cased here).
  assert.equal(result.built_count, 1);
  const [row] = target(store, campaignId);
  assert.equal(row.metadata.recipient_dedup.ambiguous_phone_ownership, true);
  assert.equal(row.target_status, "blocked");
  assert.equal(row.block_reason, "ambiguous_phone_ownership");
});

// ── 5. Missing identity linkage ──────────────────────────────────────────────

test("missing identity linkage fails closed (defense-in-depth: production SQL's sms_eligible requires canonical_e164 IS NOT NULL, so queue_eligible=true+missing linkage cannot occur today -- proven here as a hypothetical/corrupted-row guard, not an observed production state)", async () => {
  // prospect linkage has its own real fallback (prospect_id OR
  // canonical_prospect_id -- mirrored from buildTargetSnapshotFromGraphRow's
  // own prospectId derivation), so that case must clear both to be "missing".
  const scenarios = [
    { master_owner_id: null },
    { prospect_id: null, canonical_prospect_id: null },
    { phone_id: null },
  ];
  for (const overrides of scenarios) {
    const { store, deps, campaignId } = setup();
    store.seedRow("campaign_target_graph", makeGraphRow(overrides));

    await buildCampaignTargets(campaignId, {}, deps);
    const [row] = target(store, campaignId);
    const label = Object.keys(overrides).join("+");
    assert.equal(row.target_status, "blocked", `missing ${label} must block`);
    assert.equal(row.block_reason, "missing_identity_linkage", `missing ${label} must report missing_identity_linkage`);
  }
});

test("missing canonical phone fails closed by exclusion (collapseGraphRowsToRecipients skips any row with no canonical_e164 before a campaign_target is ever built -- a stronger fail-closed outcome than persisting blocked)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ canonical_e164: null }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.built_count, 0);
  assert.equal(target(store, campaignId).length, 0, "a row with no usable canonical phone must never produce a campaign_target");
});

// ── 6. Suppression ────────────────────────────────────────────────────────────

test("suppression: true_post_contact_suppression excludes the row entirely (queue_eligible computed false by the real SQL formula, so buildCampaignTargets's own queue_eligible=true fetch never returns it)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_suppressed", property_id: "prop_suppressed", master_owner_id: "mo_suppressed",
    true_post_contact_suppression: true, queue_eligible: false, queue_block_reason: "suppressed",
  }));
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_clean", property_id: "prop_clean", master_owner_id: "mo_clean",
    canonical_e164: "+15551230099", phone_id: "ph_clean", prospect_id: "pr_clean",
  }));

  await buildCampaignTargets(campaignId, {}, deps);
  const rows = target(store, campaignId);
  assert.equal(rows.length, 1, "suppressed owner must not appear in campaign_targets at all");
  assert.equal(rows[0].master_owner_id, "mo_clean");
});

test("suppression: wrong_number excludes the row entirely, same mechanism as true_post_contact_suppression", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    wrong_number: true, queue_eligible: false, queue_block_reason: "wrong_number",
  }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.built_count, 0);
  assert.equal(target(store, campaignId).length, 0);
});

// ── 7. Phone selection ───────────────────────────────────────────────────────
//
// buildCampaignTargets does NOT select phones -- campaign_target_graph's SQL
// already resolved the single best phone per property via a LATERAL join
// (rank: primary_prospect_id match -> canonical_prospect_id match ->
// master_owner_id match, then is_best_phone_for_slot DESC, is_best_phone_
// for_owner DESC, best_phone_score DESC NULLS LAST, updated_at DESC) before
// buildCampaignTargets ever sees the row. That SQL selection is proven only
// by inspection (see file header) -- NOT executed here. What IS proven here:
// (a) transform fidelity -- buildCampaignTargets never substitutes a
// different phone than the one the graph row already carries (see test 1:
// phone_id/to_phone_number pass through unchanged), and (b) a wrong-number
// phone cannot "win" overall regardless of its score, because wrong_number
// forces queue_eligible=false upstream in the real SQL formula, which
// excludes the row from buildCampaignTargets entirely -- independent of
// best_phone_score.

test("phone selection: a high-scoring wrong-number phone cannot win over a lower-scoring clean phone on a different owner -- excluded regardless of score", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_wrong_number_high_score", property_id: "prop_wn", master_owner_id: "mo_wn",
    prospect_id: "pr_wn", phone_id: "ph_wn", canonical_e164: "+15551230098",
    best_phone_score: 99, wrong_number: true, queue_eligible: false, queue_block_reason: "wrong_number",
  }));
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_clean_low_score", property_id: "prop_clean", master_owner_id: "mo_clean",
    prospect_id: "pr_clean", phone_id: "ph_clean", canonical_e164: "+15551230097",
    best_phone_score: 10,
  }));

  await buildCampaignTargets(campaignId, {}, deps);
  const rows = target(store, campaignId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].master_owner_id, "mo_clean", "the wrong-number phone must never appear as a target regardless of its higher score");
});

// ── 8. Timezone ───────────────────────────────────────────────────────────────

test("timezone: valid resolved timezone passes through unchanged onto a ready target", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ timezone: "America/Denver" }));
  await buildCampaignTargets(campaignId, {}, deps);
  const [row] = target(store, campaignId);
  assert.equal(row.timezone, "America/Denver");
  assert.equal(row.target_status, "ready");
});

test("timezone: missing/unresolvable timezone fails closed -- never silently defaults to a guessed zone at this layer (aligned with createCampaignQueuePlan's independent queue-time fail-closed timezone gate)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ timezone: null }));
  await buildCampaignTargets(campaignId, {}, deps);
  const [row] = target(store, campaignId);
  assert.equal(row.timezone, null, "buildCampaignTargets must not invent a fallback timezone");
  assert.equal(row.target_status, "blocked");
  assert.equal(row.block_reason, "missing_timezone");
});

// ── 9. Duplicate target creation ─────────────────────────────────────────────

test("dedupe: same owner+phone across two properties collapses to exactly one campaign_target, primary chosen by highest acquisition_score", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_prop_a", property_id: "prop_a", acquisition_score: 90,
  }));
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_prop_b", property_id: "prop_b", acquisition_score: 50,
  }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.built_count, 1, "one owner/phone must never produce two active campaign_targets rows");
  const [row] = target(store, campaignId);
  assert.equal(row.primary_property_id, "prop_a", "higher acquisition_score property must win as primary");
  assert.deepEqual([...row.portfolio_property_ids].sort(), ["prop_a", "prop_b"]);
});

test("dedupe: re-running buildCampaignTargets with unchanged graph data does not accumulate duplicate rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow());

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId).length, 1);

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId).length, 1, "re-running the build must delete-then-reinsert, never accumulate");
});

// ── 10. Refresh behavior ──────────────────────────────────────────────────────

test("refresh: newly-suppressed evidence removes a previously-ready target on the next build (stale ready state does not survive)", async () => {
  const { store, deps, campaignId } = setup();
  const graphRow = store.seedRow("campaign_target_graph", makeGraphRow());

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId)[0].target_status, "ready");

  // Simulate a graph refresh picking up new suppression evidence.
  graphRow.true_post_contact_suppression = true;
  graphRow.queue_eligible = false;
  graphRow.queue_block_reason = "suppressed";

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId).length, 0, "the stale ready row must not survive a refresh that found new suppression evidence");
});

test("refresh: newly-valid evidence produces a ready target on the next build", async () => {
  const { store, deps, campaignId } = setup();
  const graphRow = store.seedRow("campaign_target_graph", makeGraphRow({
    true_post_contact_suppression: true, queue_eligible: false, queue_block_reason: "suppressed",
  }));

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId).length, 0);

  // Simulate the suppression clearing on a later graph refresh.
  graphRow.true_post_contact_suppression = false;
  graphRow.queue_eligible = true;
  graphRow.queue_block_reason = null;

  await buildCampaignTargets(campaignId, {}, deps);
  const rows = target(store, campaignId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_status, "ready");
});

// ── 11. Cross-property identity safety ───────────────────────────────────────

test("cross-property identity safety: two owners sharing the same display name never cross-contaminate each other's property/phone/prospect attribution", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_owner_a", property_id: "prop_owner_a", master_owner_id: "mo_owner_a",
    prospect_id: "pr_owner_a", phone_id: "ph_owner_a", canonical_e164: "+15551230011",
    owner_name: "John Smith", seller_full_name: "John Smith",
    property_address_full: "1 First St, Houston, TX 77002",
  }));
  store.seedRow("campaign_target_graph", makeGraphRow({
    graph_id: "graph_owner_b", property_id: "prop_owner_b", master_owner_id: "mo_owner_b",
    prospect_id: "pr_owner_b", phone_id: "ph_owner_b", canonical_e164: "+15551230022",
    owner_name: "John Smith", seller_full_name: "John Smith",
    property_address_full: "2 Second St, Houston, TX 77002",
  }));

  const result = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(result.built_count, 2, "two distinct owners with the same display name must both be created, independently");

  const rows = target(store, campaignId);
  const a = rows.find((r) => r.property_id === "prop_owner_a");
  const b = rows.find((r) => r.property_id === "prop_owner_b");
  assert.ok(a && b);
  assert.equal(a.master_owner_id, "mo_owner_a");
  assert.equal(a.phone_id, "ph_owner_a");
  assert.equal(a.to_phone_number, "+15551230011");
  assert.equal(b.master_owner_id, "mo_owner_b");
  assert.equal(b.phone_id, "ph_owner_b");
  assert.equal(b.to_phone_number, "+15551230022");
  // Neither row's identity fields leaked into the other's.
  assert.notEqual(a.master_owner_id, b.master_owner_id);
  assert.notEqual(a.to_phone_number, b.to_phone_number);
});

// ── 12. Contract with PR #50 (createCampaignQueuePlan) ──────────────────────

test("boundary: buildCampaignTargets -> campaign_targets -> createCampaignQueuePlan -> exactly one send_queue row for a verified happy path", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow());
  store.seedRow("sms_templates", { ...BASE_TEMPLATE });
  store.seedRow("textgrid_numbers", { ...BASE_TEXTGRID_NUMBER });

  const buildResult = await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(buildResult.built_count, 1);
  assert.equal(target(store, campaignId)[0].target_status, "ready");

  const queueResult = await createCampaignQueuePlan(campaignId, {
    now: NOW,
    first_scheduled_at: NOW,
    explicit_operator_action: true,
  }, deps);

  assert.equal(queueResult.ok, true, JSON.stringify(queueResult.blockers));
  assert.equal(queueResult.send_queue_rows_created, 1);
  const queueRows = store.rows("send_queue");
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].to_phone_number, "+15551230001");
});

test("boundary: a blocked (renter) campaign_target never crosses into send_queue -- createCampaignQueuePlan only selects target_status='ready' rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_target_graph", makeGraphRow({ identity_alignment: "renter_risk" }));
  store.seedRow("sms_templates", { ...BASE_TEMPLATE });
  store.seedRow("textgrid_numbers", { ...BASE_TEXTGRID_NUMBER });

  await buildCampaignTargets(campaignId, {}, deps);
  assert.equal(target(store, campaignId)[0].target_status, "blocked");

  const queueResult = await createCampaignQueuePlan(campaignId, {
    now: NOW,
    first_scheduled_at: NOW,
    explicit_operator_action: true,
  }, deps);

  assert.equal(queueResult.send_queue_rows_created ?? 0, 0);
  assert.equal(store.rows("send_queue").length, 0, "a blocked target must never reach send_queue");
});
