import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateScopedCanaryCandidates,
  isProofOrNoSendQueueRow,
  loadScopedCanaryRows,
  parseScopedCanaryRequest,
  SCOPED_CANARY_MAX_ROWS,
  validateScopedCanaryAllowlist,
} from "@/lib/domain/queue/run-scoped-campaign-canary.js";
import {
  normalizeSendQueueRow,
  validateSendQueueRowPreclaim,
} from "@/lib/supabase/sms-engine.js";

const CAMPAIGN_A = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";
const CAMPAIGN_B = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-06-25T18:00:00.000Z";

function liveRow(id, campaignId = CAMPAIGN_A, overrides = {}) {
  return normalizeSendQueueRow({
    id,
    campaign_id: campaignId,
    queue_status: "queued",
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
    message_body: "Hi Alex, checking ownership for 123 Main St.",
    to_phone_number: "+13053315715",
    from_phone_number: "+17866052999",
    template_id: "840906",
    seller_first_name: "Berta",
    sms_eligible: true,
    routing_allowed: true,
    metadata: {
      no_send: false,
      launch_mode: "guarded_live_queue_creation",
      candidate_snapshot: {
        master_owner_id: "mo_1",
        property_id: "prop_1",
        phone_id: "ph_1",
        seller_first_name: "Berta",
        touch_number: 1,
      },
    },
    ...overrides,
  });
}

function makeSupabase(rowsById = new Map()) {
  return {
    from(table) {
      assert.equal(table, "send_queue");
      const filters = { ids: null, campaign_id: null, not_null_campaign: false };
      const builder = {
        select() {
          return builder;
        },
        in(_field, ids) {
          filters.ids = ids;
          return builder;
        },
        eq(field, value) {
          if (field === "campaign_id") filters.campaign_id = value;
          return builder;
        },
        not(field, op) {
          if (field === "campaign_id" && op === "is") filters.not_null_campaign = true;
          return builder;
        },
        then(resolve, reject) {
          const rows = [...rowsById.values()].filter((row) => {
            if (filters.ids && !filters.ids.includes(row.id)) return false;
            if (filters.campaign_id && row.campaign_id !== filters.campaign_id) return false;
            if (filters.not_null_campaign && !row.campaign_id) return false;
            return true;
          });
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

test("parseScopedCanaryRequest requires campaign, ids, and canary_run_id", () => {
  const parsed = parseScopedCanaryRequest({
    scoped_canary: true,
    campaign_id: CAMPAIGN_A,
    queue_row_ids: ["a", "b"],
    canary_run_id: "canary-1",
    validate_only: true,
  });
  assert.equal(parsed.scoped, true);
  assert.equal(parsed.validate_only, true);
  assert.equal(parsed.max_rows, 2);
});

test("validateScopedCanaryAllowlist rejects null-campaign and wrong-campaign rows", () => {
  const nullCampaign = validateScopedCanaryAllowlist(
    [liveRow("row-1", null)],
    { campaign_id: CAMPAIGN_A, queue_row_ids: ["row-1"], max_rows: 5 }
  );
  assert.equal(nullCampaign.ok, false);
  assert.equal(nullCampaign.reason, "scoped_canary_null_campaign_row");

  const wrongCampaign = validateScopedCanaryAllowlist(
    [liveRow("row-1", CAMPAIGN_B)],
    { campaign_id: CAMPAIGN_A, queue_row_ids: ["row-1"], max_rows: 5 }
  );
  assert.equal(wrongCampaign.ok, false);
  assert.equal(wrongCampaign.reason, "scoped_canary_wrong_campaign_row");
});

test("validateScopedCanaryAllowlist rejects proof rows and completed rows", () => {
  const proof = validateScopedCanaryAllowlist(
    [liveRow("row-1", CAMPAIGN_A, { metadata: { no_send: true, candidate_snapshot: { seller_first_name: "A" } } })],
    { campaign_id: CAMPAIGN_A, queue_row_ids: ["row-1"], max_rows: 5 }
  );
  assert.equal(proof.ok, false);
  assert.equal(proof.reason, "scoped_canary_proof_row_excluded");
  assert.equal(isProofOrNoSendQueueRow({ metadata: { proof_hydration: true } }), true);

  const completed = validateScopedCanaryAllowlist(
    [liveRow("row-1", CAMPAIGN_A, { queue_status: "delivered" })],
    { campaign_id: CAMPAIGN_A, queue_row_ids: ["row-1"], max_rows: 5 }
  );
  assert.equal(completed.ok, false);
  assert.equal(completed.reason, "scoped_canary_completed_row_excluded");
});

test("loadScopedCanaryRows claims only explicit allowlisted campaign rows", async () => {
  const rows = new Map([
    ["row-1", liveRow("row-1")],
    ["row-2", liveRow("row-2")],
    ["row-null", liveRow("row-null", null)],
    ["row-other", liveRow("row-other", CAMPAIGN_B)],
    ["row-sent", liveRow("row-sent", CAMPAIGN_A, { queue_status: "sent" })],
  ]);
  const supabase = makeSupabase(rows);

  const ok = await loadScopedCanaryRows(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ["row-1", "row-2"],
      max_rows: 2,
      canary_run_id: "canary-allowlist",
    },
    { supabase }
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows.map((row) => row.id), ["row-1", "row-2"]);

  const sixth = await loadScopedCanaryRows(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"],
      max_rows: 6,
      canary_run_id: "canary-too-many",
    },
    { supabase }
  );
  assert.equal(sixth.ok, false);
  assert.equal(sixth.reason, "queue_row_ids_exceeds_max_rows");

  const missing = await loadScopedCanaryRows(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ["row-1", "row-missing"],
      max_rows: 2,
      canary_run_id: "canary-missing",
    },
    { supabase }
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "scoped_canary_row_not_found_or_wrong_campaign");
});

test("validateSendQueueRowPreclaim fails closed without candidate_snapshot", () => {
  const missing = validateSendQueueRowPreclaim(
    normalizeSendQueueRow({
      id: "row-bad",
      queue_status: "queued",
      scheduled_for: NOW,
      message_body: "Hello",
      to_phone_number: "+13053315715",
      from_phone_number: "+17866052999",
      template_id: "840906",
      seller_first_name: "Berta",
      metadata: {},
    }),
    NOW
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_candidate_snapshot");
});

test("evaluateScopedCanaryCandidates returns exact authorized candidate ids", async () => {
  const ids = ["row-1", "row-2", "row-3", "row-4", "row-5"];
  const rows = new Map(ids.map((id) => [id, liveRow(id)]));
  const supabase = makeSupabase(rows);

  const result = await evaluateScopedCanaryCandidates(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ids,
      max_rows: 5,
      canary_run_id: "canary-eval",
      validate_only: true,
    },
    { supabase, now: NOW }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.candidate_ids, ids);
  assert.equal(result.candidate_ids.length, 5);
});