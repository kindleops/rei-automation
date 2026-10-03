/**
 * CAMPAIGN COMPOSER 2.0 — the composition surface's server contract.
 *
 *   1. A save never resets auto_send / auto_reply and never carries status
 *      (the D9 regression the legacy builder kept re-opening).
 *   2. A double-click is one campaign and one launch (single-flight + keys).
 *   3. Zero eligible refuses the launch; nothing is scheduled.
 *   4. A blank-timezone cohort is HELD (unresolved), never Chicago (D10).
 *   5. Paused / blocklisted templates are not selectable, with the reason (D8).
 *   6. A past start is refused (D4: Start now / Reschedule); cap 0 stays 0 (D9b).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  _resetComposerFlights,
  composerAudienceFromPreview,
  composerCampaignPayload,
  launchComposedCampaign,
  resolveLaunchStart,
  saveComposerDraft,
  summarizeComposerFleet,
  summarizeTemplateCoverage,
  templateSelectability,
} from "@/lib/domain/campaigns/campaign-composer.js";
import { graphDistributionCounts, updateCampaign } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const ID = "c0c0c0c0-0000-4000-8000-000000000001";
const FILTERS = { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] }] };

function seededDraft(overrides = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", {
    id: ID, name: "Dallas first touch", status: "draft", objective: "ownership_check", market: "Dallas, TX", state: "TX",
    auto_queue_enabled: true, auto_send_enabled: true, auto_reply_mode: "assisted", emergency_stop_at: null,
    daily_cap: 300, total_cap: 1000, batch_max: 100, market_cap: 400, per_sender_cap: null, send_interval_seconds: 45,
    contact_window_start: "08:00", contact_window_end: "21:00", language_policy: "auto", agent_persona: null,
    candidate_source: "campaign_target_graph", description: null,
    metadata: { template_use_case: "ownership_check", stage_code: "S1", target_filters: FILTERS, composer_key: "ck-1" },
    ...overrides,
  });
  return store;
}

const row = (store) => store.rows("campaigns")[0];

test("composer payload never carries status or automation, on create or update", () => {
  const hostile = { name: "X", status: "active", auto_send_enabled: true, auto_reply_mode: "autonomous", template_use_case: "ownership_check", daily_cap: 250 };
  const update = composerCampaignPayload(hostile, { isUpdate: true });
  for (const key of ["status", "auto_send_enabled", "auto_reply_mode"]) assert.equal(key in update, false, key);
  const create = composerCampaignPayload({ ...hostile, composer_key: "k" }, { isUpdate: false });
  assert.equal(create.status, "draft");
  assert.equal("auto_send_enabled" in create, false);
  assert.equal("auto_reply_mode" in create, false);
  assert.equal(create.metadata.composer_key, "k");
});

test("a composer save rewrites only what it states: automation and status survive", async () => {
  _resetComposerFlights();
  const store = seededDraft();
  const result = await saveComposerDraft({
    composer_key: "ck-1",
    campaign_id: ID,
    composition: { name: "Dallas first touch v2", daily_cap: 0, target_filters: FILTERS, template_use_case: "ownership_check" },
  }, { supabase: store.supabase, updateCampaign: (id, payload) => updateCampaign(id, payload, { supabase: store.supabase }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = row(store);
  assert.equal(after.name, "Dallas first touch v2");
  assert.equal(after.daily_cap, 0, "cap 0 means send nothing (D9b) — never null");
  assert.equal(after.status, "draft");
  assert.equal(after.auto_send_enabled, true, "auto_send never reset by a save");
  assert.equal(after.auto_reply_mode, "assisted", "auto_reply never reset by a save");
});

test("a live campaign is not edited by the Composer", async () => {
  _resetComposerFlights();
  const store = seededDraft({ status: "active" });
  let writes = 0;
  const result = await saveComposerDraft({ composer_key: "ck-1", campaign_id: ID, composition: { name: "Y" } }, {
    supabase: store.supabase,
    updateCampaign: async () => { writes += 1; return { ok: true } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "campaign_not_editable");
  assert.equal(writes, 0);
});

test("a double-click save creates ONE campaign", async () => {
  _resetComposerFlights();
  let created = 0;
  let stored = null;
  const deps = {
    supabase: {},
    findDraftByComposerKey: async () => stored,
    loadCampaignStatus: async () => ({ id: "new-1", status: "draft" }),
    createCampaign: async () => {
      created += 1;
      await new Promise((r) => setTimeout(r, 20));
      stored = { id: "new-1", status: "draft" };
      return { ok: true, campaign_id: "new-1" };
    },
    updateCampaign: async () => ({ ok: true, changed_fields: [] }),
  };
  const input = { composer_key: "ck-double", composition: { name: "Minneapolis", template_use_case: "ownership_check" } };
  const [a, b] = await Promise.all([saveComposerDraft(input, deps), saveComposerDraft(input, deps)]);
  assert.equal(created, 1);
  assert.equal(a.campaign_id, "new-1");
  assert.equal(b.campaign_id, "new-1");
  // a later save (retry after the flight) finds the draft by its key — still one
  const c = await saveComposerDraft(input, deps);
  assert.equal(c.campaign_id, "new-1");
  assert.equal(created, 1);
});

/** An in-memory model of campaign_launch_claim / _finish (the SQL is proven in scripts/proof/campaign-launch-claim-proof.mjs). */
function claimStore(status = "draft") {
  const state = { status, claim: null }
  return {
    state,
    claimCampaignLaunch: async (_s, { launchKey }) => {
      if (state.claim?.outcome === "completed") return { claimed: false, reason: "already_launched", launch_key: state.claim.launchKey, result: state.claim.result }
      if (!["draft", "built"].includes(state.status)) return { claimed: false, reason: "campaign_not_launchable", status: state.status }
      if (state.claim && !state.claim.outcome) return { claimed: false, reason: "launch_in_progress", launch_key: state.claim.launchKey }
      state.claim = { launchKey, token: `t-${launchKey}` }
      return { claimed: true, reason: "event_claimed", token: state.claim.token, mode: "function" }
    },
    finishCampaignLaunch: async (_s, { token, outcome, result }) => {
      if (state.claim?.token !== token) return { ok: false, fenced: true }
      if (outcome === "failed") state.claim = null
      else Object.assign(state.claim, { outcome, result })
      return { ok: true, fenced: false }
    },
  }
}

