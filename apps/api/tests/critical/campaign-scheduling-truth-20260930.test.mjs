// ─── campaign-scheduling-truth-20260930.test.mjs ────────────────────────────
// "The owner can't schedule campaigns" (2026-09-30). Every root cause found in
// production, pinned by the real production functions against in-memory
// storage (tests/helpers/campaign-queue-plan-store.mjs):
//
//   • 75+ ACQ SCORE planned 0 of 84: every Miami target was routed onto the one
//     operator-blocked number (it never sends, so it always had the lowest
//     usage), and the other two Miami numbers were paused / cooling — the
//     cooling one passed routing because eligibility read a normalized row
//     with no health_state. The launch event said only "0 targets planned".
//   • "Couldn't verify messages": a dry-run plan re-read the sender fleet, the
//     template pool and two history tables for EVERY target.
//   • Readiness: a stale per-language "awaiting template assignment" roll-up
//     (targets with no language were assigned the language "auto").
//   • The builder saved stage 'first_touch'.
//   • Filters: seller tags compiled to whole-string equality (0 matches),
//     four score fields filtered a different metric, fields with no audience
//     data were accepted and ignored, "Apartment" vs "Multi-Family".
//   • Reach showed the graph's queue-eligible count, not what Build produces.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  activateCampaignWithHydration,
  buildCampaignTargets,
  buildRollingPlan,
  createCampaignQueuePlan,
  describePlanSkips,
  normalizeCampaignInput,
  planCampaignTargetRows,
  previewCampaignTargets,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  chooseTextgridNumber,
  countSendableSendersByMarket,
} from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import {
  assignTemplateForTargetFast,
  resolveTargetMessageLanguage,
} from "@/lib/domain/campaigns/campaign-target-template-assignment.js";
import { evaluateCampaignLaunchReadiness } from "@/lib/domain/campaigns/campaign-launch-readiness.js";
import { recordScheduledActivationRefusal } from "@/lib/domain/campaigns/campaign-activation-orchestrator.js";
import {
  applyGraphFilter,
  describeFilterExpansions,
  expandPropertyTypeValues,
  getCampaignFieldCatalogWithApplicability,
  graphFieldApplicability,
  listTokenPattern,
  resolveGraphFilterPlan,
} from "@/lib/domain/campaigns/campaign-graph-filter-plan.js";
import { collapsePropertyTypeOptions } from "@/lib/domain/campaigns/campaign-property-type-families.js";
import { CAMPAIGN_FIELD_CATALOG, getCampaignFieldDefinition } from "@/lib/domain/campaigns/campaign-field-catalog.js";
import { DRAWN_AREA_FIELD_KEY, normalizeDrawnArea } from "@/lib/domain/campaigns/campaign-drawn-area.js";

import { makeCampaignQueuePlanStore, makeCampaignQueuePlanDeps } from "../helpers/campaign-queue-plan-store.mjs";

const NOW = "2026-05-04T15:00:00.000Z"; // Monday 10:00 America/Chicago
const MIAMI = "Miami, FL";
const BLOCKED = "+13058975670";

