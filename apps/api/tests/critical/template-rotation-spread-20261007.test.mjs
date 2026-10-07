/**
 * 2026-10-07 — first-touch rotation spread.
 *
 * Owner: "WHY ARE WE ONLY USING 3-4 TEMPLATES AND NOT THE OTHERS".
 * St. Louis / Atlanta · Oct 7 sent English first touches from exactly 8
 * template_ids. The bulk planner's pool was 26 SFR-applicable S1 templates
 * minus system_control.sms_blocked_template_ids (15 ids, 14 of them in that
 * pool) minus governance-paused 200001/200033/200049 = 8. Rotation over those 8
 * was already even; the pool itself was the cap.
 *
 * Also fixed here (one eligibility function for every path):
 *   - the bulk path never counted today's sends, so daily caps never bound
 *     (211393, cap 30, was placed 152 times that day);
 *   - traffic_weight was ignored (uniform hash);
 *   - "ungoverned" policy was implicit on the bulk path and fail-closed on
 *     target-one enqueue. It is now an explicit, shared option.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { renderOutboundTemplate } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import {
  GOVERNANCE_REASONS,
  UNGOVERNED_POLICY,
  applyGovernance,
  cappedSendableTemplateIds,
  evaluateRotationEligibility,
  indexGovernance,
  loadTemplateUsedToday,
  utcDayStartIso,
} from "@/lib/domain/campaigns/template-governance.js";

const NOW = "2026-10-07T15:00:00.000Z";

// Production shape (read-only, 2026-10-07): the 26 active English S1
// ownership_check templates an SFR owner can receive.
const SFR_BODIES = {
  200001: "Hi {{seller_first_name}}, this is Alex. Do you still own {{property_address}}?",
  200017: "Hi {{seller_first_name}}, this is Alex. Are you still the owner of {{property_address}}?",
  200033: "Hi {{seller_first_name}}, this is Alex. Is {{property_address}} yours?",
  200049: "Hi {{seller_first_name}}, this is Alex. Just checking, do you own {{property_address}}?",
  204257: "Hey {{seller_first_name}}, this is Alex. I invest in Houston. Is {{property_address}} yours?",
  204273: "Hey {{seller_first_name}}, this is Alex. I invest in Houston. Just checking, do you own {{property_address}}?",
  204513: "Hey {{seller_first_name}}, this is Alex. I am a local real estate investor in Houston. Do you still own {{property_address}}?",
  204529: "Hey {{seller_first_name}}, this is Alex. I am a local real estate investor in Houston. Are you still the owner of {{property_address}}?",
  204545: "Hey {{seller_first_name}}, this is Alex. I am a local real estate investor in Houston. Is {{property_address}} yours?",
  204561: "Hey {{seller_first_name}}, this is Alex. I am a local real estate investor in Houston. Just checking, do you own {{property_address}}?",
  204705: "Hey {{seller_first_name}}, this is Alex. I have been investing in Houston. Do you still own {{property_address}}?",
  204721: "Hey {{seller_first_name}}, this is Alex. I have been investing in Houston. Are you still the owner of {{property_address}}?",
  207681: "Hello {{seller_first_name}}, this is Alex. I am a local buyer in Houston. Do you still own {{property_address}}?",
  207697: "Hello {{seller_first_name}}, this is Alex. I am a local buyer in Houston. Are you still the owner of {{property_address}}?",
  207713: "Hello {{seller_first_name}}, this is Alex. I am a local buyer in Houston. Is {{property_address}} yours?",
  207729: "Hello {{seller_first_name}}, this is Alex. I am a local buyer in Houston. Just checking, do you own {{property_address}}?",
  207969: "Hello {{seller_first_name}}, this is Alex. I invest in Houston. Do you still own {{property_address}}?",
  207985: "Hello {{seller_first_name}}, this is Alex. I invest in Houston. Are you still the owner of {{property_address}}?",
  208481: "Hello {{seller_first_name}}, this is Alex. I have been investing in Houston. Is {{property_address}} yours?",
  208497: "Hello {{seller_first_name}}, this is Alex. I have been investing in Houston. Just checking, do you own {{property_address}}?",
  211377: "Hey {{seller_first_name}}, this is Alex. Do you still own {{property_address}}?",
  211393: "Hey {{seller_first_name}}, this is Alex. Is {{property_address}} yours?",
  211409: "Hey {{seller_first_name}}, this is Alex. Are you still the owner of {{property_address}}?",
  840900: "Hi {{seller_first_name}}, this is Alex, a local investor in Houston. Wanted to check, do you still own {{property_address}}?",
  840901: "Hi {{seller_first_name}}, my name is Alex. Came across {{property_address}}, are you still the owner?",
  840902: "Hey {{seller_first_name}}, hope all is well. This is Alex reaching out about {{property_address}}. Is this the correct number for the owner?",
};
const RESIDENTIAL = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const TEMPLATES = Object.entries(SFR_BODIES).map(([id, body]) => ({
  id, template_id: id, is_active: true, use_case: "ownership_check", language: "English", stage_code: "S1",
  is_first_touch: true, template_body: body,
  allowed_property_groups: id.startsWith("8409") ? [] : RESIDENTIAL, prohibited_property_groups: [],
}));

const PAUSED = ["200001", "200033", "200049", "204257", "207681", "207697", "207713"];
const GOVERNANCE = indexGovernance([
  ...PAUSED.map((id) => ({ template_id: id, rotation_status: "pause", daily_cap: 0, traffic_weight: 0 })),
  ...["204273", "204529", "207985", "208481"].map((id) => ({ template_id: id, rotation_status: "testing", daily_cap: 25, traffic_weight: 1.5 })),
  { template_id: "211393", rotation_status: "testing", daily_cap: 30, traffic_weight: 0.65 },
]);
// After the 2026-10-07 21:22Z operator change: only 840900 stays blocked.
const BLOCKED_AFTER = new Set(["840900"]);
const BLOCKED_BEFORE = new Set(["204257", "204273", "204513", "204529", "204545", "204561", "204705", "204721", "207681", "207697", "207713", "207729", "207969", "207985", "840900"]);

const candidate = (i) => ({
  master_owner_id: `mo_${i}`, property_id: `prop_${i}`, best_phone_id: `ph_${i}`, phone_id: `ph_${i}`,
  canonical_e164: `+1555${String(1000000 + i).slice(-7)}`, canonical_property_group: "sfr", property_type: "SFR",
  market: "Houston, TX", timezone: "America/Chicago", matching_flags: "Likely Owner",
  identity_alignment: { status: "probable", eligible: true, score: 75, reasons: [] },
  touch_number: 1, stage_code: "S1", owner_display_name: "John Smith", seller_first_name: "John",
  prospect_first_name: "John", property_address_full: `${i} Main St, Houston, TX 77001`, property_address: `${i} Main St`,
});

const deps = { fetchSmsTemplates: async () => TEMPLATES.map((t) => ({ ...t })), getRecentTemplateIds: async () => [] };

async function distribution({ blocked, n = 1200, usedToday = new Map(), governance = GOVERNANCE, policy = UNGOVERNED_POLICY.ALLOW }) {
  const counts = new Map();
  const reasons = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = await renderOutboundTemplate(candidate(i), {
      template_use_case: "ownership_check", stage_code: "S1", now: NOW, campaign_session_id: "camp_x",
      campaign_template_assignment: true, allow_identity_unknown: true,
      blocked_template_ids: blocked, rotation_governance: governance, template_used_today: usedToday,
      ungoverned_policy: policy,
      governance_excluded_template_ids: new Set([...governance].filter(([, g]) => g.rotation_status === "pause").map(([id]) => id)),
    }, deps);
    if (!r.ok) { reasons.set(r.reason_code, (reasons.get(r.reason_code) || 0) + 1); continue; }
    const id = String(r.template?.template_id ?? r.template_id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return { counts, reasons };
}

test("10-07 reproduction: blocklist + paused leave exactly the 8 templates production used", async () => {
  const { counts } = await distribution({ blocked: BLOCKED_BEFORE, n: 600 });
  assert.deepEqual([...counts.keys()].sort(), ["200017", "208481", "208497", "211377", "211393", "211409", "840901", "840902"]);
});

test("after the blocklist change, rotation spreads across all 18 eligible SFR templates; blocked and paused never appear", async () => {
  const { counts } = await distribution({ blocked: BLOCKED_AFTER });
  const used = [...counts.keys()].sort();
  const expected = TEMPLATES.map((t) => t.template_id).filter((id) => !BLOCKED_AFTER.has(id) && !PAUSED.includes(id)).sort();
  assert.equal(expected.length, 18);
  assert.deepEqual(used, expected);
  for (const id of [...BLOCKED_AFTER, ...PAUSED]) assert.equal(counts.has(id), false, `${id} placed`);
});

test("traffic_weight shapes the share: weight 1.5 out-draws weight 0.65", async () => {
  const { counts } = await distribution({ blocked: BLOCKED_AFTER, n: 3000 });
  const heavy = (counts.get("208481") || 0);
  const light = (counts.get("211393") || 0);
  const unweighted = (counts.get("200017") || 0);
  assert.ok(heavy > unweighted && unweighted > light, `208481=${heavy} 200017=${unweighted} 211393=${light}`);
});

test("a template at today's daily cap leaves the pool; its siblings absorb the traffic", async () => {
  const { counts } = await distribution({ blocked: BLOCKED_AFTER, usedToday: new Map([["208481", 25], ["211393", 29]]) });
  assert.equal(counts.has("208481"), false);
  assert.ok(counts.get("211393") > 0, "below cap stays in");
});

test("a pool emptied only by daily caps is a skip for today, not a template hold", async () => {
  const only = indexGovernance([{ template_id: "208481", rotation_status: "testing", daily_cap: 25, traffic_weight: 1 }]);
  const r = await renderOutboundTemplate(candidate(1), {
    template_use_case: "ownership_check", stage_code: "S1", now: NOW, campaign_template_assignment: true,
    rotation_governance: only, template_used_today: new Map([["208481", 25]]), ungoverned_policy: UNGOVERNED_POLICY.ALLOW,
  }, { fetchSmsTemplates: async () => [TEMPLATES.find((t) => t.template_id === "208481")], getRecentTemplateIds: async () => [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "TEMPLATE_DAILY_CAP_EXHAUSTED");
});

test("fail-closed policy (template_governance_fail_closed) admits only governed sendable templates", async () => {
  const { counts } = await distribution({ blocked: BLOCKED_AFTER, n: 400, policy: UNGOVERNED_POLICY.DENY });
  assert.deepEqual([...counts.keys()].sort(), ["204273", "204529", "207985", "208481", "211393"]);
});

test("one verdict: enqueue-one (applyGovernance default) still fails closed; the same function allows when told to", () => {
  const t = TEMPLATES.find((x) => x.template_id === "840902");
  assert.equal(applyGovernance([t], GOVERNANCE, "ownership_check").eligible.length, 0);
  assert.equal(evaluateRotationEligibility(t, undefined).reason, GOVERNANCE_REASONS.ABSENT);
  const allowed = evaluateRotationEligibility(t, undefined, { ungoverned: UNGOVERNED_POLICY.ALLOW });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.weight, 1);
  assert.equal(evaluateRotationEligibility(t, undefined, { ungoverned: UNGOVERNED_POLICY.ALLOW, blockedTemplateIds: new Set(["840902"]) }).reason, GOVERNANCE_REASONS.OPERATOR_BLOCKED);
  const g = GOVERNANCE.get("211393");
  assert.equal(evaluateRotationEligibility({ ...t, template_id: "211393" }, g, { usedToday: 30 }).reason, GOVERNANCE_REASONS.CAP_EXHAUSTED);
  assert.equal(evaluateRotationEligibility({ ...t, template_id: "211393" }, g, { usedToday: 29 }).weight, 0.65);
  assert.equal(evaluateRotationEligibility({ ...t, template_id: "200001" }, GOVERNANCE.get("200001"), { ungoverned: UNGOVERNED_POLICY.ALLOW }).ok, false, "paused stays paused");
});

test("daily usage: only capped sendable ids are counted, from the UTC day start, one head count each", async () => {
  assert.deepEqual(cappedSendableTemplateIds(GOVERNANCE), ["204273", "204529", "207985", "208481", "211393"]);
  assert.equal(utcDayStartIso("2026-10-07T23:59:00-05:00"), "2026-10-08T00:00:00.000Z");
  const calls = [];
  const supabase = {
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select(_c, opts) { q.opts = opts; return b; },
        eq(c, v) { q.filters.push(["eq", c, v]); return b; },
        gte(c, v) { q.filters.push(["gte", c, v]); return b; },
        not(c, op, v) { q.filters.push(["not", c, op, v]); calls.push(q); return Promise.resolve({ count: q.filters[0][2] === "208481" ? 12 : 0, error: null }); },
      };
      return b;
    },
  };
  const used = await loadTemplateUsedToday(supabase, ["208481", "211393"], NOW);
  assert.equal(used.get("208481"), 12);
  assert.equal(used.get("211393"), 0);
  assert.ok(calls.every((c) => c.table === "send_queue" && c.opts?.head === true && c.filters.some((f) => f[0] === "gte" && f[2] === "2026-10-07T00:00:00.000Z")));
  await assert.rejects(loadTemplateUsedToday({ from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ not: async () => ({ error: new Error("x") }) }) }) }) }) }, ["1"], NOW));
});

// ── Planner wiring (createCampaignQueuePlan) ─────────────────────────────────
import { createCampaignQueuePlan } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { makeCampaignQueuePlanStore, makeCampaignQueuePlanDeps } from "../helpers/campaign-queue-plan-store.mjs";

const PLAN_NOW = "2026-05-04T15:00:00.000Z";
const MIAMI = "Miami, FL";
function planSetup({ usedToday = 0, cap = 25, targets = 3, failClosed = false } = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", {
    id: "camp_1", name: "Spread", status: "built", objective: "ownership_check", market: MIAMI,
    auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: "disabled", emergency_stop_at: null,
    daily_cap: 750, total_cap: 1000, batch_max: 10, market_cap: 400, per_sender_cap: 150, send_interval_seconds: 45,
    contact_window_start: "08:00", contact_window_end: "21:00", language_policy: "auto",
    metadata: { stage_code: "S1", template_use_case: "ownership_check" }, scheduled_for: null, created_at: PLAN_NOW, updated_at: PLAN_NOW,
  });
  for (const id of ["208481", "204513"]) store.seedRow("sms_templates", { ...TEMPLATES.find((t) => t.template_id === id) });
  store.seedRow("ownership_template_rotation_control", { template_id: "208481", rotation_status: "testing", language: "English", daily_cap: cap, traffic_weight: 1.5, last_40d_total_sent: null });
  store.seedRow("textgrid_numbers", { id: "tg_0100", phone_number: "+13055550100", market: MIAMI, status: "active", health_state: "unverified", cooling_until: null, daily_limit: 800, messages_sent_today: 0, last_used_at: null });
  for (let i = 1; i <= targets; i += 1) {
    store.seedRow("campaign_targets", {
      id: `tgt_${i}`, campaign_id: "camp_1", target_status: "ready", routing_status: "ready", suppression_status: "clear",
      template_status: "pending", priority_score: 100 - i, master_owner_id: `mo_${i}`, prospect_id: `pr_${i}`,
      property_id: `prop_${i}`, to_phone_number: `+1555123${String(1000 + i).slice(-4)}`, market: MIAMI, state: "FL",
      timezone: "America/New_York", identity_status: "verified", language: null, owner_name: "John Smith",
      metadata: {
        candidate_snapshot: { seller_first_name: "John", seller_full_name: "John Smith", owner_display_name: "John Smith", property_address_full: `${i} Main St, Miami, FL 33101`, property_city: "Miami", property_zip: "33101" },
        outreach_snapshot: { never_contacted: true, touch_count: 0, true_post_contact_suppression: false, wrong_number: false, pending_prior_touch: false, active_queue_item: false },
      },
    });
  }
  const seen = [];
  const deps = makeCampaignQueuePlanDeps(store, {
    loadDispatchBlockedSets: async () => ({ template_ids: new Set(), sender_numbers: new Set() }),
    loadTemplateUsedToday: async (_s, ids, nowIso) => { seen.push({ ids, nowIso }); return new Map(ids.map((id) => [id, id === "208481" ? usedToday : 0])); },
    getSystemValue: async (key) => (key === "template_governance_fail_closed" ? (failClosed ? "true" : null) : null),
  });
  return { store, deps, seen };
}
const live = { now: PLAN_NOW, first_scheduled_at: PLAN_NOW, explicit_operator_action: true, confirm_live: true, dry_run: false, create_send_queue_rows: true, no_send: false, batch_max: 10 };

test("plan: a capped template already at today's cap is not placed; the run reports usage and policy", async () => {
  const { store, deps, seen } = planSetup({ usedToday: 25 });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(result.send_queue_rows_created, 3, JSON.stringify(result.skipped_counts_by_reason));
  assert.deepEqual([...new Set(store.rows("send_queue").map((r) => String(r.template_id)))], ["204513"]);
  assert.deepEqual(seen[0].ids, ["208481"]);
  assert.equal(result.template_governance.ungoverned_policy, UNGOVERNED_POLICY.ALLOW);
  assert.deepEqual(result.template_governance.daily_cap_used_today, { 208481: 25 });
});

test("plan: the cap binds within one pass too (cap 1 → at most one row on that template)", async () => {
  const { store, deps } = planSetup({ usedToday: 0, cap: 1, targets: 6 });
  await createCampaignQueuePlan("camp_1", live, deps);
  const on = store.rows("send_queue").filter((r) => String(r.template_id) === "208481").length;
  assert.ok(on <= 1, `208481 placed ${on} times with cap 1`);
});

test("plan: template_governance_fail_closed=true keeps never-reviewed templates out (no row, not dropped silently)", async () => {
  const { store, deps } = planSetup({ usedToday: 25, failClosed: true });
  const result = await createCampaignQueuePlan("camp_1", live, deps);
  assert.equal(store.rows("send_queue").filter((r) => String(r.template_id) === "204513").length, 0);
  assert.equal(result.template_governance.ungoverned_policy, UNGOVERNED_POLICY.DENY);
});

test("'scale' (the table's CHECK vocabulary) is sendable; 'disabled' is not", () => {
  const t = TEMPLATES[0];
  assert.equal(evaluateRotationEligibility(t, { rotation_status: "scale", daily_cap: 50 }).ok, true);
  assert.equal(evaluateRotationEligibility(t, { rotation_status: "disabled", daily_cap: 50 }).ok, false);
});
