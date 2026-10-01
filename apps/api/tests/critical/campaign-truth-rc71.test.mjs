// ─── campaign-truth-rc71.test.mjs ───────────────────────────────────────────
// RC 7.1 workstream B — CAMPAIGN TRUTH. Pinned against the real functions:
//   B1 market identity derived from the built cohort (never a name, never the
//      operator's clock); multi-market represented honestly.
//   B2 schedule zones: recipient zones, DST-correct, multi-zone = earliest valid
//      instant; recipient zone from property geography, not owner phone.
//   B3 a missed start is never activated late; Calendar and worker share one rule;
//      missed rows can no longer starve genuinely due ones.
//   B4 a deterministic stall definition.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  campaignMarketIdentityPatch,
  easternmostZone,
  multiZoneWindowState,
  resolveCampaignScheduleTimezones,
  summarizeCampaignMarketIdentity,
} from "@/lib/domain/campaigns/campaign-market-identity.js";
import { computeNextValidSendInstant } from "@/lib/domain/campaigns/campaign-convert-to-live.js";
import { launchCandidateFromTarget, normalizeCampaignInput } from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  findDueScheduledCampaigns,
  isCampaignStartMissed,
  runDueScheduledCampaignActivations,
  SCHEDULE_MISSED_GRACE_MS,
} from "@/lib/domain/campaigns/campaign-activation-orchestrator.js";
import { buildCampaignEvents } from "@/lib/domain/calendar/calendar-timeline-service.js";
import { classifyFeederProgress, FEEDER_STALL_INTERVAL_MS } from "@/lib/domain/campaigns/run-campaign-outbound-feeder.js";
import { contactWindowState } from "@/lib/domain/map/map-world-service.js";

const identityCampaign = (zones, extra = {}) => ({
  contact_window_start: "08:00",
  contact_window_end: "21:00",
  ...extra,
  metadata: {
    ...(extra.metadata || {}),
    market_identity: summarizeCampaignMarketIdentity(zones.map((tz, i) => ({ market: `M${i}, XX`, timezone: tz }))),
  },
});
const localHour = (iso, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(iso))) % 24;

// ── B1 ──────────────────────────────────────────────────────────────────────
test("B1: a single-market cohort records its canonical market; a map-area name is never read", () => {
  const rows = Array.from({ length: 95 }, () => ({ market: "Dallas, TX", state: "TX", timezone: "America/Chicago" }));
  const identity = summarizeCampaignMarketIdentity(rows, {
    resolveMarket: (label) => (label === "Dallas, TX" ? { market_id: "dallas_tx", market_name: "Dallas, TX" } : null),
  });
  assert.equal(identity.kind, "single_market");
  assert.deepEqual(identity.canonical_market_ids, ["dallas_tx"]);
  const patch = campaignMarketIdentityPatch(identity, { name: "Map area · Miami, FL · 197 properties", metadata: { source: "map_area", timezone: "America/Los_Angeles" } });
  assert.equal(patch.market, "Dallas, TX", "from the cohort, not the campaign name");
  assert.equal(patch.state, "TX");
  assert.equal(patch.metadata.canonical_market_id, "dallas_tx");
  assert.equal(patch.metadata.timezone, "America/Chicago", "the operator-browser zone is replaced by the cohort's zone");
  assert.equal(patch.metadata.source, "map_area", "other metadata is preserved");
});

test("B1: a multi-market cohort clears a stale single market and lists every market and zone", () => {
  const rows = [
    ...Array(22).fill({ market: "Houston, TX", state: "TX", timezone: "America/Chicago" }),
    ...Array(21).fill({ market: "Miami, FL", state: "FL", timezone: "America/New_York" }),
    ...Array(7).fill({ market: "Phoenix, AZ", state: "AZ", timezone: "America/Phoenix" }),
  ];
  const identity = summarizeCampaignMarketIdentity(rows);
  assert.equal(identity.kind, "multi_market");
  assert.deepEqual(identity.markets.map((m) => m.market_name), ["Houston, TX", "Miami, FL", "Phoenix, AZ"]);
  assert.equal(identity.timezone_mode, "per_recipient");
  const patch = campaignMarketIdentityPatch(identity, { market: "Miami, FL", metadata: { timezone: "America/Chicago" } });
  assert.equal(patch.market, null);
  assert.equal(patch.metadata.timezone, null, "no single zone is claimed for a multi-zone cohort");
  assert.deepEqual(patch.metadata.recipient_timezones.sort(), ["America/Chicago", "America/New_York", "America/Phoenix"]);
});

