// ─── campaign-queue-plan-hydration.test.mjs ─────────────────────────────────
// Deterministic, local, no-network proof of the campaign BUILD -> HYDRATE ->
// QUEUE -> ACTIVATE path: createCampaignQueuePlan and
// activateCampaignWithHydration (campaign-automation-service.js). Both
// functions run for real here, unmodified in shape (only newly gated),
// against a storage-only fake Supabase (tests/helpers/campaign-queue-plan-
// store.mjs). Every eligibility, routing, template, dedupe, and lifecycle
// decision below is made by production code, not by the fixture. No provider
// (TextGrid) client exists in this fixture at all — createCampaignQueuePlan
// and activateCampaignWithHydration never call one; sending is a separate
// later stage (runSendQueue) not exercised here. All timestamps are fixed;
// nothing here depends on wall-clock time.
//
// HARDENING (this revision): two safety gaps proven by the prior revision of
// this file are now closed in campaign-automation-service.js:
//   - Owner/identity verification: createCampaignQueuePlan now runs the same
//     canonical evaluatePreSendEligibility() gate (presend-eligibility-
//     engine.js) every other outbound path already uses, fed by
//     launchCandidateFromTarget's real identity_alignment/likely_owner/
//     likely_renting signals. Renter, explicit non-owner/mismatch, and
//     unverified/ambiguous identity are now blocked before any send_queue
//     insert — never inferred merely from master_owner_id/prospect_id/
//     phone_id being present. See the "owner verification" tests below.
//   - Timezone: launchCandidateFromTarget now flags a missing or invalid
//     (non-IANA) timezone via timezone_eligibility_reason, reusing the
//     invalid_timezone reason vocabulary already established in
//     shadow-burst-timing.js's evaluateContactWindowAt. createCampaignQueuePlan
//     fails closed on it before insertion. The underlying `timezone` field
//     itself still defaults to America/Chicago (unchanged) so non-queue
//     callers of launchCandidateFromTarget (e.g. template-preview sampling in
//     evaluateCampaignLaunchReadiness) are unaffected. See the "timezone"
//     tests below.
//
// "never-owned" / "sold-property" / "former-owner" are NOT separately gated
// states in this pipeline. Production routes them into the same wrong_number /
// true_post_contact_suppression outreach-state suppression as an actual wrong
// number (see classify.js's explicit "sold/never_owned/not_owner map to
// wrong_number for suppression" routing) — that is the real code's canonical
// representation, reused as-is (not a new vocabulary) in the "suppressed"
// tests below.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createCampaignQueuePlan,
  activateCampaignWithHydration,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import { buildSendQueueDedupeKey } from "@/lib/supabase/sms-engine.js";
import { BLOCK_REASONS } from "@/lib/domain/outbound/presend-eligibility-engine.js";

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

