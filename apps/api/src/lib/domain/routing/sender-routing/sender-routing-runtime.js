/**
 * SENDER ROUTING 2.0 — the two production call sites, behind the double gate.
 *
 *   routeCandidateViaPolicy   campaign planning / launch readiness / cleanup
 *                             replies (supabase-candidate-feeder
 *                             chooseTextgridNumber). Returns a result in the
 *                             feeder's own shape.
 *   routeQueueRowViaPolicy    dispatch (sms-engine selectAvailableTextgridNumber):
 *                             auto-replies, manual inbox replies, deferred
 *                             follow-ups and campaign rows. Returns a result in
 *                             the runner's own shape.
 *
 * Both return NULL whenever Sender Routing 2.0 must not decide — gate off,
 * graph schema absent, graph unreadable — and the caller continues with the
 * legacy router unchanged. They are imported lazily by their callers only once
 * the synchronous env ceiling is on (senderRoutingCeiling), so with the gate
 * off nothing here is even loaded.
 *
 * Always-win rules stay where they are enforced today: the operator blocklist
 * (read here too and fail-closed), dispatch revalidation, the SMS health guard,
 * DNC / suppression, contact windows, template rules and canonical language
 * (sender market never decides language — nothing here reads or writes it).
 */

import { HOLD_REASON, PURPOSES, normalizeE164, selectSender, describeHold } from "./sender-routing-policy.js";
import { SENDER_ROUTING_FLAGS, isSenderRoutingFlagEnabled } from "./sender-routing-gate.js";
import { GRAPH_TABLES, loadRoutingGraph } from "./sender-routing-graph.js";

const clean = (value) => String(value ?? "").trim();

function toBlockedSet(value) {
  if (value instanceof Set) return new Set([...value].map(normalizeE164).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeE164).filter(Boolean));
  return null;
}

/** The dispatch guard's own blocklist (env + system_control), fail-closed: null when unreadable. */
async function loadBlockedSenders(deps = {}) {
  if (deps.blocked_sender_numbers) return toBlockedSet(deps.blocked_sender_numbers);
  try {
    const guard = await import("../../delivery/sms-health-guard.js");
    const system_control = await guard.loadSmsHealthGuardSystemControl(deps.getSystemValue || null);
    if (!system_control || system_control.sms_blocked_sender_numbers === undefined) return null;
    return toBlockedSet(guard.getDispatchBlockedSets(deps.env || process.env, system_control).sender_numbers);
  } catch {
    return null;
  }
}

async function loadPerSenderCap(deps = {}) {
  if (deps.per_sender_cap !== undefined) return deps.per_sender_cap;
  try {
    const { loadConfiguredPerSenderCap } = await import("../../campaigns/sender-capacity.js");
    return await loadConfiguredPerSenderCap(deps);
  } catch {
    return null;
  }
}

async function gateAndGraph(deps) {
  const gate = await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env: deps.env || process.env, readSystemValue: deps.readSystemFlag || null });
  if (!gate.enabled) return null;
  const loaded = await loadRoutingGraph(deps);
  if (!loaded.ok) return null;
  return loaded.graph;
}

/** Fail-open audit of a mid-thread sender change (never blocks a send). */
async function auditReroute(deps, payload) {
  try {
    if (typeof deps.auditSenderRouting === "function") return await deps.auditSenderRouting(payload);
    const supabase = deps.supabase || (await import("../../../supabase/client.js")).supabase;
    await supabase.from(GRAPH_TABLES.audit).insert({ event_type: "thread_reroute", actor: "sender_routing_v2", reason: payload.reason, subject: payload.subject, before: payload.before, after: payload.after });
  } catch {
    // audit is best-effort on the send path; the queue row metadata carries the same facts
  }
  return null;
}

function marketInput(source = {}) {
  const raw = source.raw && typeof source.raw === "object" ? source.raw : {};
  return {
    market_id: clean(source.canonical_market_id || raw.canonical_market_id || source.market_id) || null,
    market: clean(source.market || source.market_name || raw.market) || null,
  };
}

// ── campaign planning (feeder) ─────────────────────────────────────────────

export async function routeCandidateViaPolicy(candidate = {}, options = {}, deps = {}) {
  const graph = await gateAndGraph(deps);
  if (!graph) return null;

  const blocked = toBlockedSet(options.blocked_sender_numbers) || (await loadBlockedSenders(deps));
  if (!blocked) {
    return feederHold({ held: true, hold_reason: HOLD_REASON, cause: "sender_blocklist_unreadable", pools_checked: [] }, candidate);
  }
  const fleet = typeof deps.loadFleet === "function" ? await deps.loadFleet() : [];
  const per_sender_cap = options.ignore_daily_limit ? null : await loadPerSenderCap(deps);
  const purpose = options.sender_purpose === PURPOSES.REPLY ? PURPOSES.REPLY : PURPOSES.PROACTIVE;
  const result = selectSender(
    {
      ...marketInput(candidate),
      purpose,
      thread_number: candidate.thread_number || options.thread_number || null,
      override: options.sender_override || null,
      campaign_sender_ids: options.campaign_sender_ids || null,
    },
    { graph, fleet, blocked, now: deps.now || new Date(), per_sender_cap, ignore_daily_limit: options.ignore_daily_limit === true }
  );
  if (!result.ok) return feederHold(result, candidate);
  return {
    ok: true,
    reason_code: "OK",
    routing_allowed: true,
    routing_tier: result.routing_tier,
    selection_reason: `sender_routing_v2:${result.decision}:${result.pool_key}`,
    routing_rule_name: "sender_routing_v2",
    selected_textgrid_market: result.number.market,
    selected_textgrid_number: result.number.phone_number,
    seller_market: candidate.market || null,
    seller_state: candidate.state || null,
    rejected_candidate_count: 0,
    routing_block_reason: null,
    selected: { id: result.number.id, phone_number: result.number.phone_number, market: result.number.market },
    sender_routing: result,
  };
}