test("B1: an unresolved cohort stays unresolved — no guess", () => {
  const identity = summarizeCampaignMarketIdentity([{ market: null, timezone: "Narnia" }]);
  assert.equal(identity.kind, "unresolved");
  assert.equal(identity.unresolved_timezone_targets, 1);
  assert.equal(campaignMarketIdentityPatch(identity, {}).market, null);
});

test("B1: a derived market is a description, not targeting; a builder save keeps derived zones", () => {
  const identity = summarizeCampaignMarketIdentity([{ market: "Dallas, TX", state: "TX", timezone: "America/Chicago" }]);
  const existing = { id: "c1", market: "Dallas, TX", state: "TX", metadata: { market_identity: identity, timezone: "America/Chicago", launch_timezone: "America/Chicago" } };
  const row = normalizeCampaignInput({ metadata: { timezone: "America/Los_Angeles", launch_timezone: "America/Los_Angeles" } }, existing);
  assert.equal(row.metadata.timezone, "America/Chicago", "the builder's guess does not overwrite the cohort zone");
});

// ── B2 ──────────────────────────────────────────────────────────────────────
// 2026-07-15 06:00 UTC: 01:00 Chicago / 02:00 New York / 23:00 (prev) Phoenix & LA.
const NIGHT = new Date("2026-07-15T06:00:00Z");
for (const [label, zone, expectedUtcHour] of [
  ["Minneapolis / Central", "America/Chicago", 13],
  ["Miami / Eastern", "America/New_York", 12],
  ["Phoenix / Arizona (no DST: 08:00 MST = 15:00Z in July)", "America/Phoenix", 15],
  ["Los Angeles / Pacific", "America/Los_Angeles", 15],
]) {
  test(`B2: next valid start for ${label} is 08:00 local`, () => {
    const next = computeNextValidSendInstant(identityCampaign([zone]), NIGHT);
    assert.equal(next.timezone, zone);
    assert.equal(next.timezone_basis, "campaign_targets");
    assert.equal(localHour(next.scheduled_for, zone), 8);
    assert.equal(new Date(next.scheduled_for).getUTCHours(), expectedUtcHour);
  });
}

test("B2: Phoenix in January is still 08:00 MST = 15:00Z (Denver moves, Phoenix does not)", () => {
  const winter = new Date("2026-01-15T06:00:00Z");
  assert.equal(new Date(computeNextValidSendInstant(identityCampaign(["America/Phoenix"]), winter).scheduled_for).getUTCHours(), 15);
  assert.equal(new Date(computeNextValidSendInstant(identityCampaign(["America/Denver"]), winter).scheduled_for).getUTCHours(), 15);
  assert.equal(new Date(computeNextValidSendInstant(identityCampaign(["America/Denver"]), NIGHT).scheduled_for).getUTCHours(), 14);
});

test("B2: DST transition — the morning after US DST ends (2026-11-01) opens at 08:00 CST = 14:00Z", () => {
  const beforeFallBack = new Date("2026-11-01T05:30:00Z"); // 00:30 CDT, transition at 02:00 local
  const next = computeNextValidSendInstant(identityCampaign(["America/Chicago"]), beforeFallBack);
  assert.equal(localHour(next.scheduled_for, "America/Chicago"), 8);
  assert.equal(next.scheduled_for, "2026-11-01T14:00:00.000Z");
});

test("B2: a cross-timezone cohort starts at the EARLIEST valid instant across its recipients", () => {
  // 22:00 Eastern = 19:00 Pacific: Eastern is closed, Pacific is open.
  const late = new Date("2026-07-16T02:00:00Z");
  const next = computeNextValidSendInstant(identityCampaign(["America/New_York", "America/Los_Angeles"]), late);
  assert.equal(next.timezone_mode, "per_recipient");
  assert.equal(next.timezone, "America/Los_Angeles");
  assert.ok(Date.parse(next.scheduled_for) - late.getTime() <= 5 * 60 * 1000 + 1000, "Pacific is open now; not held to tomorrow by Eastern");
});

test("B2: multi-market resolution reports every zone; day anchor is the zone whose day starts first", () => {
  const c = identityCampaign(["America/Los_Angeles", "America/Chicago", "America/New_York", "America/Phoenix"]);
  const z = resolveCampaignScheduleTimezones(c);
  assert.equal(z.mode, "per_recipient");
  assert.equal(z.timezones.length, 4);
  assert.equal(z.primary, "America/New_York");
  assert.equal(easternmostZone(["America/Phoenix", "America/Chicago"]), "America/Chicago");
});

