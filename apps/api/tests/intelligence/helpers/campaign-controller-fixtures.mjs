/** Hermetic fixtures for the campaign controller tests (no network, no DB). */
import { DEFAULT_DETERMINISTIC_LIMITS } from "../../../src/lib/domain/intelligence/campaign-controller/guardrails.js";
import { buildEnvelope } from "../../../src/lib/domain/intelligence/campaign-controller/envelope.js";

export const NOW = "2026-10-01T10:00:00.000Z";

export const counts = (o = {}) => ({
  sends: 0,
  delivered: 0,
  failed: 0,
  filtered: 0,
  reply_threads: 0,
  opt_outs: 0,
  wrong_person: 0,
  qualified: 0,
  engaged: 0,
  hostile: 0,
  ...o,
});

/** A live, healthy, well-evidenced Dallas campaign that qualifies for one scale step. */
export function healthyCampaign(overrides = {}) {
  const rolling = counts({ sends: 700, delivered: 660, failed: 40, filtered: 20, reply_threads: 70, opt_outs: 7, wrong_person: 2, qualified: 7, engaged: 12 });
  const base = {
    campaign_id: "camp-healthy",
    status: "active",
    market: "Dallas, TX",
    cohort: "map_area",
    strategy: "ownership_check",
    timezone: "America/Chicago",
    caps: { daily_cap: 400, contact_window_start: "08:00", contact_window_end: "21:00" },
    metrics: {
      as_of: NOW,
      recent: counts({ sends: 100, delivered: 95, failed: 5, filtered: 3, reply_threads: 10, opt_outs: 1, qualified: 1, engaged: 2 }),
      rolling,
      lifetime: counts({ sends: 2000, delivered: 1880, failed: 120, filtered: 60, reply_threads: 200, opt_outs: 20, wrong_person: 6, qualified: 20, engaged: 35 }),
    },
    audience: { as_of: NOW, eligible_remaining: 5000 },
    templates: [{ template_id: "t1", sends: 700, filtered: 20, governance_paused: false, blocked: false }],
    review: { open_holds: 0 },
  };
  return deepMerge(base, overrides);
}

/** The 09-28 Minneapolis burst as the controller saw it at the next boundary. */
export function burstCampaign(overrides = {}) {
  const day = counts({ sends: 478, delivered: 282, failed: 179, filtered: 162, reply_threads: 26, opt_outs: 8, wrong_person: 1, engaged: 4 });
  return healthyCampaign(deepMerge({
    campaign_id: "camp-burst",
    market: "Minneapolis, MN",
    caps: { daily_cap: 750 },
    metrics: { recent: day, rolling: day, lifetime: day },
    templates: [{ template_id: "t9", sends: 478, filtered: 162, governance_paused: false, blocked: false }],
  }, overrides));
}

export function state(campaigns, { senders = { "Dallas, TX": { sendable: 2, degraded: 0 }, "Minneapolis, MN": { sendable: 3, degraded: 0 } }, asOf = NOW } = {}) {
  return { as_of: asOf, campaigns, senders_by_market: senders };
}

export const OPTIONS = Object.freeze({ now: NOW, guardrails: DEFAULT_DETERMINISTIC_LIMITS, killSwitch: { paused: true, reason: "absent" } });

export function envelope(overrides = {}) {
  return buildEnvelope({ version: "test", ...overrides });
}

export function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== "object" || Array.isArray(b) || a === null || typeof a !== "object" || Array.isArray(a)) return b;
  const out = { ...a };
  for (const key of Object.keys(b)) out[key] = deepMerge(a[key], b[key]);
  return out;
}

/** Seeded generator of arbitrary (often hostile) campaign states for property sweeps. */
export function randomCampaign(rand, i) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const n = (max) => Math.floor(rand() * max);
  const sends = n(1500);
  const delivered = n(sends + 1);
  const failed = n(sends - delivered + 1);
  const rt = n(Math.max(1, Math.floor(sends / 5)) + 1);
  const c = counts({ sends, delivered, failed, filtered: n(failed + 1), reply_threads: rt, opt_outs: n(rt + 1), wrong_person: n(Math.floor(rt / 3) + 1), qualified: n(Math.floor(rt / 4) + 1) });
  return {
    campaign_id: `rand-${i}`,
    status: pick(["active", "active", "activating", "paused", "draft", "completed", "live_limited", "failed", "scheduled", "built"]),
    market: pick(["Dallas, TX", "Dallas, TX", "Minneapolis, MN", "Minneapolis, MN", "Miami, FL"]),
    cohort: pick(["map_area", "map_area", "entity_graph", "saved_filter", "weird"]),
    strategy: pick(["ownership_check", "ownership_check", "ownership_check", "offer_present"]),
    timezone: pick(["America/Chicago", "America/Chicago", "America/New_York", "America/Denver", "", "Not/AZone", null]),
    caps: { daily_cap: pick([null, 0, 1, 50, 400, 750, 2000, 100000]), contact_window_start: pick(["08:00", "07:00", "09:30", "", null]), contact_window_end: pick(["21:00", "22:30", "20:00", null]) },
    metrics: { as_of: NOW, recent: rand() < 0.5 ? c : null, rolling: c, lifetime: counts({ ...c, sends: c.sends * 3, delivered: c.delivered * 3, failed: c.failed * 3, filtered: c.filtered * 3, reply_threads: c.reply_threads * 3, opt_outs: c.opt_outs * 3, wrong_person: c.wrong_person * 3, qualified: c.qualified * 3 }) },
    audience: rand() < 0.3 ? null : { as_of: NOW, eligible_remaining: n(5000) },
    templates: rand() < 0.3 ? null : [{ template_id: "x", sends: c.sends, filtered: c.filtered, governance_paused: rand() < 0.2, blocked: rand() < 0.1 }],
    review: rand() < 0.5 ? null : { open_holds: n(80) },
  };
}
