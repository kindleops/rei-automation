import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeReplaceableExpiredTargets,
  isRecoveryCandidateExpiredRow,
} from "@/lib/domain/campaigns/campaign-stale-expiration-recovery.js";

test("isRecoveryCandidateExpiredRow rejects sent evidence and proof rows", () => {
  assert.equal(
    isRecoveryCandidateExpiredRow({
      queue_status: "expired",
      failed_reason: "stale_runnable_row_expired",
      to_phone_number: "+15551234567",
    }),
    true
  );
  assert.equal(
    isRecoveryCandidateExpiredRow({
      queue_status: "expired",
      failed_reason: "stale_runnable_row_expired",
      to_phone_number: "+15551234567",
      sent_at: "2026-07-01T00:00:00.000Z",
    }),
    false
  );
  assert.equal(
    isRecoveryCandidateExpiredRow({
      queue_status: "expired",
      failed_reason: "stale_runnable_row_expired",
      to_phone_number: "+15551234567",
      metadata: { launch_mode: "proof_hydration_no_send" },
    }),
    false
  );
});

test("analyzeReplaceableExpiredTargets dedupes by target and excludes active/sent rows", async () => {
  const campaignId = "campaign-1";
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({
                data: [
                  {
                    id: "exp-1",
                    campaign_id: campaignId,
                    campaign_target_id: "target-a",
                    to_phone_number: "+15551111111",
                    queue_status: "expired",
                    failed_reason: "stale_runnable_row_expired",
                    scheduled_for: "2026-07-01T15:10:00.000Z",
                    created_at: "2026-07-01T04:00:00.000Z",
                    updated_at: "2026-07-01T04:45:00.000Z",
                    metadata: {},
                  },
                  {
                    id: "exp-dup",
                    campaign_id: campaignId,
                    campaign_target_id: "target-a",
                    to_phone_number: "+15551111111",
                    queue_status: "expired",
                    failed_reason: "stale_runnable_row_expired",
                    scheduled_for: "2026-07-01T15:11:00.000Z",
                    created_at: "2026-07-01T04:00:00.000Z",
                    updated_at: "2026-07-01T04:40:00.000Z",
                    metadata: {},
                  },
                  {
                    id: "sent-1",
                    campaign_id: campaignId,
                    campaign_target_id: "target-b",
                    to_phone_number: "+15552222222",
                    queue_status: "sent",
                    sent_at: "2026-07-01T01:00:00.000Z",
                    provider_message_id: "prov-1",
                    metadata: {},
                  },
                  {
                    id: "active-1",
                    campaign_id: campaignId,
                    campaign_target_id: "target-c",
                    to_phone_number: "+15553333333",
                    queue_status: "scheduled",
                    scheduled_for: "2026-07-01T15:20:00.000Z",
                    metadata: {},
                  },
                  {
                    id: "exp-2",
                    campaign_id: campaignId,
                    campaign_target_id: "target-c",
                    to_phone_number: "+15553333333",
                    queue_status: "expired",
                    failed_reason: "stale_runnable_row_expired",
                    scheduled_for: "2026-07-01T15:05:00.000Z",
                    created_at: "2026-07-01T04:00:00.000Z",
                    updated_at: "2026-07-01T04:45:00.000Z",
                    metadata: {},
                  },
                ],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  const analysis = await analyzeReplaceableExpiredTargets(campaignId, { supabase });
  assert.equal(analysis.unique_expired_targets, 2);
  assert.equal(analysis.replaceable_unique_targets, 1);
  assert.equal(analysis.replaceable[0].row.id, "exp-1");
  assert.equal(analysis.sent_unique_targets, 1);
  assert.equal(analysis.active_unique_targets, 1);
});