test("B2: market missing — legacy rows say which basis they used; default is never silent", () => {
  assert.equal(resolveCampaignScheduleTimezones({ metadata: {} }).basis, "default");
  assert.equal(resolveCampaignScheduleTimezones({ market: "Miami, FL", metadata: { timezone: "America/Chicago" } }).primary, "America/New_York");
  assert.equal(resolveCampaignScheduleTimezones({ metadata: { timezone: "America/Denver" } }).basis, "legacy_campaign_metadata");
  // Identity beats a stale market label (75+ ACQ SCORE: market Miami, operator zone Chicago).
  const stale = identityCampaign(["America/New_York"], { market: "Dallas, TX", metadata: { timezone: "America/Chicago" } });
  assert.equal(resolveCampaignScheduleTimezones(stale).primary, "America/New_York");
});

test("B2: multi-zone window state is open when any recipient window is open", () => {
  const spec = { start: "08:00", end: "21:00" };
  const late = Date.parse("2026-07-16T02:00:00Z"); // 22:00 ET, 19:00 PT
  const s = multiZoneWindowState(late, ["America/New_York", "America/Los_Angeles"], spec, contactWindowState);
  assert.equal(s.open, true);
  assert.deepEqual(s.open_zones, ["America/Los_Angeles"]);
  const night = Date.parse("2026-07-15T09:00:00Z"); // 05:00 ET, 02:00 PT
  const closed = multiZoneWindowState(night, ["America/New_York", "America/Los_Angeles"], spec, contactWindowState);
  assert.equal(closed.open, false);
  assert.equal(closed.timezone, "America/New_York", "earliest next opening");
});

test("B2: the recipient zone comes from the property, not the owner's phone", () => {
  const la = launchCandidateFromTarget({ timezone: "Central", state: "CA", metadata: { candidate_snapshot: { property_zip: "90011" } } }, {});
  assert.equal(la.timezone, "America/Los_Angeles");
  assert.equal(la.timezone_basis, "property_geography");
  assert.equal(la.timezone_corrected_from, "Central");
  const miami = launchCandidateFromTarget({ timezone: "Pacific", state: "FL", metadata: { candidate_snapshot: { property_zip: "33125" } } }, {});
  assert.equal(miami.timezone, "America/New_York");
  const pensacola = launchCandidateFromTarget({ timezone: "America/New_York", state: "FL", metadata: { candidate_snapshot: { property_zip: "32501" } } }, {});
  assert.equal(pensacola.timezone, "America/Chicago", "FL panhandle is Central");
  const phoenix = launchCandidateFromTarget({ timezone: "Mountain", state: "AZ", metadata: { candidate_snapshot: { property_zip: "85004" } } }, {});
  assert.equal(phoenix.timezone, "America/Phoenix");
  // Split state without a usable ZIP: the stored value stands (unchanged behaviour).
  const tx = launchCandidateFromTarget({ timezone: "America/Chicago", state: "TX", metadata: { candidate_snapshot: {} } }, {});
  assert.equal(tx.timezone, "America/Chicago");
  assert.equal(tx.timezone_basis, "stored_target");
  // No geography and no stored zone still fails closed.
  const none = launchCandidateFromTarget({ metadata: {} }, {});
  assert.equal(none.timezone_eligibility_reason, "missing_timezone");
});

// ── B3 ──────────────────────────────────────────────────────────────────────
test("B3: missed = still scheduled and more than two hours past start — one rule for worker and Calendar", () => {
  const now = Date.parse("2026-09-30T18:15:00Z");
  const missed = { id: "m", name: "75+ ACQ SCORE", status: "scheduled", scheduled_for: "2026-09-30T16:11:00+00:00", contact_window_start: "08:00", contact_window_end: "21:00", metadata: { timezone: "America/New_York" } };
  const due = { ...missed, id: "d", scheduled_for: new Date(now - SCHEDULE_MISSED_GRACE_MS + 60_000).toISOString() };
  assert.equal(isCampaignStartMissed(missed, now), true);
  assert.equal(isCampaignStartMissed(due, now), false);
  assert.equal(isCampaignStartMissed({ ...missed, status: "active" }, now), false);
  const events = buildCampaignEvents([missed, due], { from: now - 864e5, to: now + 864e5, now });
  const start = (id) => events.find((e) => e.id === `campaign:${id}:start`);
  assert.equal(start("m").status, "missed");
  assert.equal(start("d").status, "starting");
});