function makeCampaign(id, overrides = {}) {
  return {
    id,
    name: `Scheduling truth ${id}`,
    status: "built",
    objective: "ownership_check",
    market: MIAMI,
    auto_queue_enabled: true,
    auto_send_enabled: false,
    auto_reply_mode: "disabled",
    emergency_stop_at: null,
    daily_cap: 750,
    total_cap: 1000,
    batch_max: 2,
    market_cap: 400,
    per_sender_cap: 150,
    send_interval_seconds: 45,
    contact_window_start: "08:00",
    contact_window_end: "21:00",
    language_policy: "auto",
    metadata: { stage_code: "S1", template_use_case: "ownership_check" },
    scheduled_for: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeReadyTarget(index, overrides = {}) {
  return {
    id: `tgt_${index}`,
    campaign_id: "camp_1",
    target_status: "ready",
    routing_status: "ready",
    suppression_status: "clear",
    template_status: "pending",
    priority_score: 100 - index,
    master_owner_id: `mo_${index}`,
    prospect_id: `pr_${index}`,
    property_id: `prop_${index}`,
    to_phone_number: `+1555123${String(1000 + index).slice(-4)}`,
    market: MIAMI,
    state: "FL",
    timezone: "America/New_York",
    identity_status: "verified",
    language: null,
    owner_name: "John Smith",
    metadata: {
      candidate_snapshot: {
        seller_first_name: "John",
        seller_full_name: "John Smith",
        owner_display_name: "John Smith",
        property_address_full: `${index} Main St, Miami, FL 33101`,
        property_city: "Miami",
        property_zip: "33101",
      },
      outreach_snapshot: {
        never_contacted: true,
        touch_count: 0,
        true_post_contact_suppression: false,
        wrong_number: false,
        pending_prior_touch: false,
        active_queue_item: false,
      },
    },
    ...overrides,
  };
}

const TEMPLATE = {
  id: "tpl_en_1",
  template_id: "tpl_en_1",
  is_active: true,
  use_case: "ownership_check",
  language: "English",
  stage_code: "S1",
  is_first_touch: true,
  template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?",
  allowed_property_groups: [],
  prohibited_property_groups: [],
};

function number(phone, overrides = {}) {
  return {
    id: `tg_${phone.slice(-4)}`,
    phone_number: phone,
    market: MIAMI,
    status: "active",
    health_state: "unverified",
    cooling_until: null,
    daily_limit: 800,
    messages_sent_today: 0,
    last_used_at: null,
    ...overrides,
  };
}

/** Miami as production had it on 2026-09-30. */
const MIAMI_FLEET = [
  number("+13057604780", { status: "paused" }),
  number(BLOCKED), // active, never used — lowest usage, operator-blocked
  number("+17866052999", { health_state: "cooling", messages_sent_today: 2, last_used_at: "2026-09-12T18:23:12Z" }),
];

const blockedSets = async () => ({ template_ids: new Set(), sender_numbers: new Set([BLOCKED]) });

function setup({ fleet = MIAMI_FLEET, targets = 3, campaign = {} } = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_1", campaign));
  store.seedRow("sms_templates", { ...TEMPLATE });
  store.seedRow("sms_templates", { ...TEMPLATE, id: "tpl_en_2", template_id: "tpl_en_2", template_body: "Hello {{seller_first_name}}, {{agent_name}} here. Is {{property_address}} still yours?" });
  for (const row of fleet) store.seedRow("textgrid_numbers", row);
  for (let i = 1; i <= targets; i += 1) store.seedRow("campaign_targets", makeReadyTarget(i));
  const deps = makeCampaignQueuePlanDeps(store, { loadDispatchBlockedSets: blockedSets });
  return { store, deps };
}

/** Counts reads per table through the storage fake. */
function countingDeps(store, extra = {}) {
  const reads = new Map();
  const base = store.supabase;
  const supabase = {
    ...base,
    from(table) {
      reads.set(table, (reads.get(table) || 0) + 1);
      return base.from(table);
    },
    rpc: base.rpc,
  };
  return { deps: { supabase, loadDispatchBlockedSets: blockedSets, ...extra }, reads };
}

// ── (a) routing: the 75+ ACQ SCORE zero ──────────────────────────────────────

test("router: an operator-blocked number is never chosen; a usable sibling in the market is", async () => {
  const fleet = [
    number(BLOCKED), // lowest usage — used to win every time
    number("+13055550100", { messages_sent_today: 40, last_used_at: "2026-09-29T15:00:00Z" }),
  ];
  const routing = await chooseTextgridNumber(
    { market: MIAMI, state: "FL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true, blocked_sender_numbers: new Set([BLOCKED]) },
    { textgridNumberRows: fleet },
  );
  assert.equal(routing.ok, true);
  assert.equal(routing.selected_textgrid_number, "+13055550100");
});

test("router: a cooling number is unavailable (eligibility now reads health_state from the fleet row)", async () => {
  const routing = await chooseTextgridNumber(
    { market: MIAMI, state: "FL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true },
    { textgridNumberRows: [number("+17866052999", { health_state: "cooling" })] },
  );
  assert.equal(routing.ok, false);
  assert.equal(routing.routing_block_reason, "LOCAL_NUMBERS_UNAVAILABLE");
  assert.deepEqual(routing.local_sender_inventory.map((entry) => entry.unavailable_reason), ["health_cooling"]);
});

test("router: Miami's real fleet names every local number and why it can't send", async () => {
  const routing = await chooseTextgridNumber(
    { market: MIAMI, state: "FL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true, blocked_sender_numbers: new Set([BLOCKED]) },
    { textgridNumberRows: MIAMI_FLEET },
  );
  assert.equal(routing.ok, false);
  assert.equal(routing.routing_block_reason, "LOCAL_NUMBERS_BLOCKED_BY_OPERATOR");
  const states = Object.fromEntries(routing.local_sender_inventory.map((entry) => [entry.phone_number, entry.unavailable_reason]));
  assert.deepEqual(states, {
    "+13057604780": "status_paused",
    [BLOCKED]: "blocked_by_operator",
    "+17866052999": "health_cooling",
  });
});

test("router: a market with no number at all is NO_VALID_LOCAL_TEXTGRID_NUMBER", async () => {
  const routing = await chooseTextgridNumber(
    { market: "Chicago, IL", state: "IL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true },
    { textgridNumberRows: MIAMI_FLEET },
  );
  assert.equal(routing.routing_block_reason, "NO_VALID_LOCAL_TEXTGRID_NUMBER");
  assert.deepEqual(routing.local_sender_inventory, []);
});

test("countSendableSendersByMarket applies the same availability rule as routing", () => {
  const counts = countSendableSendersByMarket(
    [...MIAMI_FLEET, number("+16125550101", { market: "Minneapolis, MN" }), number("+16125550102", { market: "Minneapolis, MN" })],
    [MIAMI, "Minneapolis, MN"],
    { blocked_sender_numbers: new Set([BLOCKED]) },
  );
  assert.deepEqual(counts, { [MIAMI]: 0, "Minneapolis, MN": 2 });
});

test("plan: Miami's fleet places 0 and says exactly why — in the result AND the launch event", async () => {
  const { store, deps } = setup();
  const result = await createCampaignQueuePlan("camp_1", {
    now: NOW,
    first_scheduled_at: NOW,
    explicit_operator_action: true,
    confirm_live: true,
    dry_run: false,
    create_send_queue_rows: true,
    no_send: false,
  }, deps);

  assert.equal(result.send_queue_rows_created, 0);
  assert.deepEqual(result.skipped_counts_by_reason, { sender_blocked_by_operator: 3 });
  assert.equal(result.routing_blocks_by_market[MIAMI].targets, 3);
  assert.match(result.skip_summary, /3 sender blocked by operator \(Miami, FL: .*\+13058975670 blocked by operator/);
  assert.equal(store.rows("send_queue").length, 0);

  const [event] = store.rows("campaign_events").filter((row) => String(row.event_type).startsWith("campaign.launch_"));
  assert.ok(event, "the plan records its launch event");
  assert.deepEqual(event.metadata.skipped_counts_by_reason, { sender_blocked_by_operator: 3 });
  assert.equal(event.metadata.planned_target_count, 0);
  assert.equal(event.metadata.skip_sample.length, 3);
  assert.equal(event.metadata.routing_blocks_by_market[MIAMI].reason, "sender_blocked_by_operator");
  assert.equal(event.severity, "warning");
  assert.match(event.description, /^0 targets planned; 0 queue rows created\. Nothing placed: 3 sender blocked by operator/);
});

test("plan: with one usable Miami number the same cohort is placed on it", async () => {
  const { store, deps } = setup({ fleet: [...MIAMI_FLEET, number("+13055550100", { messages_sent_today: 12 })] });
  const result = await createCampaignQueuePlan("camp_1", {
    now: NOW,
    first_scheduled_at: NOW,
    explicit_operator_action: true,
    confirm_live: true,
    dry_run: false,
    create_send_queue_rows: true,
    no_send: false,
    batch_max: 10,
  }, deps);
  assert.equal(result.send_queue_rows_created, 3, JSON.stringify(result.skipped_counts_by_reason));
  assert.deepEqual([...new Set(store.rows("send_queue").map((row) => row.from_phone_number))], ["+13055550100"]);
});

test("describePlanSkips names reasons, markets and numbers", () => {
  const text = describePlanSkips(
    { no_local_sender_number: 229, sender_blocked_by_operator: 72, TEMPLATE_RENDER_LINT_FAILURE: 37 },
    {
      "Chicago, IL": { targets: 229, reason: "no_local_sender_number", senders: [] },
      "Houston, TX": { targets: 72, reason: "sender_blocked_by_operator", senders: [{ phone_number: "+12818458577", state: "blocked_by_operator" }] },
    },
  );
  assert.equal(
    text,
    "229 no sender number in their market (Chicago, IL), 72 sender blocked by operator (Houston, TX: +12818458577 blocked by operator), 37 message failed the template check",
  );
});

// ── (f) the dry run reads once, not once per target ──────────────────────────

test("plan: the fleet, the template pool and message history are read once per plan, not per target", async () => {
  const fleet = [number("+13055550100")];
  const { store } = setup({ fleet, targets: 8 });
  const { deps, reads } = countingDeps(store);
  const result = await createCampaignQueuePlan("camp_1", { now: NOW, dry_run: true, full_cohort: true }, deps);
  assert.equal(result.schedulable_target_count, 8, JSON.stringify(result.skipped_counts_by_reason));
  assert.equal(reads.get("textgrid_numbers"), 1, "one fleet read for eight routings");
  assert.ok((reads.get("sms_templates") || 0) <= 2, `template pool read ${reads.get("sms_templates")} times`);
  // Active-queue + prior-contact checks, then batched history (one chunk), plus
  // ONE fleet sends-today ledger read (rc-7.1: derived, not the counter),
  // + ONE batched thread-persona (sticky) read (hotfix 8.4.8).
  assert.ok((reads.get("send_queue") || 0) <= 5, `send_queue read ${reads.get("send_queue")} times`);
  // + ONE batched not-owner reply read (opener-reply-exclusion, 2026-10-08).
  assert.ok((reads.get("message_events") || 0) <= 3, `message_events read ${reads.get("message_events")} times`);
});

// ── (e) the rolling plan ─────────────────────────────────────────────────────

test("full-cohort preflight evaluates every ready target past batch_max and returns the rolling plan", async () => {
  const fleet = [number("+13055550100"), number("+13055550101")];
  const { store } = setup({ fleet, targets: 6, campaign: { batch_max: 2, per_sender_cap: 2 } });
  const { deps } = countingDeps(store);
  const result = await createCampaignQueuePlan("camp_1", { now: NOW, first_scheduled_at: NOW, dry_run: true, full_cohort: true }, deps);

  assert.equal(result.full_cohort, true);
  assert.equal(result.planned_target_count, 6, "all six, not batch_max=2");
  assert.equal(result.skipped_counts_by_reason.per_sender_cap_reached, undefined, "a per-day cap paces, it doesn't skip");
  const plan = result.rolling_plan;
  assert.equal(plan.schedulable, 6);
  assert.equal(plan.sendable_senders, 2);
  assert.equal(plan.sender_capacity_per_day, 4, "2 numbers × per_sender_cap 2");
  assert.equal(plan.sends_per_day, 4);
  assert.equal(plan.binding, "sender_capacity");
  assert.equal(plan.days_to_complete, 2);
  assert.ok(plan.first_send_at, "first send time is known");
  assert.equal(store.rows("send_queue").length, 0, "a dry run writes nothing");
});

test("buildRollingPlan: the smallest of daily cap, window and sender capacity is the pace", () => {
  const common = { scheduleCampaign: { contact_window_start: "08:00", contact_window_end: "21:00" }, intervalSeconds: 45 };
  const byCap = buildRollingPlan({ ...common, ready: 539, schedulable: 539, caps: { daily_cap: 750, per_sender_cap: 800 }, sendableSendersByMarket: { "Minneapolis, MN": 3 } });
  assert.equal(byCap.window_capacity_per_day, 1040); // 13h / 45s
  assert.equal(byCap.sends_per_day, 750);
  assert.equal(byCap.binding, "daily_cap");
  assert.equal(byCap.days_to_complete, 1);
  const byWindow = buildRollingPlan({ ...common, ready: 5000, schedulable: 5000, caps: { daily_cap: 5000 }, sendableSendersByMarket: null });
  assert.equal(byWindow.binding, "contact_window");
  assert.equal(byWindow.days_to_complete, 5);
});

// ── (d) language + readiness truth ───────────────────────────────────────────

test("a target with no stated language on an 'auto' campaign is messaged in English", () => {
  const campaign = { language_policy: "auto", metadata: { stage_code: "S1", template_use_case: "ownership_check" } };
  assert.equal(resolveTargetMessageLanguage({ language: null }, campaign), "English");
  assert.equal(resolveTargetMessageLanguage({ language: "Unknown" }, campaign), "English");
  assert.equal(resolveTargetMessageLanguage({ language: "Spanish" }, campaign), "Spanish");

  const pool = [
    { template_id: "a", language: "English", template_body: "Hi {{seller_first_name}}, is {{property_address}} yours?", property_type_scope: "Residential" },
    { template_id: "b", language: "English", template_body: "Hello {{seller_first_name}} — still own {{property_address}}?", property_type_scope: "Residential" },
  ];
  const result = assignTemplateForTargetFast({ id: "t1", language: null, metadata: {} }, campaign, pool, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.language, "English");
  assert.notEqual(result.block_reason, "insufficient_template_rotation_pool:auto:0<2");
});

test("readiness: Miami's fleet is a named blocker; pending templates are not an 'awaiting assignment' gap", async () => {
  const { store, deps } = setup();
  // Held targets the old roll-up counted as "awaiting template assignment".
  store.seedRow("campaign_targets", makeReadyTarget(90, { target_status: "blocked", template_status: "blocked", block_reason: "entity_contact_requires_review" }));
  const readiness = await evaluateCampaignLaunchReadiness("camp_1", {
    ...deps,
    getSystemValue: async (key) => ({ queue_processor_mode: "normal", queue_auto_enqueue_enabled: "true", outbound_sms_enabled: "true" }[key] ?? null),
  }, { scheduled_activation: true, confirm_live: true, guarded_live_launch: true });

  assert.equal(readiness.launch_readiness, "blocked");
  assert.deepEqual(readiness.blocker_codes, ["zero_valid_senders"]);
  assert.match(readiness.blockers[0], /Miami, FL \(3 sellers\): .*\+13058975670 blocked by operator/);
  assert.match(readiness.blockers[0], /paused/);
  assert.match(readiness.blockers[0], /cooling/);
  assert.ok(!readiness.warnings.some((line) => /awaiting template assignment/i.test(line)), readiness.warnings.join(" | "));
  assert.equal(readiness.counts.awaiting_template, 0);
  assert.deepEqual(readiness.language_coverage.map((entry) => [entry.language, entry.renders]), [["English", true]]);
});

test("readiness: a covered market with an approved English message is ready", async () => {
  const { deps } = setup({ fleet: [number("+13055550100")] });
  const readiness = await evaluateCampaignLaunchReadiness("camp_1", {
    ...deps,
    getSystemValue: async (key) => ({ queue_processor_mode: "normal", queue_auto_enqueue_enabled: "true", outbound_sms_enabled: "true" }[key] ?? null),
  }, { scheduled_activation: true, confirm_live: true, guarded_live_launch: true });
  assert.deepEqual(readiness.blocker_codes, []);
  assert.equal(readiness.launch_ready_recipient_count, 3);
  assert.equal(readiness.sender_coverage[0].sendable, true);
});

// ── (g) canonical stage code ─────────────────────────────────────────────────

test("the builder's 'first_touch' is saved as S1; an update without a stage keeps the existing one", () => {
  assert.equal(normalizeCampaignInput({ name: "x", stage_code: "first_touch" }).metadata.stage_code, "S1");
  assert.equal(normalizeCampaignInput({ name: "x", metadata: { stage_code: "follow_up" } }).metadata.stage_code, "S2");
  const existing = { id: "c1", name: "x", metadata: { stage_code: "S3" } };
  assert.equal(normalizeCampaignInput({ description: "edit" }, existing).metadata.stage_code, "S3");
  assert.equal(normalizeCampaignInput({ name: "x" }).metadata.stage_code, "S1");
});

// ── scheduled activation refusals are recorded ───────────────────────────────

test("a refused scheduled activation is recorded once per schedule + reasons", async () => {
  const store = makeCampaignQueuePlanStore();
  const campaign = store.seedRow("campaigns", makeCampaign("camp_1", { status: "scheduled", scheduled_for: NOW }));
  const refusal = {
    ok: false,
    error: "launch_blocked",
    blockers: ["No sendable number covers this audience — Miami, FL (84 sellers): +13058975670 blocked by operator"],
    blocker_codes: ["zero_valid_senders"],
  };
  const deps = { supabase: store.supabase, now: NOW };
  assert.equal(await recordScheduledActivationRefusal(campaign, refusal, deps), true);
  const [updated] = store.rows("campaigns");
  assert.equal(updated.metadata.activation_blocked.blocker_codes[0], "zero_valid_senders");
  // The next tick with the same refusal writes nothing new.
  assert.equal(await recordScheduledActivationRefusal(updated, refusal, deps), false);
  const events = store.rows("campaign_events").filter((row) => row.event_type === "campaign.activation_blocked");
  assert.equal(events.length, 1);
  assert.match(events[0].description, /Miami, FL \(84 sellers\)/);
});

// ── (b) filters: one predicate source ────────────────────────────────────────

function recorder() {
  const calls = [];
  const query = new Proxy({}, {
    get(_target, prop) {
      return (...args) => { calls.push([prop, ...args]); return query; };
    },
  });
  return { query, calls };
}

/** The POSIX pattern as the equivalent JS regex, to prove the token semantics. */
function jsRegex(pattern) {
  return new RegExp(pattern.replace(/\[\[:space:\]\]/g, "\\s"), "i");
}

test("property flags match whole tokens of the ';'-joined list (was: whole-string equality, 0 rows); old seller-tag keys alias to them", () => {
  const { query, calls } = recorder();
  applyGraphFilter(query, { field_key: "properties.seller_tags_text", operator: "is_any_of", value: ["Tired Landlord", "High Equity"] });
  assert.deepEqual(calls[0].slice(0, 3), ["filter", "property_flags_text", "imatch"]);
  const re = jsRegex(calls[0][3]);
  assert.equal(re.test("Cash Buyer;High Equity;Absentee Owner"), true);
  assert.equal(re.test("Adjustable Loan;tired landlord;Vacant Home"), true);
  assert.equal(re.test("Tired Landlord"), true);
  assert.equal(re.test("Not A Tired Landlord Owner;Cash Buyer"), false, "a token, not a substring");
  assert.equal(re.test("Cash Buyer;Free And Clear"), false);
});

test("property flags 'is not any of' keeps sellers with no flags and excludes the token", () => {
  const { query, calls } = recorder();
  applyGraphFilter(query, { field_key: "prospects.seller_tags_text", operator: "is_not_any_of", value: ["Tired Landlord"] });
  assert.equal(calls[0][0], "or");
  assert.match(calls[0][1], /^property_flags_text\.is\.null,property_flags_text\.not\.imatch\."\(\^\|;\)/);
});

test("list-token patterns neutralise regex metacharacters", () => {
  const re = jsRegex(listTokenPattern(["Pre-Foreclosure (NOD)", "5+ Units"]));
  assert.equal(re.test("Cash Buyer;Pre-Foreclosure (NOD)"), true);
  assert.equal(re.test("5+ Units;Vacant"), true);
  assert.equal(re.test("55 Units"), false);
});

test("property type selects the asset family: Multi-Family and Apartment are one class", () => {
  assert.deepEqual(expandPropertyTypeValues(["Multi-Family"]), ["Multi-Family", "Apartment", "Multifamily 5+"]);
  assert.deepEqual(expandPropertyTypeValues(["Apartment"]), ["Multi-Family", "Apartment", "Multifamily 5+"]);
  assert.deepEqual(expandPropertyTypeValues(["SFR"]), ["Single Family", "SFR"]);
  assert.deepEqual(expandPropertyTypeValues(["Vacant Land"]), ["Vacant Land"]);

  const { query, calls } = recorder();
  applyGraphFilter(query, { field_key: "properties.property_type", operator: "is_any_of", value: ["Apartment"] });
  assert.deepEqual(calls[0], ["in", "property_type", ["Multi-Family", "Apartment", "Multifamily 5+"]]);

  const [note] = describeFilterExpansions([{ field_key: "properties.property_type", operator: "is_any_of", value: ["Apartment"] }]);
  assert.match(note.message, /Property type Apartment also includes Multi-Family, Multifamily 5\+/);

  const options = collapsePropertyTypeOptions([
    { value: "Single Family", label: "Single Family", count: 126889 },
    { value: "Multi-Family", label: "Multi-Family", count: 32164 },
    { value: "Apartment", label: "Apartment", count: 8983 },
    { value: "SFR", label: "SFR", count: 4 },
    { value: "Other", label: "Other", count: 1560 },
  ]);
  assert.deepEqual(options.map((o) => [o.value, o.count]), [["Single Family", 126893], ["Multi-Family", 41147], ["Other", 1560]]);
  assert.equal(options[1].label, "Multi-Family (incl. Apartment)");
});

test("fields are applied, or refused with their reason — never substituted, never ignored", () => {
  // Formerly rewritten to acquisition_score (= Final Acquisition Score).
  for (const key of ["properties.structured_motivation_score", "properties.deal_strength_score", "properties.tag_distress_score", "master_owners.priority_score", "sender_coverage.selected_textgrid_state"]) {
    const verdict = graphFieldApplicability(key);
    assert.equal(verdict.applicable, false, key);
    assert.equal(verdict.reason, "not_in_audience", key);
  }
  assert.equal(graphFieldApplicability("properties.final_acquisition_score").column, "acquisition_score");
  assert.equal(graphFieldApplicability("properties.year_built").reason, "not_in_audience");

  const population = new Map([["units_count", false], ["language", false], ["property_flags_text", true]]);
  assert.equal(graphFieldApplicability("properties.units_count", { population }).reason, "no_audience_data");
  assert.equal(graphFieldApplicability("properties.seller_tags_text", { population }).applicable, true);

  const plan = resolveGraphFilterPlan([
    { field_key: "properties.seller_tags_text", operator: "is_any_of", value: ["High Equity"], fieldDefinition: getCampaignFieldDefinition("properties.seller_tags_text") },
    { field_key: "properties.tag_distress_score", operator: "gte", value: 50, label: "Tag Distress Score" },
    { field_key: "properties.units_count", operator: "gte", value: 2, label: "Units Count" },
  ], { population });
  assert.deepEqual(plan.applicable.map((f) => f.graph_column), ["property_flags_text"]);
  assert.deepEqual(plan.inapplicable.map((f) => [f.field_key, f.reason]), [
    ["properties.tag_distress_score", "not_in_audience"],
    ["properties.units_count", "no_audience_data"],
  ]);
});

test("the field catalog tells the builder which fields can narrow a campaign, and why not", () => {
  const catalog = getCampaignFieldCatalogWithApplicability({ population: new Map([["language", false]]) });
  const fields = catalog.domains.flatMap((d) => d.categories.flatMap((c) => c.fields));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  assert.equal(byKey.get("properties.property_flags_text").campaign_applicable, true);
  assert.equal(byKey.get("prospects.language_preference").campaign_applicable, false);
  assert.match(byKey.get("prospects.language_preference").campaign_inapplicable_message, /No seller in the campaign audience/);
  assert.equal(byKey.get("properties.deal_strength_score").campaign_inapplicable_reason, "not_in_audience");
  assert.ok(catalog.applicability.inapplicable_fields > 0);
});

// ── (c) Reach = Build ────────────────────────────────────────────────────────

function graphRow(index, overrides = {}) {
  return {
    graph_id: `graph_${String(index).padStart(3, "0")}`,
    property_id: `prop_${index}`,
    master_owner_id: `mo_${index}`,
    seller_person_key: `person_${index}`,
    canonical_e164: `+1555200${String(1000 + index).slice(-4)}`,
    market: MIAMI,
    state: "FL",
    property_type: "Apartment",
    canonical_property_group: "Residential",
    language: null,
    sms_eligible: true,
    true_post_contact_suppression: false,
    wrong_number: false,
    pending_prior_touch: false,
    active_queue_item: false,
    sender_covered: true,
    sender_market: MIAMI,
    timezone: "America/New_York",
    identity_alignment: "verified",
    acquisition_score: 80,
    podio_tags: "High Equity;Tired Landlord",
    seller_first_name: "Ana",
    seller_full_name: "Ana Diaz",
    property_address_full: `${index} Ocean Dr, Miami, FL`,
    touch_count: 0,
    never_contacted: true,
    queue_eligible: true,
    queue_block_reason: null,
    ...overrides,
  };
}

test("Reach's ready count is the build's ready count: limit, one-per-phone and review holds included", async () => {
  const store = makeCampaignQueuePlanStore();
  const campaign = makeCampaign("camp_reach", {
    total_cap: 4,
    metadata: {
      stage_code: "S1",
      template_use_case: "ownership_check",
      target_filters: { properties: [{ field_key: "properties.property_type", operator: "is_any_of", value: ["Apartment"] }] },
    },
  });
  store.seedRow("campaigns", campaign);
  for (const row of MIAMI_FLEET) store.seedRow("textgrid_numbers", row);
  for (let i = 1; i <= 6; i += 1) store.seedRow("campaign_target_graph", graphRow(i));
  // Same phone as row 1 → one recipient.
  store.seedRow("campaign_target_graph", graphRow(7, { canonical_e164: graphRow(1).canonical_e164, seller_person_key: "person_1" }));
  // Held: no person linkage.
  store.seedRow("campaign_target_graph", graphRow(8, { seller_person_key: null }));

  // Entity-contact review flags prop_2; every other RPC is "not deployed",
  // exactly like the storage fake (chainable: some callers .maybeSingle()).
  const rpcResult = (result) => ({
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  });
  const rpcStore = {
    from: (table) => store.supabase.from(table),
    rpc: (name, args) => rpcResult(name === "campaign_entity_contact_review_flags"
      ? { data: (args.p_property_ids || []).filter((id) => id === "prop_2").map((id) => ({ property_id: id, requires_review: true })), error: null }
      : { data: null, error: { code: "42883", message: "function does not exist" } }),
  };
  const deps = { supabase: rpcStore, loadDispatchBlockedSets: blockedSets };

  const preview = await previewCampaignTargets({
    source: "campaign_target_graph",
    filters: campaign.metadata.target_filters,
    build_limit: 4,
  }, deps);
  const sim = preview.build_simulation;
  assert.equal(sim.ok, true, sim.error);

  const built = await buildCampaignTargets("camp_reach", { limit: 4 }, deps);
  assert.equal(built.ok, true, built.message);
  const targets = store.rows("campaign_targets").filter((row) => row.campaign_id === "camp_reach");
  const readyBuilt = targets.filter((row) => row.target_status === "ready").length;

  assert.equal(sim.built, targets.length, "same number of targets");
  assert.equal(sim.ready, readyBuilt, "Reach's ready === Build's ready");
  assert.deepEqual(sim.held_by_reason, built.build_summary.held_by_reason);
  assert.equal(built.build_summary.held_by_reason.entity_contact_requires_review, 1);
  assert.equal(preview.headline_count, readyBuilt);
  // Miami has no sendable number, so Reach says none of them can be texted today.
  assert.equal(sim.sendable_now, 0);
  assert.equal(sim.no_sendable_number, readyBuilt);
});

test("Build refuses a filter it can't apply (it used to build without it); a blank filter row is not a refusal", async () => {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_b", {
    metadata: {
      stage_code: "S1",
      target_filters: {
        properties: [
          { field_key: "properties.tag_distress_score", operator: "gte", value: 50 },
          { field_key: "properties.market", operator: "is_any_of", value: [] },
        ],
      },
    },
  }));
  store.seedRow("campaign_target_graph", graphRow(1));
  const refused = await buildCampaignTargets("camp_b", {}, { supabase: store.supabase });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  // Retired legacy score (2026-10-03): still refused by name, never silently dropped.
  assert.match(refused.message, /Tag Distress Score \(retired\)/);
  assert.doesNotMatch(refused.message, /properties\.market/);
  assert.equal(store.rows("campaign_targets").length, 0);

  // Empty-value rows alone build normally.
  const okStore = makeCampaignQueuePlanStore();
  okStore.seedRow("campaigns", makeCampaign("camp_c", {
    metadata: { stage_code: "S1", target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: [] }] } },
  }));
  okStore.seedRow("campaign_target_graph", graphRow(1));
  const ok = await buildCampaignTargets("camp_c", {}, { supabase: okStore.supabase });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.built_count, 1);
});

test("a campaign with no applicable filter narrows by its market; with no market either, Build refuses", async () => {
  // "LA - TEST": filter groups present but empty. The stored market still narrows.
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_market_only", {
    metadata: { stage_code: "S1", target_filters: { properties: [] } },
  }));
  store.seedRow("campaign_target_graph", graphRow(1));
  store.seedRow("campaign_target_graph", graphRow(2, { market: "Dallas, TX", state: "TX", sender_market: "Dallas, TX" }));
  const built = await buildCampaignTargets("camp_market_only", {}, { supabase: store.supabase });
  assert.equal(built.ok, true, built.message);
  const targets = store.rows("campaign_targets").filter((row) => row.campaign_id === "camp_market_only");
  assert.deepEqual(targets.map((row) => row.property_id), ["prop_1"], "Miami only, never every market");

  // No filter and no market: every seller in every market. Refused by name.
  const bare = makeCampaignQueuePlanStore();
  bare.seedRow("campaigns", makeCampaign("camp_bare", {
    market: null,
    metadata: { stage_code: "S1", target_filters: { properties: [] } },
  }));
  bare.seedRow("campaign_target_graph", graphRow(1));
  const refused = await buildCampaignTargets("camp_bare", {}, { supabase: bare.supabase });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  assert.equal(refused.error, "campaign_has_no_targeting");
  assert.equal(bare.rows("campaign_targets").length, 0);
});