// Default identity_status='verified' — this is the graph-precomputed
// ownership verdict campaign_target_graph.identity_alignment would carry for
// a genuinely confirmed owner (see buildTargetSnapshotFromGraphRow, which
// copies row.identity_alignment straight onto campaign_targets.identity_status).
// Individual tests override it (or the raw likely_owner/likely_renting
// signals) to exercise each blocked state.
function makeReadyTarget({
  id,
  campaign_id,
  master_owner_id = "mo_1",
  prospect_id = "pr_1",
  property_id = "prop_1",
  phone_id = "ph_1",
  to_phone_number = "+15551230001",
  market = MARKET,
  state = "TX",
  timezone = "America/Chicago",
  priority_score = 50,
  identity_status = "verified",
  outreach_snapshot = {},
  candidate_snapshot = {},
  target_status = "ready",
}) {
  return {
    id,
    campaign_id,
    target_status,
    priority_score,
    master_owner_id,
    prospect_id,
    property_id,
    phone_id,
    to_phone_number,
    market,
    state,
    timezone,
    identity_status,
    owner_name: "John Smith",
    language: "English",
    property_address: "123 Main St, Houston, TX 77002",
    metadata: {
      candidate_snapshot: {
        seller_first_name: "John",
        seller_full_name: "John Smith",
        owner_display_name: "John Smith",
        property_address_full: "123 Main St, Houston, TX 77002",
        property_city: "Houston",
        property_zip: "77002",
        ...candidate_snapshot,
      },
      outreach_snapshot: {
        never_contacted: true,
        touch_count: 0,
        true_post_contact_suppression: false,
        wrong_number: false,
        pending_prior_touch: false,
        active_queue_item: false,
        ...outreach_snapshot,
      },
    },
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

/** Fresh store with one campaign + a fully-provisioned sender/template pair, ready for a single test's scenario. */
function setup(campaignOverrides = {}) {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_1", campaignOverrides);
  store.seedRow("campaigns", campaign);
  store.seedRow("sms_templates", { ...BASE_TEMPLATE });
  store.seedRow("textgrid_numbers", { ...BASE_TEXTGRID_NUMBER });
  const deps = makeCampaignQueuePlanDeps(store);
  return { store, deps, campaignId: campaign.id };
}

// ── 12. Happy path — createCampaignQueuePlan ────────────────────────────────

test("happy path: verified owner + valid phone/template/number -> exactly one canonical send_queue row", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));

  const result = await createCampaignQueuePlan(campaignId, {
    now: NOW,
    first_scheduled_at: NOW,
    explicit_operator_action: true,
  }, deps);

  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.send_queue_rows_created, 1);
  assert.equal(result.send_windows_created, 1);

  const queueRows = store.rows("send_queue");
  assert.equal(queueRows.length, 1, "no direct bulk insert may create more than the planned row");
  const row = queueRows[0];
  assert.equal(row.campaign_id, campaignId);
  assert.equal(row.to_phone_number, "+15551230001");
  assert.equal(row.from_phone_number, "+15559990001", "real chooseTextgridNumber must select the seeded active number");
  assert.equal(row.template_id, "tpl_ownership_check_en", "real renderOutboundTemplate must select the seeded active template");
  assert.equal(row.timezone, "America/Chicago", "real timezone window generation ran for this target");
  assert.ok(row.message_body.includes("John"), `rendered body should include seller first name: ${row.message_body}`);
  assert.ok(!row.message_body.includes("{{"), "no unresolved template placeholders may reach send_queue");

  // Real buildSendQueueDedupeKey — recomputed independently to prove the
  // production dedupe key on the row is the real one, not a fixture stub.
  const expectedDedupeKey = buildSendQueueDedupeKey({
    master_owner_id: "mo_1",
    property_id: "prop_1",
    to_phone_number: "+15551230001",
    template_use_case: "ownership_check",
    touch_number: 1,
    campaign_session_id: campaignId,
  });
  assert.equal(row.dedupe_key, expectedDedupeKey);

  // Safety: this codebase defaults an un-flagged queue-plan call (no explicit
  // confirm_live/production-launch markers) to proof/no-send mode — the row
  // is created (proving the pipeline) but is marked non-executable, so no
  // later stage could ever dispatch it as a real message from this call.
  assert.equal(row.metadata.launch_mode, "proof_hydration_no_send");
  assert.equal(row.sms_eligible, false);
  assert.equal(row.routing_allowed, false);

  const targets = store.rows("campaign_targets");
  assert.equal(targets[0].target_status, "planned", "queued target must leave target_status=ready so it cannot be re-selected");
});

test("happy path: activateCampaignWithHydration hydrates the queue for real and drives the campaign to active", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));

  const result = await activateCampaignWithHydration(campaignId, { now: NOW, batch_max: 5 }, deps);

  assert.equal(result.ok, true, JSON.stringify(result.blockers || result.error));
  assert.equal(result.inserted, 1);
  assert.equal(result.to, "active");
  assert.equal(store.rows("send_queue").length, 1);

  const campaign = store.rows("campaigns").find((c) => c.id === campaignId);
  assert.equal(campaign.status, "active", "activation must walk the real campaign_transition_status fallback to active");
});

// ── 10. Duplicate execution ──────────────────────────────────────────────────

test("duplicate execution: re-running campaign build for an already-queued contact creates no duplicate active queue row", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));

  const input = { now: NOW, first_scheduled_at: NOW, explicit_operator_action: true };
  const first = await createCampaignQueuePlan(campaignId, input, deps);
  assert.equal(first.send_queue_rows_created, 1);

  // Simulate the real buildCampaignTargets re-run this dedupe layer must
  // survive: it deletes and reinserts fresh campaign_targets rows with
  // target_status='ready' every time it runs, regardless of prior send_queue
  // history — so a second "build" legitimately re-presents the same contact
  // as ready. Reproduced here as a second target row for the same
  // master_owner/phone (a new id, exactly as a fresh insert would produce).
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1_rebuilt", campaign_id: campaignId }));

  const second = await createCampaignQueuePlan(campaignId, input, deps);
  assert.equal(second.send_queue_rows_created, 0, "the same phone must never be queued twice by a re-run");
  assert.equal(second.skipped_counts_by_reason.active_queue_row_exists, 1);

  const queueRows = store.rows("send_queue");
  assert.equal(queueRows.length, 1, "no duplicate active queue row may exist after re-running the build");
});

// ── 1-5. Owner / identity verification ───────────────────────────────────────
// Reuses evaluatePreSendEligibility (presend-eligibility-engine.js) — the
// same canonical, pure, deterministic gate deterministic-launch-lifecycle-
// core.test.mjs already proves is the real guard the rest of the outbound
// system applies before a cold message is auto-sent.

