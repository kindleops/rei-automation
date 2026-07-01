import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCampaignLaunchReadiness,
  resolveLaunchReadinessContext,
} from "@/lib/domain/campaigns/campaign-launch-readiness.js";
import {
  evaluateGlobalSendBrakeState,
  filterRowsByLiveCampaigns,
  shouldHoldRowFromStaleExpiration,
} from "@/lib/domain/queue/queue-send-brake-state.js";
import { filterRowsByLiveCampaigns as runQueueCampaignFilter } from "@/lib/domain/queue/run-send-queue.js";
import {
  buildQueueRowForLaunch,
  candidateSnapshotForMetadata,
  computeWindowForTimezone,
  resolveCampaignQueueWriteMode,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  normalizeSendQueueRow,
  reconcileCanonicalQueueLifecycle,
  isRowEligibleForStaleExpiration,
  isReplaceableStaleExpiredQueueRow,
  shouldRunSendQueueRow,
  validateSendQueueRowPreclaim,
} from "@/lib/supabase/sms-engine.js";
import { buildScheduledActivationRequest } from "@/lib/domain/campaigns/campaign-activation-orchestrator.js";
import { makeTerminalQuery } from "../helpers/chainable-supabase.mjs";

test("guarded live launch does not require auto_send_enabled", () => {
  const context = resolveLaunchReadinessContext({
    confirm_live: true,
    no_send: false,
    explicit_operator_action: true,
  });
  assert.equal(context.guarded_live_launch, true);
  assert.equal(context.controlled_hydration, true);
});

test("live activation write mode uses no_send false", () => {
  const mode = resolveCampaignQueueWriteMode({
    dry_run: false,
    no_send: false,
    confirm_live: true,
    create_send_queue_rows: true,
  });
  assert.equal(mode.noSend, false);
  assert.equal(mode.isLiveSendWrite, true);
  assert.equal(mode.isProofHydrationWrite, false);
});

test("test activation write mode uses no_send true", () => {
  const mode = resolveCampaignQueueWriteMode({
    dry_run: false,
    no_send: true,
    confirm_live: true,
    hydrate_canonical_queue: true,
    create_send_queue_rows: true,
  });
  assert.equal(mode.noSend, true);
  assert.equal(mode.isLiveSendWrite, false);
  assert.equal(mode.isProofHydrationWrite, true);
});

test("controlled hydration warns on brakes but does not block auto_send false", async () => {
  const campaignId = "camp-readiness-1";
  const supabase = {
    from(table) {
      if (table === "campaigns") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: campaignId,
                  status: "scheduled",
                  auto_send_enabled: false,
                  auto_queue_enabled: false,
                  daily_cap: 5,
                  batch_max: 5,
                  market_cap: 5,
                  per_sender_cap: 5,
                  contact_window_start: "09:00",
                  contact_window_end: "20:00",
                  metadata: { stage_code: "S1", template_use_case: "ownership_check" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "campaign_targets") {
        const terminal = {
          eq: () => terminal,
          order: () => ({
            limit: async () => ({ data: [], count: 0, error: null }),
          }),
          limit: async () => ({ data: [], count: 0, error: null }),
          head: true,
          then(resolve) {
            return Promise.resolve({ count: 0, error: null }).then(resolve);
          },
        };
        return {
          select: () => ({
            eq: () => terminal,
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              head: true,
              limit: async () => ({ count: 0, error: null }),
            }),
            head: true,
            limit: async () => ({ count: 0, error: null }),
          }),
          head: true,
          limit: async () => ({ count: 0, error: null }),
        }),
      };
    },
  };

  const readiness = await evaluateCampaignLaunchReadiness(
    campaignId,
    {
      supabase,
      getSystemValue: async (key) => {
        if (key === "queue_emergency_stop_at") return "2026-05-30T00:00:00.000Z";
        if (key === "queue_processor_mode") return "off";
        if (key === "queue_auto_enqueue_enabled") return "false";
        if (key === "outbound_sms_enabled") return "true";
        return null;
      },
      renderOutboundTemplate: async () => ({
        ok: true,
        selected_template_id: "tpl-1",
        template: { template_id: "tpl-1" },
      }),
    },
    {
      confirm_live: true,
      guarded_live_launch: true,
      scheduled_activation: true,
    },
  );

  assert.ok(!readiness.blocker_codes.includes("transmission_disabled"));
  assert.ok(!readiness.blocker_codes.includes("global_auto_enqueue_disabled"));
  assert.ok(!readiness.blocker_codes.includes("campaign_auto_queue_disabled"));
  assert.ok(!readiness.blocker_codes.includes("emergency_stop"));
  assert.ok(!readiness.blocker_codes.includes("queue_processor_disabled"));
  assert.ok(readiness.warnings.some((w) => w.includes("Emergency stop")));
});

