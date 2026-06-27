import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSellerInboundExecutionView } from "@/lib/domain/seller-flow/seller-inbound-execution-view.js";

test("ownership dry-run exposes planned queue intent without applied queue row", () => {
  const view = normalizeSellerInboundExecutionView({
    writes_suppressed: true,
    canonical_decision: {
      should_queue_reply: true,
      next_action: "ask_offer_interest",
    },
    decision: {
      immediate_next_action: "queue_auto_reply",
    },
    execution: {
      queued: false,
      dry_run: true,
      automation_decision: {
        should_queue_reply: true,
        route_hint: "consider_selling",
      },
      selected_template: {
        use_case: "consider_selling",
        stage_code: "S2",
      },
      rendered_message_text:
        "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look?",
    },
    follow_up: {
      ok: true,
      skipped: true,
      reason: "not_attempted",
    },
  });

  assert.equal(view.queued, true);
  assert.equal(view.queue_row_created, false);
  assert.equal(view.followup_scheduled, false);
  assert.equal(view.followup_created, false);
  assert.equal(view.effective_action, "queue_planned");
  assert.equal(view.execution.queued, true);
  assert.equal(view.execution.queue_row_created, false);
  assert.equal(view.execution.writes_suppressed, true);
});

test("not_interested dry-run exposes planned follow-up without applied followup row", () => {
  const view = normalizeSellerInboundExecutionView({
    writes_suppressed: true,
    canonical_decision: {
      should_queue_reply: false,
      next_action: "schedule_later_followup",
      follow_up_at: "2026-09-27T12:00:00.000Z",
    },
    decision: {
      immediate_next_action: "schedule_later_followup",
      follow_up_at: "2026-09-27T12:00:00.000Z",
    },
    execution: {
      queued: false,
      dry_run: true,
      automation_decision: {
        should_queue_reply: false,
      },
    },
    follow_up: {
      ok: true,
      skipped: false,
      shadow_only: true,
      followup_created: false,
      scheduled_for: "2026-09-27T12:00:00.000Z",
      reason: "followup_preview_writes_suppressed",
    },
    contract: {
      ownership_probe_transition: {
        follow_up_at: "2026-09-27T12:00:00.000Z",
      },
    },
  });

  assert.equal(view.queued, false);
  assert.equal(view.followup_scheduled, true);
  assert.equal(view.followup_created, false);
  assert.equal(view.effective_action, "followup_planned");
  assert.equal(view.follow_up.followup_scheduled, true);
  assert.equal(view.follow_up.followup_created, false);
});

test("live queue path preserves applied queue row semantics", () => {
  const view = normalizeSellerInboundExecutionView({
    writes_suppressed: false,
    execution: {
      queued: true,
      queue_row_id: "queue-123",
      automation_decision: {
        should_queue_reply: true,
      },
    },
    follow_up: {
      ok: true,
      skipped: true,
      reason: "not_attempted",
    },
  });

  assert.equal(view.queued, true);
  assert.equal(view.queue_row_created, true);
  assert.equal(view.effective_action, "queued");
});