test("planCampaignTargetRows is the build's own row planning (summary by reason)", async () => {
  const store = makeCampaignQueuePlanStore();
  const graph = { rows: [graphRow(1), graphRow(2), graphRow(3, { seller_person_key: null })] };
  const planned = await planCampaignTargetRows({
    campaign: makeCampaign("camp_p"),
    options: {},
    graph,
    targetLimit: 10,
    deps: { supabase: store.supabase },
    resolveLanguages: false,
  });
  assert.equal(planned.summary.built, 3);
  assert.equal(planned.summary.ready, 2);
  assert.deepEqual(planned.summary.held_by_reason, { missing_identity_linkage: 1 });
});

// ── the hidden market narrowing ──────────────────────────────────────────────

test("a multi-market filter builds every chosen market, not just the first", async () => {
  // "Test" (2026-09-30): Miami, Chicago, Dallas, LA, Phoenix, Houston → 854 targets, all Miami.
  const store = makeCampaignQueuePlanStore();
  const markets = [MIAMI, "Chicago, IL", "Dallas, TX"];
  store.seedRow("campaigns", makeCampaign("camp_mm", {
    market: MIAMI, // what the row carried: the first market chip
    metadata: {
      stage_code: "S1",
      target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: markets }] },
    },
  }));
  markets.forEach((market, index) => store.seedRow("campaign_target_graph", graphRow(index + 1, { market })));
  const built = await buildCampaignTargets("camp_mm", {}, { supabase: store.supabase });
  assert.equal(built.ok, true, built.message);
  const builtMarkets = store.rows("campaign_targets").map((row) => row.market).sort();
  assert.deepEqual(builtMarkets, [...markets].sort());
});