test("campaign status gating holds non-live campaign rows", () => {
  const rows = [
    { id: "1", campaign_id: "live-camp", metadata: {} },
    { id: "2", campaign_id: "paused-camp", metadata: {} },
    { id: "3", metadata: {} },
  ];
  const liveIds = new Set(["live-camp"]);
  const filtered = filterRowsByLiveCampaigns(rows, liveIds);
  assert.deepEqual(filtered.map((row) => row.id), ["1", "3"]);
  assert.deepEqual(runQueueCampaignFilter(rows, liveIds).map((row) => row.id), ["1", "3"]);
});

test("future scheduled rows are never eligible for stale expiration", () => {
  const row = {
    queue_status: "scheduled",
    created_at: "2026-07-01T01:57:52.000Z",
    updated_at: "2026-07-01T01:57:52.000Z",
    scheduled_for: "2026-07-01T02:19:52.000Z",
    sms_eligible: true,
    metadata: {},
  };
  assert.equal(
    isRowEligibleForStaleExpiration(row, {
      now: "2026-07-01T02:00:53.000Z",
      stale_minutes: 3,
    }),
    false,
  );
});

test("future scheduled rows with Supabase +00 offset timestamps stay protected", () => {
  const row = {
    queue_status: "scheduled",
    created_at: "2026-07-01T02:36:08.475686+00",
    updated_at: "2026-07-01T02:36:08.475686+00",
    scheduled_for_utc: "2026-07-01T02:51:27.739+00",
    scheduled_for: "2026-07-01 02:51:27.739+00",
    metadata: {},
  };
  assert.equal(
    isRowEligibleForStaleExpiration(row, {
      now: "2026-07-01T02:45:51.000Z",
      stale_minutes: 20,
    }),
    false,
  );
});

test("scheduled rows are never eligible for stale expiration even when past due", () => {
  const row = {
    queue_status: "scheduled",
    created_at: "2026-07-01T01:57:52.000Z",
    updated_at: "2026-07-01T01:57:52.000Z",
    scheduled_for: "2026-07-01T02:19:52.000Z",
    sms_eligible: true,
    metadata: {},
  };
  assert.equal(
    isRowEligibleForStaleExpiration(row, {
      now: "2026-07-01T02:45:00.000Z",
      stale_minutes: 20,
    }),
    false,
  );
});

test("production timestamp shapes many hours in the future remain ineligible", () => {
  const shapes = [
    { scheduled_for: "2026-07-01T15:24:15+00" },
    { scheduled_for: "2026-07-01T15:24:15+00:00" },
    { scheduled_for: "2026-07-01 15:24:15+00" },
    { scheduled_for_utc: "2026-07-01T15:24:15+00", scheduled_for: "2026-07-01 15:24:15+00" },
  ];
  for (const schedule of shapes) {
    const row = {
      queue_status: "scheduled",
      created_at: "2026-07-01T04:36:08.475686+00",
      updated_at: "2026-07-01T04:36:08.475686+00",
      metadata: {},
      ...schedule,
    };
    assert.equal(
      isRowEligibleForStaleExpiration(row, {
        now: "2026-07-01T04:45:50.000Z",
        stale_minutes: 20,
      }),
      false,
      `expected ineligible for ${JSON.stringify(schedule)}`,
    );
  }
});

test("queued rows are never eligible for stale expiration", () => {
  const row = {
    queue_status: "queued",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    scheduled_for: "2026-06-01T01:00:00.000Z",
    metadata: {},
  };
  assert.equal(
    isRowEligibleForStaleExpiration(row, {
      now: "2026-07-01T04:45:50.000Z",
      stale_minutes: 20,
    }),
    false,
  );
});

test("stale_runnable_row_expired without send evidence is replaceable", () => {
  assert.equal(
    isReplaceableStaleExpiredQueueRow({
      queue_status: "expired",
      failed_reason: "stale_runnable_row_expired",
      sent_at: null,
      provider_message_id: null,
    }),
    true,
  );
  assert.equal(
    isReplaceableStaleExpiredQueueRow({
      queue_status: "expired",
      failed_reason: "stale_runnable_row_expired",
      sent_at: "2026-07-01T03:00:00.000Z",
    }),
    false,
  );
});