function fakeCampaignsDb(rows) {
  const updates = [];
  const from = () => {
    const filters = [];
    let order = null;
    let limit = Infinity;
    const q = {
      select: () => q,
      eq: (k, v) => (filters.push((r) => r[k] === v), q),
      lte: (k, v) => (filters.push((r) => Date.parse(r[k]) <= Date.parse(v)), q),
      gte: (k, v) => (filters.push((r) => Date.parse(r[k]) >= Date.parse(v)), q),
      lt: (k, v) => (filters.push((r) => Date.parse(r[k]) < Date.parse(v)), q),
      order: (k, o) => ((order = [k, o?.ascending !== false]), q),
      limit: (n) => ((limit = n), q),
      update: (patch) => ({ eq: (k, v) => (updates.push({ id: v, patch }), Promise.resolve({ error: null })) }),
      then: (res, rej) => {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) out = out.sort((a, b) => (Date.parse(a[order[0]]) - Date.parse(b[order[0]])) * (order[1] ? 1 : -1));
        return Promise.resolve({ data: out.slice(0, limit), error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { db: { from }, updates };
}

test("B3: twenty already-marked missed campaigns no longer starve a genuinely due one", async () => {
  const now = Date.parse("2026-10-01T15:00:00Z");
  const old = Array.from({ length: 25 }, (_, i) => {
    const at = new Date(now - (3 + i) * 3600_000).toISOString();
    return { id: `old${i}`, status: "scheduled", scheduled_for: at, metadata: { schedule_missed_for: at } };
  });
  const fresh = { id: "fresh", status: "scheduled", scheduled_for: new Date(now - 10 * 60_000).toISOString(), metadata: {} };
  const { db } = fakeCampaignsDb([...old, fresh]);
  const due = await findDueScheduledCampaigns({ supabase: db, now });
  assert.deepEqual(due.map((c) => c.id), ["fresh"]);
});

test("B3: a missed start is marked, never activated late", async () => {
  const now = Date.parse("2026-10-01T15:00:00Z");
  const at = new Date(now - 3 * 3600_000).toISOString();
  const { db, updates } = fakeCampaignsDb([{ id: "late", name: "late", status: "scheduled", scheduled_for: at, metadata: {} }]);
  let activations = 0;
  const result = await runDueScheduledCampaignActivations({ supabase: db, now, runCanonicalCampaignActivation: () => { activations += 1; } });
  assert.equal(activations, 0);
  assert.equal(result.results[0].error, "schedule_missed");
  assert.equal(updates[0].patch.metadata.schedule_missed_for, at);
});

// ── B4 ──────────────────────────────────────────────────────────────────────
test("B4: the 2026-10-01 'all feeders stalled' readings are blocked, not stalled", () => {
  const now = Date.parse("2026-10-01T18:25:37Z");
  const dallas = classifyFeederProgress({ readyRemaining: 14, skippedByReason: { NO_TEMPLATE: 2, TEMPLATE_RENDER_LINT_FAILURE: 12 }, insideWindow: true, now });
  assert.deepEqual([dallas.state, dallas.stalled, dallas.blocked_by], ["blocked", false, "TEMPLATE_RENDER_LINT_FAILURE"]);
  const eg = classifyFeederProgress({ readyRemaining: 37, skippedByReason: { ROUTING_BLOCKED: 22, sender_blocked_by_operator: 14, TEMPLATE_RENDER_LINT_FAILURE: 1 }, now });
  assert.equal(eg.blocked_by, "ROUTING_BLOCKED");
});

test("B4: stalled only when audience, window, capacity, no progress for the interval, and no reason all hold", () => {
  const now = Date.parse("2026-10-01T18:00:00Z");
  const base = { readyRemaining: 10, insideWindow: true, skippedByReason: {}, lastProgressAt: new Date(now - FEEDER_STALL_INTERVAL_MS - 1).toISOString(), now };
  assert.equal(classifyFeederProgress(base).state, "stalled");
  assert.equal(classifyFeederProgress({ ...base, inserted: 3 }).state, "progressing");
  assert.equal(classifyFeederProgress({ ...base, readyRemaining: 0 }).state, "exhausted");
  assert.equal(classifyFeederProgress({ ...base, insideWindow: false }).state, "waiting_window");
  assert.equal(classifyFeederProgress({ ...base, activeLiveRows: 4 }).state, "queued_ahead");
  assert.equal(classifyFeederProgress({ ...base, feedBound: "daily_cap_reached" }).state, "pacing");
  assert.equal(classifyFeederProgress({ ...base, skippedByReason: { per_sender_cap_reached: 10 } }).state, "pacing");
  assert.equal(classifyFeederProgress({ ...base, blockers: ["emergency stop"] }).state, "blocked");
  assert.equal(classifyFeederProgress({ ...base, lastProgressAt: new Date(now - 60_000).toISOString() }).state, "idle_recent");
  assert.equal(classifyFeederProgress({ ...base, completed: true }).state, "completed");
});