function launchDeps(overrides = {}) {
  const calls = { lifecycle: [], events: [], builds: 0 }
  const store = claimStore()
  return {
    calls,
    store,
    deps: {
      supabase: {},
      nowMs: Date.parse("2026-10-02T15:00:00Z"),
      claimCampaignLaunch: store.claimCampaignLaunch,
      finishCampaignLaunch: store.finishCampaignLaunch,
      loadCampaignStatus: async () => ({ id: ID, status: store.state.status, total_cap: 1000 }),
      buildCampaignTargets: async () => { calls.builds += 1; return { ok: true, success: true, build_summary: { ready: 1482 } } },
      evaluateCampaignLaunchReadiness: async () => ({ launch_readiness: "ready", blockers: [], warnings: [], launch_ready_recipient_count: 1482 }),
      applyCampaignLifecycleAction: async (id, input) => {
        calls.lifecycle.push(input);
        await new Promise((r) => setTimeout(r, 15));
        store.state.status = input.action === "activate" ? "active" : "scheduled"
        return { ok: true, to: store.state.status, inserted: 100 };
      },
      recordCampaignEvent: async (event) => { calls.events.push(event) },
      ...overrides,
    },
  };
}

test("a launch double-click launches ONCE (single-flight), and a retry is idempotent", async () => {
  _resetComposerFlights();
  const { calls, deps } = launchDeps();
  const input = { campaign_id: ID, launch_key: "lk-1", start: { mode: "at", at: "2026-10-03T14:00:00Z" }, expected_eligible: 1482 };
  const [a, b] = await Promise.all([launchComposedCampaign(input, deps), launchComposedCampaign(input, deps)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.idempotent, true);
  assert.equal(calls.lifecycle.length, 1);
  assert.equal(calls.lifecycle[0].action, "schedule");
  assert.equal(calls.events.length, 1, "one audit event");
  const again = await launchComposedCampaign(input, deps);
  assert.equal(again.idempotent, true);
  assert.equal(calls.lifecycle.length, 1, "the recorded launch answers; nothing re-runs");
  assert.equal(calls.builds, 1, "one target materialisation");
});

test("two launch keys (two tabs / two servers) -> one launch; the other is told it already launched", async () => {
  _resetComposerFlights();
  const { calls, deps } = launchDeps();
  const a = { campaign_id: ID, launch_key: "tab-a", start: { mode: "now" }, expected_eligible: 1482 };
  const b = { ...a, launch_key: "tab-b" };
  const [ra, rb] = await Promise.all([launchComposedCampaign(a, deps), launchComposedCampaign(b, deps)]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1);
  assert.equal([ra, rb].find((r) => !r.ok).error, "launch_in_progress");
  assert.equal(calls.lifecycle.length, 1);
  assert.equal(calls.builds, 1);
  const late = await launchComposedCampaign({ ...a, launch_key: "tab-c" }, deps);
  assert.equal(late.error, "already_launched");
});

test("a database that can't decide the claim refuses the launch (fail closed)", async () => {
  _resetComposerFlights();
  const { calls, deps } = launchDeps({ claimCampaignLaunch: async () => ({ claimed: false, reason: "launch_claim_unavailable", error: "connection refused" }) });
  const r = await launchComposedCampaign({ campaign_id: ID, launch_key: "x", start: { mode: "now" } }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(calls.builds + calls.lifecycle.length, 0);
});

test("a refused launch releases its claim so a corrected launch can run", async () => {
  _resetComposerFlights();
  let blocked = true;
  const { calls, deps } = launchDeps({
    evaluateCampaignLaunchReadiness: async () => (blocked
      ? { launch_readiness: "blocked", blockers: ["No sender"], launch_ready_recipient_count: 10 }
      : { launch_readiness: "ready", blockers: [], warnings: [], launch_ready_recipient_count: 1482 }),
  });
  const first = await launchComposedCampaign({ campaign_id: ID, launch_key: "r1", start: { mode: "now" } }, deps);
  assert.equal(first.error, "launch_blocked");
  blocked = false;
  const second = await launchComposedCampaign({ campaign_id: ID, launch_key: "r2", start: { mode: "now" } }, deps);
  assert.equal(second.ok, true);
  assert.equal(calls.lifecycle.length, 1);
});

test("start now activates with an activation idempotency key", async () => {
  _resetComposerFlights();
  const { calls, deps } = launchDeps();
  const r = await launchComposedCampaign({ campaign_id: ID, launch_key: "lk-now", start: { mode: "now" }, expected_eligible: 1482 }, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.lifecycle[0].action, "activate");
  assert.equal(calls.lifecycle[0].activation_idempotency_key, "composer:lk-now");
  assert.equal(calls.lifecycle[0].batch_max, 100);
});

test("zero eligible refuses the launch; nothing is scheduled", async () => {
  _resetComposerFlights();
  const { calls, deps } = launchDeps({
    evaluateCampaignLaunchReadiness: async () => ({ launch_readiness: "warnings", blockers: [], warnings: [], launch_ready_recipient_count: 0 }),
  });
  const r = await launchComposedCampaign({ campaign_id: ID, launch_key: "lk-0", start: { mode: "now" } }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "zero_eligible");
  assert.equal(calls.lifecycle.length, 0);
});

test("blocked readiness, unreadable readiness and a changed count all fail closed", async () => {
  _resetComposerFlights();
  const blocked = launchDeps({ evaluateCampaignLaunchReadiness: async () => ({ launch_readiness: "blocked", blockers: ["No sender"], blocker_codes: ["zero_valid_senders"], launch_ready_recipient_count: 50 }) });
  const r1 = await launchComposedCampaign({ campaign_id: ID, launch_key: "lk-b", start: { mode: "now" } }, blocked.deps);
  assert.equal(r1.error, "launch_blocked");
  const unreadable = launchDeps({ evaluateCampaignLaunchReadiness: async () => ({ ok: false, error: "campaign_not_found" }) });
  const r2 = await launchComposedCampaign({ campaign_id: ID, launch_key: "lk-u", start: { mode: "now" } }, unreadable.deps);
  assert.equal(r2.error, "readiness_unavailable");
  const changed = launchDeps();
  const r3 = await launchComposedCampaign({ campaign_id: ID, launch_key: "lk-c", start: { mode: "now" }, expected_eligible: 1500 }, changed.deps);
  assert.equal(r3.error, "eligible_changed");
  for (const d of [blocked, unreadable, changed]) assert.equal(d.calls.lifecycle.length, 0);
});

test("a past start is refused with the missed-start semantics (D4)", () => {
  const now = Date.parse("2026-10-02T15:00:00Z");
  assert.equal(resolveLaunchStart({ mode: "at", at: "2026-10-02T09:00:00Z" }, now).error, "start_in_past");
  assert.equal(resolveLaunchStart({ mode: "at", at: "2026-10-02T09:00:00Z" }, now).missed, "missed");
  assert.equal(resolveLaunchStart({ mode: "at", at: "nonsense" }, now).error, "start_invalid");
  assert.equal(resolveLaunchStart({ mode: "at", at: "2026-10-02T16:00:00Z" }, now).ok, true);
  assert.equal(resolveLaunchStart({}, now).error, "start_required");
});

test("a blank-timezone cohort is HELD as unresolved — never Chicago (D10)", () => {
  const counts = graphDistributionCounts([
    { market: "Minneapolis, MN", state: "MN", property_zip: "55401", timezone: "" },
    { market: "Unknown", state: "", property_zip: "", timezone: "" },
    { market: "Unknown", state: null, property_zip: null, timezone: null },
    { market: "El Paso, TX", state: "TX", property_zip: "", timezone: "" },
  ]);
  assert.equal(counts.recipientZones["America/Chicago"], 1, "only the MN row resolves to Central");
  assert.equal(counts.recipientZones.unresolved, 3, "blank zone + no confident geography = unresolved");
  const audience = composerAudienceFromPreview({
    distributions: { recipientZones: [{ value: "America/Chicago", count: 1 }, { value: "unresolved", count: 3 }] },
  });
  assert.equal(audience.zones.unresolved, 3);
  assert.equal(audience.distributions.zones.some((z) => z.value === "unresolved"), false);
  assert.equal(audience.distributions.zones.reduce((s, z) => s + z.count, 0), 1);
});

test("paused and blocklisted templates are not selectable, with the reason (D8)", () => {
  const governance = new Map([
    ["200001", { template_id: "200001", rotation_status: "pause", daily_cap: 0, notes: "Paused: delivery risk" }],
    ["200002", { template_id: "200002", rotation_status: "testing", daily_cap: 25 }],
    ["204273", { template_id: "204273", rotation_status: "testing", daily_cap: 25 }],
  ]);
  const t = (id, extra = {}) => ({ template_id: id, use_case: "ownership_check", stage_code: "S1", language: "English", is_active: true, quarantine_state: "active", ...extra });
  assert.deepEqual(templateSelectability(t("200001"), { governanceRow: governance.get("200001"), governed: true }).selectable, false);
  assert.equal(templateSelectability(t("200001"), { governanceRow: governance.get("200001"), governed: true }).reason, "governance_paused");
  assert.equal(templateSelectability(t("204273"), { governanceRow: governance.get("204273"), governed: true, blocklisted: true }).reason, "blocked_by_operator");
  assert.equal(templateSelectability(t("9", { quarantine_state: "quarantined" })).reason, "template_quarantined");
  assert.equal(templateSelectability(t("200002"), { governanceRow: governance.get("200002"), governed: true }).selectable, true);
  // ungoverned templates stay usable on this path (b8825fab)
  assert.equal(templateSelectability(t("300000"), { governed: true }).selectable, true);

  const [own] = summarizeTemplateCoverage([t("200001"), t("200002"), t("204273"), t("300000")], { governanceById: governance, blockedIds: new Set(["204273"]) });
  const english = own.languages.find((l) => l.language === "English");
  assert.deepEqual({ templates: english.templates, sendable: english.sendable, paused: english.paused, blocked: english.blocked }, { templates: 4, sendable: 2, paused: 1, blocked: 1 });
  const paused = own.governed.find((g) => g.template_id === "200001");
  assert.equal(paused.selectable, false);
  assert.equal(paused.performance, null, "no reliable sample → no performance claim");
});

test("fleet capacity counts only what the router would use; blocked and cooling are unavailable", () => {
  const now = new Date("2026-10-02T15:00:00Z");
  const fleet = summarizeComposerFleet([
    { phone_number: "+14693131600", market: "Dallas, TX", status: "active", health_state: "healthy", messages_sent_today: 120, daily_limit: 1000 },
    { phone_number: "+12818458577", market: "Houston, TX", status: "active", health_state: "healthy", messages_sent_today: 0 },
    { phone_number: "+17866052999", market: "Miami, FL", status: "active", health_state: "cooling", messages_sent_today: 0 },
  ], { blocked: new Set(["+12818458577"]), perNumberCap: 800, now });
  const dallas = fleet.numbers.find((n) => n.market === "Dallas, TX");
  assert.equal(dallas.eligible, true);
  assert.equal(dallas.limit, 800);
  assert.equal(dallas.remaining_today, 680);
  assert.equal(fleet.numbers.find((n) => n.market === "Houston, TX").sender_state, "blocked");
  assert.equal(fleet.numbers.find((n) => n.market === "Miami, FL").eligible, false);
  const houston = fleet.markets.find((m) => m.market === "Houston, TX");
  assert.equal(houston.capacity_per_day, 0);
  assert.equal(houston.unavailable_per_day, 800);
});