test("emergency-stop recovery does not expire held runnable rows", async () => {
  const updates = [];
  const row = {
    id: "row-1",
    queue_status: "scheduled",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    scheduled_for_utc: "2026-06-01T01:00:00.000Z",
    sms_eligible: true,
    campaign_id: "camp-1",
    metadata: {},
    retry_count: 0,
    max_retries: 3,
  };
  const supabase = {
    from(table) {
      if (table === "send_queue") {
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                limit: async () => ({ data: [row], error: null }),
              }),
            }),
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
          update: (patch) => ({
            eq: async (col, id) => {
              updates.push({ id, patch });
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "campaigns") {
        return {
          select: () => ({
            in: async () => ({ data: [{ id: "camp-1", status: "active" }], error: null }),
          }),
        };
      }
      return makeTerminalQuery();
    },
  };

  const result = await reconcileCanonicalQueueLifecycle({
    supabase,
    now: "2026-06-01T00:30:00.000Z",
    stale_minutes: 180,
    queue_emergency_stop_at: "2026-05-30T00:00:00.000Z",
    queue_processor_mode: "off",
  });

  assert.ok(result.brake_held_rows >= 1);
  assert.ok(updates.some((entry) => entry.patch?.metadata?.send_brake_hold === true));
  assert.equal(updates.some((entry) => entry.patch?.queue_status === "expired"), false);
});

test("reconcile does not expire future-scheduled LA-style rows at reconcile time", async () => {
  const updates = [];
  const row = {
    id: "la-row-1",
    queue_status: "scheduled",
    created_at: "2026-07-01T01:57:52.000Z",
    updated_at: "2026-07-01T01:57:52.000Z",
    scheduled_for: "2026-07-01T02:19:52.000Z",
    sms_eligible: true,
    routing_allowed: true,
    campaign_id: "b821cb13-deeb-4ab4-9505-01dbcdaa136d",
    metadata: { confirm_live: true, no_send: false },
    retry_count: 0,
    max_retries: 3,
  };
  const supabase = {
    from(table) {
      if (table === "send_queue") {
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                limit: async () => ({ data: [row], error: null }),
              }),
            }),
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
          update: (patch) => ({
            eq: async (col, id) => {
              updates.push({ id, patch });
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "campaigns") {
        return {
          select: () => ({
            in: async () => ({
              data: [{ id: "b821cb13-deeb-4ab4-9505-01dbcdaa136d", status: "active" }],
              error: null,
            }),
          }),
        };
      }
      return makeTerminalQuery();
    },
  };

  const result = await reconcileCanonicalQueueLifecycle({
    supabase,
    now: "2026-07-01T02:00:53.000Z",
    stale_minutes: 3,
    queue_processor_mode: "normal",
  });

  assert.equal(result.stale_rows, 0);
  assert.equal(updates.some((entry) => entry.patch?.queue_status === "expired"), false);
});

test("contact-window scheduling preserves operator intent inside window", () => {
  const campaign = { contact_window_start: "09:00", contact_window_end: "20:00" };
  const scheduleBase = new Date("2026-06-21T14:00:00.000Z");
  const window = computeWindowForTimezone("America/New_York", campaign, scheduleBase);
  const startMs = Math.max(new Date(window.window_start_utc).getTime(), scheduleBase.getTime() + 10 * 60 * 1000);
  assert.ok(startMs >= scheduleBase.getTime());
  assert.ok(startMs <= new Date(window.window_end_utc).getTime());
});

test("scheduled activation passes first_scheduled_at and live hydration", () => {
  const campaign = {
    id: "camp-scheduled",
    scheduled_for: "2026-06-20T23:45:00.000Z",
    batch_max: 5,
  };
  const request = buildScheduledActivationRequest(campaign);
  assert.equal(request.no_send, false);
  assert.equal(request.confirm_live, true);
  assert.equal(request.first_scheduled_at, campaign.scheduled_for);
  assert.equal(request.scheduled_activation, true);
  assert.equal(request.lock_owner, "scheduled_worker");
});

test("duplicate hydration prevention remains idempotent for active campaign", async () => {
  const campaignId = "camp-idempotent";
  const supabase = {
    from(table) {
      if (table === "campaigns") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: campaignId,
                  status: "active",
                  activated_at: "2026-06-21T00:00:00.000Z",
                  queued_count: 5,
                  last_activation_idempotency_key: "scheduled:camp:ts",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "send_queue") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                head: true,
                limit: async () => ({ count: 5, error: null }),
              }),
            }),
          }),
        };
      }
      return makeTerminalQuery();
    },
  };

  const { runCanonicalCampaignActivation } = await import("@/lib/domain/campaigns/campaign-activation-orchestrator.js");
  const result = await runCanonicalCampaignActivation(
    campaignId,
    { activation_idempotency_key: "new-key" },
    {
      supabase,
      recomputeCampaignProgress: async () => ({ ok: true }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.inserted, 0);
});