test("a market the operator removed no longer narrows the build (75+ ACQ SCORE built Miami only)", async () => {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_75", {
    market: MIAMI, // stale — no market filter below
    metadata: {
      stage_code: "S1",
      target_filters: { properties: [{ field_key: "properties.final_acquisition_score", operator: "gte", value: "75" }] },
    },
  }));
  store.seedRow("campaign_target_graph", graphRow(1, { market: MIAMI, acquisition_score: 90 }));
  store.seedRow("campaign_target_graph", graphRow(2, { market: "Dallas, TX", acquisition_score: 88 }));
  store.seedRow("campaign_target_graph", graphRow(3, { market: "Minneapolis, MN", acquisition_score: 80 }));
  const built = await buildCampaignTargets("camp_75", {}, { supabase: store.supabase });
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(store.rows("campaign_targets").map((row) => row.market).sort(), ["Dallas, TX", "Miami, FL", "Minneapolis, MN"]);
});

test("saving targeting with no market filter clears a stale campaign market", () => {
  const existing = { id: "c1", name: "75+", market: MIAMI, state: "FL", metadata: {} };
  const withoutMarket = normalizeCampaignInput({
    target_filters: { properties: [{ field_key: "properties.final_acquisition_score", operator: "gte", value: "75" }], prospects: [] },
  }, existing);
  assert.equal(withoutMarket.market, null);
  assert.equal(withoutMarket.state, null);
  const withMarket = normalizeCampaignInput({
    target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX", "Houston, TX"] }] },
  }, existing);
  assert.equal(withMarket.market, "Dallas, TX", "the first chosen market is the label/timezone hint");
  // A patch that doesn't carry targeting keeps the stored market.
  assert.equal(normalizeCampaignInput({ description: "rename" }, existing).market, MIAMI);
});