test("owner verification: renter is blocked with an explicit RENTER_NOT_OWNER reason, zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_renter",
    campaign_id: campaignId,
    to_phone_number: "+15551230003",
    identity_status: "unknown",
    candidate_snapshot: { likely_owner: false, likely_renting: true },
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0, "a renter must never reach send_queue");
  assert.equal(result.skipped_counts_by_reason[BLOCK_REASONS.RENTER_NOT_OWNER], 1);
  assert.equal(result.sample_skips[0].likely_renting, true);
});

test("owner verification: explicit non-owner / identity mismatch is blocked, zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_not_owner",
    campaign_id: campaignId,
    to_phone_number: "+15551230004",
    identity_status: "mismatch",
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason[BLOCK_REASONS.IDENTITY_MISMATCH], 1);
});

test("owner verification: ambiguous/unverified identity is blocked, zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_ambiguous",
    campaign_id: campaignId,
    to_phone_number: "+15551230005",
    identity_status: "unknown",
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason[BLOCK_REASONS.OWNERSHIP_NOT_CONFIRMED], 1);
});

test("owner verification: missing owner-identity evidence blocks queueing (structural gate, unchanged)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_no_owner",
    campaign_id: campaignId,
    master_owner_id: null,
    to_phone_number: "+15551230002",
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(result.skipped_counts_by_reason.missing_master_owner_id, 1);
  assert.equal(store.rows("send_queue").length, 0);
});

test("owner verification: a verified owner is not affected by the new gate (control case)", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_verified",
    campaign_id: campaignId,
    to_phone_number: "+15551230006",
    identity_status: "verified",
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.send_queue_rows_created, 1, "a genuinely verified owner must still be queued");
  assert.equal(store.rows("send_queue").length, 1);
});

// ── 6. Suppressed / contactability ───────────────────────────────────────────

test("suppressed: opt-out, wrong-number, never-owned, sold-property, and do-not-text all create zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  // wrong-number: an inbound reply already established this number is wrong.
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_wrong_number",
    campaign_id: campaignId,
    to_phone_number: "+15551230010",
    outreach_snapshot: { wrong_number: true },
  }));
  // opt-out / do-not-text: true_post_contact_suppression is the real
  // production flag for a permanent post-contact suppression (STOP / DNC /
  // do-not-text) — see writeOutboundSuccessMessageEvent / classify.js compliance routing.
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_opt_out",
    campaign_id: campaignId,
    to_phone_number: "+15551230011",
    outreach_snapshot: { true_post_contact_suppression: true },
  }));
  // never-owned / sold-property (former owner): classify.js explicitly routes
  // "sold/never_owned/not_owner" replies to the same wrong_number suppression
  // — reused here as-is, not a new vocabulary.
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_sold_property",
    campaign_id: campaignId,
    to_phone_number: "+15551230013",
    outreach_snapshot: { wrong_number: true },
  }));
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_never_owned",
    campaign_id: campaignId,
    to_phone_number: "+15551230014",
    outreach_snapshot: { wrong_number: true },
  }));
  // already-contacted (prior-touch suppression, a distinct but related guard).
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_already_touched",
    campaign_id: campaignId,
    to_phone_number: "+15551230012",
    outreach_snapshot: { never_contacted: false, touch_count: 1 },
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0, "no suppressed contact may ever reach send_queue");
  assert.equal(result.skipped_counts_by_reason.graph_suppression_or_queue_block, 4, "wrong_number x3 + true_post_contact_suppression x1");
  assert.equal(result.skipped_counts_by_reason.prior_contacted_suppression, 1);
});

// ── 5. Missing dependency ───────────────────────────────────────────────────

test("missing dependency: no active template fails closed with an explicit reason", async () => {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_no_template");
  store.seedRow("campaigns", campaign);
  store.seedRow("textgrid_numbers", { ...BASE_TEXTGRID_NUMBER });
  // Deliberately no sms_templates row seeded.
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaign.id }));
  const deps = makeCampaignQueuePlanDeps(store);

  const result = await createCampaignQueuePlan(campaign.id, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.sample_skips[0].reason, "NO_TEMPLATE");
});

test("missing dependency: no active sending number fails closed with an explicit reason", async () => {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_no_number");
  store.seedRow("campaigns", campaign);
  store.seedRow("sms_templates", { ...BASE_TEMPLATE });
  // Deliberately no textgrid_numbers row seeded.
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaign.id }));
  const deps = makeCampaignQueuePlanDeps(store);

  const result = await createCampaignQueuePlan(campaign.id, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.send_queue_rows_created, 0);
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.sample_skips[0].reason, "NO_VALID_TEXTGRID_NUMBER");
});