test("global brake state detects emergency stop and paused processor", () => {
  const state = evaluateGlobalSendBrakeState({
    queue_emergency_stop_at: "2026-05-30T00:00:00.000Z",
    queue_processor_mode: "off",
  });
  assert.equal(state.send_blocked, true);
  assert.equal(state.emergency_stop_active, true);
  assert.equal(state.processor_paused, true);
});

test("paused campaign rows are held from stale expiration", () => {
  const hold = shouldHoldRowFromStaleExpiration(
    { campaign_id: "camp-1", sms_eligible: true, metadata: {} },
    { brakeState: { send_blocked: false }, campaignStatus: "paused" },
  );
  assert.equal(hold, true);
});

test("buildQueueRowForLaunch writes top-level candidate_snapshot for live activation rows", () => {
  const candidate = {
    master_owner_id: "mo_canary_1",
    prospect_id: "pros_canary_1",
    property_id: "prop_canary_1",
    phone_id: "ph_canary_1",
    canonical_e164: "+13053315715",
    market: "Miami, FL",
    state: "FL",
    seller_first_name: "Berta",
    seller_full_name: "Berta A Negrin",
    touch_number: 1,
    template_use_case: "ownership_check",
    timezone: "America/New_York",
  };
  const built = buildQueueRowForLaunch({
    campaign: {
      id: "320c798a-84c9-45b8-a7c9-d166ddd7bd46",
      objective: "ownership_check",
      agent_persona: "Alex",
    },
    target: {
      id: "target-1",
      target_status: "ready",
      routing_status: "ready",
      template_status: "ready",
      market: "Miami, FL",
      state: "FL",
      owner_name: "Berta A Negrin",
    },
    candidate,
    routing: {
      ok: true,
      selected_textgrid_number: "+17866052999",
      selected_textgrid_number_id: "sender-1",
      selected_textgrid_market: "Miami, FL",
      routing_tier: "exact_market_match",
      routing_rule_name: "exact_market_match",
      selection_reason: "exact_market_match",
    },
    rendered: {
      ok: true,
      selected_template_id: "840906",
      rendered_message_body:
        "Hola Berta, soy Alex, un inversionista local en Miami. Quería confirmar si todavía eres el dueño de 2765 Nw 27th St.",
      template: { template_name: "ownership_check_owner_verify_es_v2", source: "sms_templates" },
      template_use_case: "ownership_check",
      language: "Spanish",
    },
    scheduledFor: "2026-06-25T18:00:00.000Z",
    window: {
      id: "window-1",
      timezone: "America/New_York",
      window_start_utc: "2026-06-25T12:00:00.000Z",
      window_end_utc: "2026-06-26T01:00:00.000Z",
      spread_interval_seconds: 60,
    },
    caps: { batch_max: 5, daily_cap: 5, per_sender_cap: 5, per_market_cap: 5, effective_limit: 5 },
    input: { campaign_session_id: "canary-test-session", confirm_live: true },
    noSend: false,
  });

  const row = normalizeSendQueueRow({
    id: "queue-canary-1",
    campaign_id: built.campaign_id,
    ...built,
  });

  assert.equal(built.metadata.candidate_snapshot?.master_owner_id, "mo_canary_1");
  assert.equal(built.metadata.candidate_snapshot?.seller_first_name, "Berta");
  assert.equal(built.metadata.target_snapshot?.campaign_target_id, "target-1");
  assert.equal(built.metadata.no_send, false);
  assert.equal(built.metadata.proof_hydration, false);

  const preclaim = validateSendQueueRowPreclaim(row, "2026-06-25T18:00:00.000Z");
  assert.equal(preclaim.ok, true, preclaim.reason || "launch row must pass send-time preclaim");
  const decision = shouldRunSendQueueRow(row, "2026-06-25T18:00:00.000Z");
  assert.equal(decision.ok, true, decision.reason || "expected runnable launch row");

  const missingSnapshot = validateSendQueueRowPreclaim(
    normalizeSendQueueRow({
      ...row,
      metadata: { ...row.metadata, candidate_snapshot: null },
    }),
    "2026-06-25T18:00:00.000Z"
  );
  assert.equal(missingSnapshot.ok, false);
  assert.equal(missingSnapshot.reason, "missing_candidate_snapshot");
});