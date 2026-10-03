/**
 * SENDER ROUTING 2.0 — park / wake (owner brief §A "Smart holds").
 *
 * PARK. A send with no eligible sender anywhere in its market's graph is
 * parked by the runner as queue_status 'blocked_sender_ineligible' with
 * guard_reason 'no_eligible_sender_for_route' and metadata.sender_route_hold
 * (market, pools checked, why each failed). Parking is NOT a send failure: no
 * provider call, no retry consumed, no every-few-minutes retry burn.
 *
 * WAKE. A lightweight re-evaluation re-runs NORMAL selection (selectSender)
 * for parked rows when the inventory or graph changes — number activated,
 * cooling expired, block removed, registration change, number added, graph
 * edit, manual retry — and on a periodic sweep. Change is detected by an
 * inventory fingerprint (which numbers are eligible now + graph version), so
 * a sweep with nothing new does no row work at all.
 *
 * It NEVER force-sends and never pins a sender: an applied wake only returns
 * the row to 'queued' / 'scheduled' (compare-and-set on the parked state), and
 * the runner then selects, revalidates, guards and sends exactly as for any
 * other row. Apply needs the routing gate AND its own wake-apply gate; the
 * default everywhere is a dry run that writes nothing.
 */

import crypto from "node:crypto";
import { HOLD_REASON, PURPOSES, evaluateSenderEligibility, normalizeE164, selectSender, describeHold } from "./sender-routing-policy.js";

export const PARKED_QUEUE_STATUS = "blocked_sender_ineligible";

/** Sender-side park reasons a wake may lift (routing holds + legacy single-sender ineligibility). */
export const WAKEABLE_REASONS = Object.freeze(new Set([
  HOLD_REASON,
  "outbound_number_health_cooling",
  "outbound_number_cooling_until",
  "outbound_number_status_paused",
  "outbound_number_daily_limit_reached",
  "outbound_number_not_in_fleet",
]));

export const WAKE_TRIGGERS = Object.freeze([
  "number_activated",
  "cooling_expired",
  "block_removed",
  "registration_changed",
  "number_added",
  "graph_changed",
  "manual_retry",
  "periodic",
]);

const clean = (value) => String(value ?? "").trim();

export function isParkedForSender(row = {}) {
  if (clean(row.queue_status) !== PARKED_QUEUE_STATUS) return false;
  const reason = clean(row.guard_reason || row.failed_reason || row.metadata?.skip_reason);
  return WAKEABLE_REASONS.has(reason);
}

/** Which numbers can send right now, plus the graph version. Same input -> same hash. */
export function inventoryFingerprint({ graph = null, fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null } = {}) {
  const eligible = (fleet || [])
    .filter((row) => evaluateSenderEligibility(row, { blocked, now, per_sender_cap }).ok)
    .map((row) => normalizeE164(row.phone_number))
    .sort();
  const routes = graph ? [...graph.routes.entries()].map(([m, list]) => `${m}:${list.filter((r) => r.enabled).map((r) => `${r.pool_key}@${r.priority}/${r.tier}`).join(",")}`).sort() : [];
  const members = graph ? [...graph.numbersByPool.entries()].map(([p, list]) => `${p}:${list.filter((m) => m.status === "active").map((m) => m.textgrid_number_id || m.phone_number).sort().join(",")}`).sort() : [];
  const payload = JSON.stringify({ v: graph?.version ?? null, eligible, routes, members });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Re-run normal selection for parked rows. Pure.
 *   rows   [{ id, queue_status, guard_reason, campaign_id, from_phone_number, thread_number, market_id, market, scheduled_for_utc }]
 * Returns per-row outcome: 'routable' (would wake) | 'still_parked' | 'not_parked'.
 */
export function reevaluateParkedSends({ rows = [], graph, fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null } = {}) {
  return rows.map((row) => {
    if (!isParkedForSender(row)) return { id: row.id, outcome: "not_parked" };
    const result = selectSender(
      {
        market_id: row.market_id || null,
        market: row.market || null,
        purpose: clean(row.campaign_id) ? PURPOSES.PROACTIVE : PURPOSES.REPLY,
        thread_number: row.thread_number || row.from_phone_number || null,
      },
      { graph, fleet, blocked, now, per_sender_cap }
    );
    if (!result.ok) return { id: row.id, outcome: "still_parked", cause: result.cause, detail: describeHold(result), sender_routing: result };
    const due = row.scheduled_for_utc ? new Date(row.scheduled_for_utc).getTime() : 0;
    return {
      id: row.id,
      outcome: "routable",
      wake_status: due > new Date(now).getTime() ? "scheduled" : "queued",
      pool_key: result.pool_key,
      tier: result.tier,
      decision: result.decision,
      label: result.label,
      // informational only: the runner re-selects at send time; a wake never pins a number
      would_use: result.number.phone_number,
    };
  });
}

/**
 * One sweep. deps: { loadParkedRows(), loadGraph(), loadFleet(), loadBlocked(),
 *   perSenderCap, lastFingerprint, applyWake(row_id, wake_status, note), now,
 *   gates: { routing: bool, wakeApply: bool } }
 * apply=true is honoured only when both gates are on; otherwise it is a dry run.
 */
export async function runWakeSweep({ trigger = "periodic", apply = false, force = false } = {}, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  if (!WAKE_TRIGGERS.includes(trigger)) return { ok: false, reason: "unknown_trigger", trigger };
  if (!deps.gates?.routing) return { ok: true, skipped: true, reason: "sender_routing_gate_off", trigger, writes: 0 };
  const graph = await deps.loadGraph();
  if (!graph) return { ok: true, skipped: true, reason: "graph_unavailable", trigger, writes: 0 };
  const [fleet, blocked] = await Promise.all([deps.loadFleet(), deps.loadBlocked()]);
  if (!blocked) return { ok: true, skipped: true, reason: "sender_blocklist_unreadable", trigger, writes: 0 };
  const fingerprint = inventoryFingerprint({ graph, fleet, blocked, now, per_sender_cap: deps.perSenderCap ?? null });
  if (!force && trigger === "periodic" && deps.lastFingerprint && deps.lastFingerprint === fingerprint) {
    return { ok: true, skipped: true, reason: "inventory_unchanged", trigger, fingerprint, writes: 0 };
  }
  const rows = await deps.loadParkedRows();
  const outcomes = reevaluateParkedSends({ rows, graph, fleet, blocked, now, per_sender_cap: deps.perSenderCap ?? null });
  const mayApply = apply === true && deps.gates?.wakeApply === true && typeof deps.applyWake === "function";
  let writes = 0;
  if (mayApply) {
    for (const o of outcomes) {
      if (o.outcome !== "routable") continue;
      const changed = await deps.applyWake(o.id, o.wake_status, { trigger, fingerprint, pool_key: o.pool_key, tier: o.tier, evaluated_at: now.toISOString() });
      if (changed) writes += 1;
    }
  }
  return {
    ok: true,
    trigger,
    fingerprint,
    dry_run: !mayApply,
    parked: outcomes.filter((o) => o.outcome !== "not_parked").length,
    routable: outcomes.filter((o) => o.outcome === "routable").length,
    still_parked: outcomes.filter((o) => o.outcome === "still_parked").length,
    writes,
    outcomes,
  };
}