// ── 7, 8, 9. Timezone ────────────────────────────────────────────────────────

test("timezone: a valid timezone produces a deterministic send window from a fixed `now`, with no Date.now dependency", async () => {
  const runOnce = async () => {
    const { store, deps, campaignId } = setup();
    store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));
    return createCampaignQueuePlan(campaignId, { now: NOW, first_scheduled_at: NOW, explicit_operator_action: true }, deps);
  };

  const runA = await runOnce();
  const runB = await runOnce();

  assert.equal(runA.send_queue_rows_created, 1);
  assert.equal(runB.send_queue_rows_created, 1);
  assert.equal(runA.first_scheduled_at, runB.first_scheduled_at, "identical fixed `now` must produce an identical schedule");
  assert.equal(runA.planned_windows[0].window_start_utc, runB.planned_windows[0].window_start_utc);
  assert.equal(runA.planned_windows[0].window_end_utc, runB.planned_windows[0].window_end_utc);
  assert.ok(runA.first_scheduled_at, "a schedule must actually be produced");
});

test("timezone: a missing timezone fails closed with an explicit reason, zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_no_tz",
    campaign_id: campaignId,
    to_phone_number: "+15551230020",
    timezone: null,
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0, "a missing timezone must fail closed, not default silently");
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason.missing_timezone, 1);
  assert.equal(result.sample_skips[0].reason, "missing_timezone");
});

test("timezone: an invalid (non-IANA) timezone fails closed with an explicit reason, zero queue rows", async () => {
  const { store, deps, campaignId } = setup();
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_bad_tz",
    campaign_id: campaignId,
    to_phone_number: "+15551230021",
    timezone: "Not/A/Real/Zone",
  }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);

  assert.equal(result.send_queue_rows_created, 0, "an invalid timezone must fail closed, not silently degrade");
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason.invalid_timezone, 1);
  assert.equal(result.sample_skips[0].reason, "invalid_timezone");
  assert.equal(result.sample_skips[0].supplied_timezone, "Not/A/Real/Zone");
});

// ── Campaign gating ───────────────────────────────────────────────────────

test("campaign gating: a draft campaign cannot dispatch through createCampaignQueuePlan", async () => {
  const { store, deps, campaignId } = setup({ status: "draft" });
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("campaign_status_not_queueable:draft"));
  assert.equal(store.rows("send_queue").length, 0);
});

test("campaign gating: a paused campaign cannot dispatch through createCampaignQueuePlan", async () => {
  const { store, deps, campaignId } = setup({ status: "paused" });
  store.seedRow("campaign_targets", makeReadyTarget({ id: "tgt_1", campaign_id: campaignId }));

  const result = await createCampaignQueuePlan(campaignId, { now: NOW, explicit_operator_action: true }, deps);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("campaign_status_not_queueable:paused"));
  assert.equal(store.rows("send_queue").length, 0);
});

test("campaign gating: activateCampaignWithHydration refuses a draft campaign with no targets", async () => {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_draft_empty", { status: "draft" });
  store.seedRow("campaigns", campaign);
  const deps = makeCampaignQueuePlanDeps(store);

  const result = await activateCampaignWithHydration(campaign.id, { now: NOW }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_targets");
  assert.equal(store.rows("send_queue").length, 0);
});

// ── 11. activateCampaignWithHydration must not activate on a fail-closed hydration ─
// Verifies the EXISTING lifecycle semantics (unchanged by this hardening
// pass): activateCampaignWithHydration recounts real send_queue rows after
// createCampaignQueuePlan runs and refuses to call activateCampaign() when
// that recount is zero — independent of *why* every target was blocked.

test("activateCampaignWithHydration: a campaign whose only target is blocked by owner verification must not become active", async () => {
  const { store, deps, campaignId } = setup({ status: "built" });
  store.seedRow("campaign_targets", makeReadyTarget({
    id: "tgt_renter",
    campaign_id: campaignId,
    to_phone_number: "+15551230030",
    identity_status: "unknown",
    candidate_snapshot: { likely_owner: false, likely_renting: true },
  }));

  const result = await activateCampaignWithHydration(campaignId, { now: NOW, batch_max: 5 }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.error, "activation_no_queue_rows");
  assert.equal(result.inserted, 0);
  assert.equal(store.rows("send_queue").length, 0);

  const campaign = store.rows("campaigns").find((c) => c.id === campaignId);
  assert.notEqual(campaign.status, "active", "a campaign must never reach active with zero real queue rows hydrated");
  assert.equal(campaign.status, "built", "status must remain unchanged when activation is refused");
});