function feederHold(result, candidate) {
  return {
    ok: false,
    reason_code: "ROUTING_BLOCKED",
    routing_allowed: false,
    routing_tier: "held",
    selection_reason: null,
    routing_rule_name: "sender_routing_v2",
    selected_textgrid_market: null,
    selected_textgrid_number: null,
    seller_market: candidate.market || null,
    seller_state: candidate.state || null,
    rejected_candidate_count: 0,
    routing_block_reason: "NO_ELIGIBLE_SENDER_FOR_ROUTE",
    hold_reason: HOLD_REASON,
    hold_detail: describeHold(result),
    local_sender_inventory: [],
    selected: null,
    sender_routing: result,
  };
}

// ── dispatch (runner) ──────────────────────────────────────────────────────

async function loadThreadNumber(row, deps) {
  const pinned = normalizeE164(row.from_phone_number);
  if (pinned) return pinned;
  const thread_key = clean(row.thread_key || row.metadata?.thread_key);
  if (!thread_key) return null;
  if (typeof deps.loadThreadOurNumber === "function") return normalizeE164(await deps.loadThreadOurNumber(thread_key)) || null;
  const supabase = deps.supabase || (await import("../../../supabase/client.js")).supabase;
  const { data } = await supabase.from("inbox_thread_state").select("our_number").eq("thread_key", thread_key).maybeSingle();
  return normalizeE164(data?.our_number) || null;
}

async function loadRowMarket(row, deps) {
  const direct = marketInput(row);
  const property_id = clean(row.property_id || row.metadata?.property_id);
  if (!property_id) return direct;
  try {
    if (typeof deps.loadPropertyMarketId === "function") {
      const id = clean(await deps.loadPropertyMarketId(property_id));
      return id ? { ...direct, market_id: id } : direct;
    }
    const supabase = deps.supabase || (await import("../../../supabase/client.js")).supabase;
    const { data } = await supabase.from("properties").select("canonical_market_id").eq("property_id", property_id).maybeSingle();
    return data?.canonical_market_id ? { ...direct, market_id: data.canonical_market_id } : direct;
  } catch {
    return direct;
  }
}

/** Purpose of a queue row: campaign touches are proactive; everything on a conversation is a reply. */
export function queueRowPurpose(row = {}) {
  return clean(row.campaign_id) ? PURPOSES.PROACTIVE : PURPOSES.REPLY;
}

export async function routeQueueRowViaPolicy(row = {}, deps = {}) {
  const graph = await gateAndGraph(deps);
  if (!graph) return null;

  const blocked = await loadBlockedSenders(deps);
  if (!blocked) {
    return { ok: false, reason: "sender_blocklist_unreadable", deferred: true, ineligible_sender: true, selected: null, from_phone_number: normalizeE164(row.from_phone_number) || null };
  }
  const [fleet, thread_number, market, per_sender_cap] = await Promise.all([
    typeof deps.loadFleet === "function" ? deps.loadFleet() : [],
    loadThreadNumber(row, deps),
    loadRowMarket(row, deps),
    loadPerSenderCap(deps),
  ]);
  const override = row.metadata?.sender_override && row.metadata.sender_override.actor ? row.metadata.sender_override : null;
  // A CONVERSATIONAL send (send-class.js) is not capped by the cold daily
  // limit; the base eligibility still applies the total-sends ceiling.
  const conversational = String(deps.send_class || "").toLowerCase() === "conversational";
  const result = selectSender(
    { ...market, purpose: queueRowPurpose(row), thread_number, override },
    { graph, fleet, blocked, now: deps.now || new Date(), per_sender_cap, ignore_daily_limit: conversational }
  );
  const pinned = normalizeE164(row.from_phone_number) || null;
  if (!result.ok) {
    // PARK: not a send failure, no retry consumed (blockQueueRowByIneligibleSender).
    return { ok: false, reason: HOLD_REASON, ineligible_sender: true, terminal: false, selected: null, from_phone_number: pinned, sender_routing: result };
  }
  const chosen = result.number.phone_number;
  if (pinned && chosen !== pinned) {
    await auditReroute(deps, {
      reason: result.thread_reroute?.reason || "rerouted",
      subject: { queue_row_id: row.id || null, thread_key: row.thread_key || null, market_id: result.market_id },
      before: { from_phone_number: pinned },
      after: { from_phone_number: chosen, pool_key: result.pool_key, tier: result.tier, graph_version: result.graph_version },
    });
  }
  return {
    ok: true,
    selected: { id: result.number.id, phone_number: chosen, metadata: {} },
    from_phone_number: chosen,
    reason: pinned && chosen === pinned ? "sender_routing_v2_revalidated" : `sender_routing_v2_${result.decision}`,
    sender_routing: result,
  };
}