test("a scheduled activation that queues nothing says why (was: 'requires at least one send_queue row')", async () => {
  const { store, deps } = setup();
  const result = await activateCampaignWithHydration("camp_1", { now: NOW, batch_max: 5, confirm_live: true, no_send: false }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "activation_no_queue_rows");
  assert.match(result.blockers[0], /^No message could be queued: 3 sender blocked by operator \(Miami, FL: /);
  assert.equal(store.rows("send_queue").length, 0);
});

test("router: a number at today's cap can't take a message now, but readiness doesn't count the cap as a blocker", async () => {
  const capped = [number("+13055550100", { daily_limit: 800, messages_sent_today: 800 })];
  const now = await chooseTextgridNumber(
    { market: MIAMI, state: "FL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true },
    { textgridNumberRows: capped },
  );
  assert.equal(now.ok, false);
  assert.deepEqual(now.local_sender_inventory.map((entry) => entry.unavailable_reason), ["daily_limit_reached"]);
  const readinessView = await chooseTextgridNumber(
    { market: MIAMI, state: "FL", is_first_touch: true },
    { first_touch: true, routing_safe_only: true, ignore_daily_limit: true },
    { textgridNumberRows: capped },
  );
  assert.equal(readinessView.ok, true);
});

// ── Drawn map area → exact cohort (owner, 2026-09-30: "no arbitrary ordering,
// no silent truncation") ─────────────────────────────────────────────────────

const AREA_POLYGON = { type: "Polygon", coordinates: [[[-80.45, 25.55], [-80.10, 25.55], [-80.10, 25.98], [-80.45, 25.98], [-80.45, 25.55]]] };

/**
 * The database resolves the polygon (campaign_target_graph_in_area, proven on
 * production: 7,273 rows for a Miami polygon, equal to a direct join). Here the
 * fake returns a known "inside" set so the test checks the plumbing: the
 * planner reads ONLY through the area, with its own filters, order and paging
 * on top, and counts the area's rows exactly.
 */
function areaStore(insideIds) {
  const store = makeCampaignQueuePlanStore();
  const calls = [];
  const base = store.supabase;
  const rpcResult = (result) => ({
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  });
  const supabase = {
    from: (table) => base.from(table),
    rpc(name, params, opts) {
      calls.push({ name, params, opts });
      if (name === "campaign_target_graph_in_area") {
        for (const row of store.table("campaign_target_graph").rows) {
          if (insideIds.has(row.property_id) && !store.table("__graph_in_area").rows.some((r) => r.graph_id === row.graph_id)) {
            store.table("__graph_in_area").rows.push(row);
          }
        }
        return {
          select(columns) {
            const chain = base.from("__graph_in_area").select(columns, opts?.count ? { count: opts.count } : undefined);
            // PostgREST reports the exact total alongside a limited page.
            const proxy = new Proxy(chain, {
              get(target, prop) {
                if (prop === "limit") return () => proxy;
                const value = target[prop];
                return typeof value === "function" ? (...args) => { const out = value.apply(target, args); return out === target ? proxy : out; } : value;
              },
            });
            return proxy;
          },
        };
      }
      if (name === "map_area_property_count") return rpcResult({ data: insideIds.size, error: null });
      if (name === "campaign_entity_contact_review_flags") return rpcResult({ data: [], error: null });
      return base.rpc(name, params);
    },
  };
  return { store, supabase, calls };
}

test("drawn area: a polygon is validated and closed; a bad or degenerate one never passes", () => {
  const open = normalizeDrawnArea([[-80.45, 25.55], [-80.10, 25.55], [-80.10, 25.98]]);
  assert.equal(open.ok, true);
  assert.deepEqual(open.area.coordinates[0].at(-1), [-80.45, 25.55], "ring closed");
  assert.equal(normalizeDrawnArea(AREA_POLYGON).ok, true);
  assert.equal(normalizeDrawnArea([[1, 2], [1, 2], [1, 2]]).ok, false);
  assert.equal(normalizeDrawnArea([[200, 0], [1, 0], [1, 1]]).ok, false);
  assert.equal(normalizeDrawnArea([[0, 0], [1, 1], [2, 2]]).ok, false, "points on one line enclose nothing");
  // Not exactly collinear in floating point: a sliver, still not an area.
  assert.equal(normalizeDrawnArea([[-95.6, 29.6], [-95.5, 29.7], [-95.4, 29.8]]).ok, false);
  // A self-crossing lasso is an area (the database counts its two lobes), even
  // though its signed area cancels to zero.
  assert.equal(normalizeDrawnArea([[-95.6, 29.6], [-95.2, 30.0], [-95.2, 29.6], [-95.6, 30.0]]).ok, true);
  assert.equal(normalizeDrawnArea("nope").ok, false);
  assert.equal(normalizeDrawnArea(null).ok, false);
});

test("drawn area: recognised by key, applicable, and never offered in the builder's field list", () => {
  assert.equal(getCampaignFieldDefinition(DRAWN_AREA_FIELD_KEY)?.type, "geo_area");
  assert.equal(CAMPAIGN_FIELD_CATALOG.some((field) => field.key === DRAWN_AREA_FIELD_KEY), false);
  const verdict = graphFieldApplicability(DRAWN_AREA_FIELD_KEY);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.column, null);
});

test("drawn area: Reach and Build read the exact area cohort through the database, never the whole graph", async () => {
  const inside = new Set(["prop_1", "prop_2", "prop_3", "prop_4"]);
  const { store, supabase, calls } = areaStore(inside);
  store.seedRow("campaigns", makeCampaign("camp_area", {
    market: null,
    total_cap: 1000,
    metadata: { stage_code: "S1", template_use_case: "ownership_check", target_filters: { properties: [{ field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: AREA_POLYGON }] } },
  }));
  for (const row of MIAMI_FLEET) store.seedRow("textgrid_numbers", row);
  for (let i = 1; i <= 7; i += 1) store.seedRow("campaign_target_graph", graphRow(i));
  const deps = { supabase, loadDispatchBlockedSets: blockedSets };

  const preview = await previewCampaignTargets({
    source: "campaign_target_graph",
    filters: { properties: [{ field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: AREA_POLYGON }] },
    build_limit: 1000,
  }, deps);
  assert.equal(preview.build_simulation.ok, true, preview.build_simulation.error);

  const built = await buildCampaignTargets("camp_area", {}, deps);
  assert.equal(built.ok, true, built.message);
  const targets = store.rows("campaign_targets").filter((row) => row.campaign_id === "camp_area");
  assert.deepEqual([...new Set(targets.map((row) => row.property_id))].sort(), ["prop_1", "prop_2", "prop_3", "prop_4"], "only the area, all of it");
  assert.equal(preview.build_simulation.built, targets.length, "Reach builds what Build builds");

  const areaCalls = calls.filter((call) => call.name === "campaign_target_graph_in_area");
  assert.ok(areaCalls.length >= 2, "both Reach and Build read through the area");
  for (const call of areaCalls) assert.deepEqual(call.params.p_area, AREA_POLYGON, "the polygon travels in the body, never as an id list");
});

test("drawn area: other filters still narrow inside it", async () => {
  const inside = new Set(["prop_1", "prop_2", "prop_3"]);
  const { store, supabase } = areaStore(inside);
  store.seedRow("campaigns", makeCampaign("camp_area_type", {
    market: null,
    metadata: {
      stage_code: "S1",
      template_use_case: "ownership_check",
      target_filters: {
        properties: [
          { field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: AREA_POLYGON },
          { field_key: "properties.property_type", operator: "is_any_of", value: ["Single Family"] },
        ],
      },
    },
  }));
  store.seedRow("campaign_target_graph", graphRow(1, { property_type: "Single Family" }));
  store.seedRow("campaign_target_graph", graphRow(2));
  store.seedRow("campaign_target_graph", graphRow(3, { property_type: "Single Family" }));
  store.seedRow("campaign_target_graph", graphRow(9, { property_type: "Single Family" })); // outside the area
  const built = await buildCampaignTargets("camp_area_type", {}, { supabase, loadDispatchBlockedSets: blockedSets });
  assert.equal(built.ok, true, built.message);
  const ids = [...new Set(store.rows("campaign_targets").filter((row) => row.campaign_id === "camp_area_type").map((row) => row.property_id))].sort();
  assert.deepEqual(ids, ["prop_1", "prop_3"]);
});

test("drawn area: a broken polygon or a second area is refused by name, never widened", async () => {
  for (const [label, filters] of [
    ["broken", [{ field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: [[1, 2], [1, 2], [1, 2]] }]],
    ["two areas", [
      { field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: AREA_POLYGON },
      { field_key: DRAWN_AREA_FIELD_KEY, operator: "within", value: AREA_POLYGON },
    ]],
  ]) {
    const { store, supabase } = areaStore(new Set(["prop_1"]));
    store.seedRow("campaigns", makeCampaign(`camp_bad_${label}`, { market: null, metadata: { stage_code: "S1", target_filters: { properties: filters } } }));
    store.seedRow("campaign_target_graph", graphRow(1));
    store.seedRow("campaign_target_graph", graphRow(2));
    const refused = await buildCampaignTargets(`camp_bad_${label}`, {}, { supabase });
    assert.equal(refused.ok, false, label);
    assert.equal(refused.status, 422, label);
    assert.match(refused.message, /Drawn map area/, label);
    assert.equal(store.rows("campaign_targets").length, 0, label);
  }
});
