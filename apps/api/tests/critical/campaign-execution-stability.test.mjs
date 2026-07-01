import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_MODES,
  resolveCampaignExecutionMode,
  validateQueueRowAgainstExecutionMode,
} from "@/lib/domain/campaigns/campaign-execution-mode.js";
import { normalizeCanonicalCampaignWrite, normalizeCanonicalMarket } from "@/lib/domain/campaigns/campaign-canonical-write.js";
import { normalizeCampaignStageCode } from "@/lib/domain/campaigns/campaign-stage-code.js";
import { markWebhookLogProcessed } from "@/lib/supabase/sms-engine.js";

test("resolveCampaignExecutionMode distinguishes proof and live", () => {
  assert.equal(
    resolveCampaignExecutionMode({ status: "draft" }, { proof_hydration: true }),
    EXECUTION_MODES.proof
  );
  assert.equal(
    resolveCampaignExecutionMode(
      { status: "active", metadata: { production_launch: true, converted_to_live_at: "2026-01-01" } },
      { confirm_live: true }
    ),
    EXECUTION_MODES.immediate_live
  );
});

test("validateQueueRowAgainstExecutionMode rejects contradictory flags", () => {
  const result = validateQueueRowAgainstExecutionMode(
    { metadata: { no_send: true, confirm_live: true, proof_hydration: true } },
    EXECUTION_MODES.immediate_live
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "live_row_contains_proof_flags");
});

test("normalizeCanonicalCampaignWrite canonicalizes stage and market aliases", () => {
  const patch = normalizeCanonicalCampaignWrite(
    { market: "la", stage_code: "first_touch" },
    { objective: "ownership_check", metadata: {} }
  );
  assert.equal(patch.market, "Los Angeles, CA");
  assert.equal(patch.metadata.stage_code, "S1");
  assert.equal(normalizeCanonicalMarket("miami fl"), "Miami, FL");
  assert.equal(normalizeCampaignStageCode("s1_ownership"), "S1");
});

test("markWebhookLogProcessed accepts UUID webhook log ids", async () => {
  const webhookId = "634cdcd2-f80d-438f-be79-782afa076558";
  let updatedId = null;
  await markWebhookLogProcessed(webhookId, {
    markWebhookLogProcessed: async (id) => {
      updatedId = id;
      return { id, processed: true };
    },
  });
  assert.equal(updatedId, webhookId);
});

test("enqueueSendQueueItem rejects contradictory execution mode flags", async () => {
  const { enqueueSendQueueItem } = await import("@/lib/supabase/sms-engine.js");
  const result = await enqueueSendQueueItem({
    queue_status: "scheduled",
    to_phone_number: "+15551234567",
    from_phone_number: "+15559876543",
    message_body: "test",
    metadata: {
      execution_mode: "immediate_live",
      no_send: true,
      confirm_live: true,
      proof_hydration: true,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "live_execution_mode_with_proof_flags");
});