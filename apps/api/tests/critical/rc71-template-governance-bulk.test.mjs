/**
 * RC 7.1 D8 — template governance on the bulk campaign plan path.
 *
 * createCampaignQueuePlan never consulted ownership_template_rotation_control:
 * 151 campaign sends (2026-09-28→09-30) used five templates governance paused
 * on 2026-05-16. Governed-but-not-sendable templates now leave the render pool
 * (rotation lands on a sendable sibling); a seller with nothing sendable left
 * is HELD (template_hold:TEMPLATE_GOVERNANCE_PAUSED), never dropped. Templates
 * with no governance row (never reviewed: 8,763 of 8,784) stay usable on this
 * path — that wider fail-closed rule is an owner decision.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCampaignQueuePlan } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { governanceExcludedTemplateIds, indexGovernance } from "@/lib/domain/campaigns/template-governance.js";
import { isTemplateHoldReason, loadTemplateCatalogFingerprint } from "@/lib/domain/campaigns/campaign-template-hold.js";
import { makeCampaignQueuePlanStore, makeCampaignQueuePlanDeps } from "../helpers/campaign-queue-plan-store.mjs";

const NOW = "2026-05-04T15:00:00.000Z"; // Monday 10:00 America/Chicago
const MIAMI = "Miami, FL";

const campaignRow = {
  id: "camp_1", name: "Governance", status: "built", objective: "ownership_check", market: MIAMI,
  auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: "disabled", emergency_stop_at: null,
  daily_cap: 750, total_cap: 1000, batch_max: 10, market_cap: 400, per_sender_cap: 150, send_interval_seconds: 45,
  contact_window_start: "08:00", contact_window_end: "21:00", language_policy: "auto",
  metadata: { stage_code: "S1", template_use_case: "ownership_check" }, scheduled_for: null, created_at: NOW, updated_at: NOW,
};

const target = (i) => ({
  id: `tgt_${i}`, campaign_id: "camp_1", target_status: "ready", routing_status: "ready", suppression_status: "clear",
  template_status: "pending", priority_score: 100 - i, master_owner_id: `mo_${i}`, prospect_id: `pr_${i}`,
  property_id: `prop_${i}`, to_phone_number: `+1555123${String(1000 + i).slice(-4)}`, market: MIAMI, state: "FL",
  timezone: "America/New_York", identity_status: "verified", language: null, owner_name: "John Smith",
  metadata: {
    candidate_snapshot: { seller_first_name: "John", seller_full_name: "John Smith", owner_display_name: "John Smith", property_address_full: `${i} Main St, Miami, FL 33101`, property_city: "Miami", property_zip: "33101" },
    outreach_snapshot: { never_contacted: true, touch_count: 0, true_post_contact_suppression: false, wrong_number: false, pending_prior_touch: false, active_queue_item: false },
  },
});

const template = (id) => ({
  id, template_id: id, is_active: true, use_case: "ownership_check", language: "English", stage_code: "S1", is_first_touch: true,
  template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?",
  allowed_property_groups: [], prohibited_property_groups: [],
});

const PAUSED_ROW = { template_id: "200049", rotation_status: "pause", language: "English", daily_cap: 0, last_40d_total_sent: null };
const TESTING_ROW = { template_id: "208481", rotation_status: "testing", language: "English", daily_cap: 25, last_40d_total_sent: null };

function setup({ templates, governance = [PAUSED_ROW, TESTING_ROW], targets = 3, extra = {} }) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", { ...campaignRow });
  for (const t of templates) store.seedRow("sms_templates", t);
  for (const g of governance) store.seedRow("ownership_template_rotation_control", g);
  store.seedRow("textgrid_numbers", {
    id: "tg_0100", phone_number: "+13055550100", market: MIAMI, status: "active", health_state: "unverified",
    cooling_until: null, daily_limit: 800, messages_sent_today: 0, last_used_at: null,
  });
  for (let i = 1; i <= targets; i += 1) store.seedRow("campaign_targets", target(i));
  const deps = makeCampaignQueuePlanDeps(store, {
    loadDispatchBlockedSets: async () => ({ template_ids: new Set(), sender_numbers: new Set() }),
    ...extra,
  });
  return { store, deps };
}

const live = {
  now: NOW, first_scheduled_at: NOW, explicit_operator_action: true, confirm_live: true,
  dry_run: false, create_send_queue_rows: true, no_send: false, batch_max: 10,
};

test("governance: only reviewed-and-refused templates are excluded; never-reviewed ones are not", () => {
  const excluded = governanceExcludedTemplateIds(indexGovernance([
    PAUSED_ROW,
    TESTING_ROW,
    { template_id: "x_cap0", rotation_status: "testing", daily_cap: 0 },
    { template_id: "x_unknown", rotation_status: "retired", daily_cap: 10 },
  ]));
  assert.deepEqual([...excluded].sort(), ["200049", "x_cap0", "x_unknown"]);
  assert.equal(excluded.has("208481"), false, "testing with a cap is sendable");
  assert.equal(excluded.has("204513"), false, "an ungoverned template is not excluded on the bulk path");
});

test("plan: a governance-paused template is never placed — rotation lands on a sendable sibling", async () => {
  const { store, deps } = setup({ templates: [template("200049"), template("208481"), template("204513")] });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(result.send_queue_rows_created, 3, JSON.stringify(result.skipped_counts_by_reason));
  const used = new Set(store.rows("send_queue").map((r) => String(r.template_id)));
  assert.equal(used.has("200049"), false, `paused template placed: ${[...used]}`);
  assert.deepEqual(result.template_governance.excluded_template_ids, ["200049"]);
  assert.equal(result.template_governance.applied, true);
});

test("plan: a seller whose only templates are governance-paused is HELD (not dropped), and nothing is placed", async () => {
  const { store, result } = await (async () => {
    const { store, deps } = setup({ templates: [template("200049")] });
    return { store, result: await createCampaignQueuePlan("camp_1", live, deps) };
  })();
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason.TEMPLATE_GOVERNANCE_PAUSED, 3);
  assert.equal(result.template_hold_targets.length, 3);
  assert.ok(result.template_hold_targets.every((h) => h.reason === "TEMPLATE_GOVERNANCE_PAUSED"));
  assert.equal(isTemplateHoldReason("TEMPLATE_GOVERNANCE_PAUSED"), true, "the feeder holds it via campaign-template-hold.js");
});

test("plan: a genuinely empty pool is still NO_TEMPLATE, not blamed on governance", async () => {
  const { deps } = setup({ templates: [] });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(result.skipped_counts_by_reason.TEMPLATE_GOVERNANCE_PAUSED, undefined);
  assert.equal(result.skipped_counts_by_reason.NO_TEMPLATE, 3);
});

test("plan: never-reviewed (ungoverned) templates still send on the bulk path (owner decision pending)", async () => {
  const { deps } = setup({ templates: [template("204513")] });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(result.send_queue_rows_created, 3);
});

test("plan: an unreadable governance table writes no rows (no send-time check backs this one up)", async () => {
  const { store, deps } = setup({
    templates: [template("208481")],
    extra: { loadGovernance: async () => { throw new Error("rotation control unreadable"); } },
  });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.ok(result.blockers.includes("template_governance_unreadable"), JSON.stringify(result.blockers));
  assert.equal(store.rows("send_queue").length, 0);
});

test("plan backstop: a renderer that ignores the exclusion still cannot place a paused template", async () => {
  const { store, deps } = setup({
    templates: [template("200049")],
    extra: {
      renderOutboundTemplate: async () => ({
        ok: true, template_id: "200049", template: template("200049"),
        rendered_message_body: "Hi John, this is Alex. Do you still own 1 Main St?",
      }),
    },
  });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(store.rows("send_queue").length, 0);
  assert.equal(result.skipped_counts_by_reason.TEMPLATE_GOVERNANCE_PAUSED, 3);
  assert.equal(result.template_hold_targets.length, 3);
});

test("re-eligibility: a governance change changes the catalogue fingerprint, so held sellers are re-checked", async () => {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("sms_templates", template("200049"));
  store.seedRow("ownership_template_rotation_control", { ...PAUSED_ROW });
  const before = await loadTemplateCatalogFingerprint(store.supabase);
  assert.equal(await loadTemplateCatalogFingerprint(store.supabase), before, "stable while nothing changes");
  store.table("ownership_template_rotation_control").rows[0].rotation_status = "testing";
  store.table("ownership_template_rotation_control").rows[0].daily_cap = 25;
  assert.notEqual(await loadTemplateCatalogFingerprint(store.supabase), before);
});
