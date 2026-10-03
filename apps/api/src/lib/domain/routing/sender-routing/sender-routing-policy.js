/**
 * SENDER ROUTING 2.0 — the one routing policy (owner brief 2026-10-02 §A).
 *
 * Two separate decisions:
 *   GEOGRAPHY  which pools are acceptable for the seller's market: the market's
 *              ordered routes in the operator-defined routing graph
 *              (market_sender_routes). Business geography, never state lines,
 *              mileage, same-market-only or a nationwide yes/no.
 *   HEALTH     which acceptable number actually sends: every eligibility gate,
 *              then the EXISTING allocator (sender-allocator.js) WITHIN a pool.
 *
 * Geographic priority comes BEFORE load balancing: routes are walked in
 * priority order and the first pool with an eligible number wins, however
 * lightly a later pool is used. Exhausted capacity is just another reason a
 * pool has no eligible number, so the walk moves on. Regional fallback is a
 * normal outcome, not an error.
 *
 * One policy, two callers: campaign planning (purpose 'proactive') and seller
 * replies / conversation follow-ups (purpose 'reply'). Thread continuity:
 *   reply      keep the thread's number when it is eligible and inside any of
 *              the market's allowed routes.
 *   proactive  keep it only when it is eligible, allowed AND its route is no
 *              lower than the best route that can send now (geography wins).
 * A reroute always records why (thread_reroute). Identity is never touched:
 * routing returns a sender, it never rewrites the seller or the thread.
 *
 * Operator override: explicit, audited (actor + reason required), never
 * automatic; it narrows the walk to one pool but still passes every
 * eligibility gate. A BLOCKED-NEVER route can never be overridden into.
 *
 * Nothing eligible anywhere in the market's graph -> a HOLD with
 * hold_reason 'no_eligible_sender_for_route' and per-pool failure context.
 *
 * Import-pure apart from the shared eligibility evaluator (no I/O).
 */

import { evaluateSenderDispatchEligibility } from "@/lib/domain/delivery/sender-dispatch-eligibility.js";
import { byUsageThenRecency } from "./sender-allocator.js";

export const SENDER_ROUTING_POLICY_VERSION = "sender_routing_v2@1";
export const HOLD_REASON = "no_eligible_sender_for_route";

export const AFFINITY_TIERS = Object.freeze({
  PRIMARY: "primary",
  PREFERRED: "preferred_fallback",
  REGIONAL: "regional_fallback",
  LAST_RESORT: "last_resort",
  BLOCKED: "blocked_never",
});
const TIER_SET = new Set(Object.values(AFFINITY_TIERS));

export const PURPOSES = Object.freeze({ PROACTIVE: "proactive", REPLY: "reply" });

/** Onboarding stages that may not carry production traffic (brief §B). */
const PRE_PRODUCTION_STAGES = new Set(["discovered", "configuring", "inbound_verified"]);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export function normalizeE164(value) {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

export function maskPhone(value) {
  const phone = normalizeE164(value);
  return phone ? `•••${phone.slice(-4)}` : null;
}

function positiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeMarketKey(value) {
  return lower(value).replace(/[^a-z0-9]+/g, " ").trim();
}

// ── graph ──────────────────────────────────────────────────────────────────

/**
 * Normalize raw graph rows (DB shape or fixture) into the policy's graph.
 *   markets       [{ id, display_name, state }]
 *   pools         [{ id?, pool_key, display_name, home_market_id, is_active }]
 *   pool_numbers  [{ sender_pool_id? | pool_key, textgrid_number_id, phone_number?, status }]
 *   routes        [{ id?, market_id, sender_pool_id? | pool_key, priority, affinity_tier, enabled, provenance?, notes? }]
 * Invalid rows are dropped and reported in graph.issues (never thrown).
 */
export function buildRoutingGraph({ markets = [], pools = [], pool_numbers = [], routes = [], version = null, source = "unknown" } = {}) {
  const issues = [];
  const marketMap = new Map();
  const marketByKey = new Map();
  for (const m of markets) {
    const id = clean(m?.id);
    if (!id) continue;
    const entry = { id, display_name: clean(m.display_name) || id, state: clean(m.state) || null };
    marketMap.set(id, entry);
    marketByKey.set(normalizeMarketKey(entry.display_name), id);
    marketByKey.set(normalizeMarketKey(id), id);
  }

  const poolById = new Map();
  const poolMap = new Map();
  for (const p of pools) {
    const key = clean(p?.pool_key);
    if (!key) continue;
    if (poolMap.has(key)) {
      issues.push({ code: "duplicate_pool_key", pool_key: key });
      continue;
    }
    const entry = {
      id: clean(p.id) || null,
      key,
      name: clean(p.display_name || p.name) || key,
      home_market_id: clean(p.home_market_id) || null,
      enabled: p.is_active !== false && p.enabled !== false,
    };
    poolMap.set(key, entry);
    if (entry.id) poolById.set(entry.id, key);
  }
  const poolKeyOf = (row) => clean(row?.pool_key) || poolById.get(clean(row?.sender_pool_id)) || null;

  const numbersByPool = new Map();
  const poolOfNumber = new Map();
  for (const n of pool_numbers) {
    const pool_key = poolKeyOf(n);
    const textgrid_number_id = clean(n?.textgrid_number_id) || null;
    const phone_number = normalizeE164(n?.phone_number) || null;
    if (!pool_key || !poolMap.has(pool_key) || !(textgrid_number_id || phone_number)) {
      issues.push({ code: "pool_number_unresolved", pool_key, textgrid_number_id });
      continue;
    }
    const identity = textgrid_number_id || phone_number;
    if (poolOfNumber.has(identity)) {
      // A number belongs to exactly one pool (no duplicate inventory).
      issues.push({ code: "number_in_two_pools", textgrid_number_id, phone_number, pools: [poolOfNumber.get(identity), pool_key] });
      continue;
    }
    poolOfNumber.set(identity, pool_key);
    const list = numbersByPool.get(pool_key) || [];
    list.push({ textgrid_number_id, phone_number, status: lower(n.status) || "active" });
    numbersByPool.set(pool_key, list);
  }

  const routeMap = new Map();
  for (const r of routes) {
    const market_id = clean(r?.market_id);
    const pool_key = poolKeyOf(r);
    const tier = lower(r?.affinity_tier);
    const priority = Number(r?.priority);
    if (!market_id || !pool_key || !poolMap.has(pool_key) || !TIER_SET.has(tier) || !Number.isFinite(priority)) {
      issues.push({ code: "route_invalid", market_id, pool_key, tier });
      continue;
    }
    if (marketMap.size && !marketMap.has(market_id)) {
      issues.push({ code: "route_market_not_canonical", market_id, pool_key });
      continue;
    }
    const list = routeMap.get(market_id) || [];
    if (list.some((x) => x.pool_key === pool_key)) {
      issues.push({ code: "duplicate_route", market_id, pool_key });
      continue;
    }
    list.push({
      route_id: clean(r.id) || `${market_id}:${pool_key}`,
      market_id,
      pool_key,
      priority,
      tier,
      enabled: r.enabled !== false,
      provenance: clean(r.provenance) || null,
      notes: clean(r.notes) || null,
    });
    routeMap.set(market_id, list);
  }
  for (const list of routeMap.values()) list.sort((a, b) => a.priority - b.priority || a.pool_key.localeCompare(b.pool_key));

  return Object.freeze({
    version: version ?? null,
    source,
    markets: marketMap,
    marketByKey,
    pools: poolMap,
    numbersByPool,
    poolOfNumber,
    routes: routeMap,
    issues,
  });
}

/** Canonical market id for an id or a label ("Indianapolis, IN"), else null. Never guesses. */
export function resolveGraphMarketId(graph, { market_id = null, market = null } = {}) {
  const id = clean(market_id);
  if (id && graph?.markets?.has(id)) return id;
  const byKey = graph?.marketByKey?.get(normalizeMarketKey(market || market_id));
  return byKey || null;
}

// ── eligibility ────────────────────────────────────────────────────────────

/**
 * Lifecycle derived from EXISTING fields (no new status values; the
 * textgrid_numbers.status CHECK allows only active|paused):
 *   retired          metadata.lifecycle_state = 'retired'
 *   discovered/configuring/inbound_verified/warming   metadata.onboarding_stage
 *   blocked          operator blocklist or health_state blocked
 *   cooling          health_state cooling or cooling_until in the future
 *   paused           status paused
 *   active           otherwise
 */
export function deriveLifecycleState(row, { blocked = null, now = new Date() } = {}) {
  if (!row) return "discovered";
  const meta = obj(row.metadata);
  if (lower(meta.lifecycle_state) === "retired") return "retired";
  const stage = lower(meta.onboarding_stage);
  if (PRE_PRODUCTION_STAGES.has(stage)) return stage;
  const phone = normalizeE164(row.phone_number);
  if ((blocked && blocked.has(phone)) || lower(row.health_state) === "blocked") return "blocked";
  const coolingTs = row.cooling_until ? new Date(row.cooling_until).getTime() : NaN;
  if (lower(row.health_state) === "cooling" || (Number.isFinite(coolingTs) && coolingTs > new Date(now).getTime())) return "cooling";
  if (lower(row.status) === "paused") return "paused";
  if (stage === "warming") return "warming";
  return "active";
}

export function webhookStateOf(row) {
  const meta = obj(row?.metadata);
  if (clean(meta.inbound_verified_at) || lower(meta.sms_webhook_status) === "verified") return "verified";
  const s = lower(meta.sms_webhook_status);
  if (s === "configured" || s === "missing") return s;
  return "unknown";
}

/** The number's effective daily limit: the smallest of daily_limit, the configured per-number cap and (warming) the warm-up limit. */
export function effectiveDailyLimit(row, { per_sender_cap = null } = {}) {
  const meta = obj(row?.metadata);
  const limits = [positiveInt(row?.daily_limit), positiveInt(per_sender_cap)];
  if (lower(meta.onboarding_stage) === "warming") limits.push(positiveInt(meta.warmup_daily_limit));
  const present = limits.filter((n) => n !== null);
  return present.length ? Math.min(...present) : null;
}

/**
 * Every eligibility gate, in a fixed order; the first failure is the reason.
 * Returns { ok, reason, remaining }.
 */
export function evaluateSenderEligibility(row, { blocked = null, now = new Date(), per_sender_cap = null, member_status = "active", campaign_sender_ids = null, ignore_daily_limit = false } = {}) {
  if (!row) return { ok: false, reason: "not_in_fleet", remaining: 0 };
  const meta = obj(row.metadata);
  const phone = normalizeE164(row.phone_number);
  if (lower(meta.lifecycle_state) === "retired") return { ok: false, reason: "retired", remaining: 0 };
  if (blocked && blocked.has(phone)) return { ok: false, reason: "blocked_by_operator", remaining: 0 };
  if (member_status && lower(member_status) !== "active") return { ok: false, reason: "pool_member_inactive", remaining: 0 };
  // THE CANONICAL SENDER DISPATCH ELIGIBILITY (blocklist + fleet + status /
  // health / cooling); the routing policy is a superset, never a subset.
  // daily_limit undefined: the cap is applied below with the configured cap and warm-up limit.
  const base = evaluateSenderDispatchEligibility({ ...row, daily_limit: undefined }, { blocked: blocked || new Set(), now });
  if (!base.ok) return { ok: false, reason: String(base.reason || "unavailable").replace(/^outbound_number_/, ""), remaining: 0 };
  if (lower(row.registration_status) !== "registered") return { ok: false, reason: "unregistered", remaining: 0 };
  if (webhookStateOf(row) !== "verified") return { ok: false, reason: "webhook_unverified", remaining: 0 };
  if (PRE_PRODUCTION_STAGES.has(lower(meta.onboarding_stage))) return { ok: false, reason: "onboarding_incomplete", remaining: 0 };
  if (campaign_sender_ids && campaign_sender_ids.size) {
    if (!campaign_sender_ids.has(clean(row.id)) && !campaign_sender_ids.has(phone)) return { ok: false, reason: "not_campaign_sender", remaining: 0 };
  }
  // A readiness question ("can this route send at all?") ignores today's cap.
  const limit = ignore_daily_limit ? null : effectiveDailyLimit(row, { per_sender_cap });
  const sent = Number(row.messages_sent_today) || 0;
  if (limit !== null && sent >= limit) return { ok: false, reason: "daily_limit_reached", remaining: 0 };
  return { ok: true, reason: null, remaining: limit === null ? null : limit - sent };
}

// ── selection ──────────────────────────────────────────────────────────────

function fleetIndex(fleet = []) {
  const byId = new Map();
  const byPhone = new Map();
  for (const row of Array.isArray(fleet) ? fleet : []) {
    if (!row) continue;
    if (clean(row.id)) byId.set(clean(row.id), row);
    const phone = normalizeE164(row.phone_number);
    if (phone) byPhone.set(phone, row);
  }
  return { byId, byPhone };
}

function memberRow(index, member) {
  return (member.textgrid_number_id && index.byId.get(member.textgrid_number_id)) || (member.phone_number && index.byPhone.get(member.phone_number)) || null;
}

function marketShortName(graph, market_id) {
  const name = graph?.markets?.get(market_id)?.display_name || market_id || "";
  return clean(name.split(",")[0]) || name;
}

export function isLocalPool(graph, pool_key, market_id) {
  const pool = graph?.pools?.get(pool_key);
  return Boolean(pool?.home_market_id && pool.home_market_id === market_id);
}

/** Internal operator copy. Never shown to the seller. */
export function routeLabel(graph, { pool_key, market_id }) {
  const pool = graph?.pools?.get(pool_key);
  const poolName = pool?.name || pool_key;
  if (isLocalPool(graph, pool_key, market_id)) return `Sending via ${poolName} local pool`;
  return `Sending via ${poolName} regional pool for ${marketShortName(graph, market_id)}`;
}

/** The legacy routing_tier vocabulary the dispatch health guard reads. */
function legacyTier(graph, pool_key, market_id) {
  return isLocalPool(graph, pool_key, market_id) ? "exact_market_match" : "approved_regional_fallback";
}

function evaluatePool(graph, route, index, eligibilityCtx) {
  const pool = graph.pools.get(route.pool_key);
  const members = graph.numbersByPool.get(route.pool_key) || [];
  const numbers = members.map((member) => {
    const row = memberRow(index, member);
    const verdict = evaluateSenderEligibility(row, { ...eligibilityCtx, member_status: member.status });
    return { member, row, verdict };
  });
  const eligible = numbers.filter((n) => n.verdict.ok).map((n) => n.row).sort(byUsageThenRecency);
  let pool_reason = null;
  if (!route.enabled) pool_reason = "route_disabled";
  else if (!pool?.enabled) pool_reason = "pool_disabled";
  else if (!members.length) pool_reason = "pool_has_no_numbers";
  else if (!eligible.length) {
    pool_reason = numbers.every((n) => n.verdict.reason === "daily_limit_reached") ? "capacity_exhausted" : "no_eligible_number";
  }
  const usable = !pool_reason;
  return {
    route,
    eligible: usable ? eligible : [],
    context: {
      pool_key: route.pool_key,
      pool_name: pool?.name || route.pool_key,
      tier: route.tier,
      priority: route.priority,
      local: isLocalPool(graph, route.pool_key, route.market_id),
      pool_reason,
      eligible_count: usable ? eligible.length : 0,
      remaining_capacity: usable ? eligible.reduce((sum, row) => {
        const v = numbers.find((n) => n.row === row)?.verdict;
        return v?.remaining === null || v?.remaining === undefined ? sum : sum + v.remaining;
      }, 0) : 0,
      numbers: numbers.map((n) => ({
        phone: maskPhone(n.member.phone_number || n.row?.phone_number),
        textgrid_number_id: n.member.textgrid_number_id || n.row?.id || null,
        reason: n.verdict.ok ? (usable ? null : pool_reason) : n.verdict.reason,
      })),
    },
  };
}

function picked(graph, { decision, row, evaluation, market_id, thread_reroute = null, pools_checked, override = null }) {
  const route = evaluation.route;
  return {
    ok: true,
    held: false,
    policy_version: SENDER_ROUTING_POLICY_VERSION,
    graph_version: graph.version,
    decision,
    market_id,
    number: {
      id: clean(row.id) || null,
      phone_number: normalizeE164(row.phone_number),
      market: clean(row.market) || null,
    },
    pool_key: route.pool_key,
    tier: route.tier,
    priority: route.priority,
    local: isLocalPool(graph, route.pool_key, market_id),
    routing_tier: legacyTier(graph, route.pool_key, market_id),
    label: routeLabel(graph, { pool_key: route.pool_key, market_id }),
    thread_reroute,
    override,
    pools_checked,
  };
}

function hold(graph, { market_id = null, market = null, cause, pools_checked = [], thread = null, override = null }) {
  return {
    ok: false,
    held: true,
    policy_version: SENDER_ROUTING_POLICY_VERSION,
    graph_version: graph?.version ?? null,
    hold_reason: HOLD_REASON,
    cause,
    market_id,
    market_label: market_id ? graph?.markets?.get(market_id)?.display_name || market_id : clean(market) || null,
    pools_checked,
    thread,
    override,
  };
}

/**
 * Select a sender.
 *   input { market_id?, market?, purpose: 'proactive'|'reply', thread_number?, override?: { pool_key, actor, reason }, campaign_sender_ids? }
 *   ctx   { graph, fleet (textgrid_numbers rows, derived sent-today), blocked: Set<E164>, now, per_sender_cap }
 */
export function selectSender(input = {}, ctx = {}) {
  const graph = ctx.graph;
  if (!graph) return hold(null, { market: input.market, cause: "graph_unavailable" });
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const blocked = ctx.blocked instanceof Set ? ctx.blocked : new Set((ctx.blocked || []).map(normalizeE164).filter(Boolean));
  const campaign_sender_ids = input.campaign_sender_ids
    ? new Set([...input.campaign_sender_ids].map((v) => (String(v).startsWith("+") || /^\d{10,11}$/.test(String(v)) ? normalizeE164(v) : clean(v))))
    : null;
  const eligibilityCtx = { blocked, now, per_sender_cap: ctx.per_sender_cap ?? null, campaign_sender_ids, ignore_daily_limit: ctx.ignore_daily_limit === true };
  const index = fleetIndex(ctx.fleet);
  const purpose = input.purpose === PURPOSES.REPLY ? PURPOSES.REPLY : PURPOSES.PROACTIVE;

  const market_id = resolveGraphMarketId(graph, input);
  if (!market_id) return hold(graph, { market: input.market || input.market_id, cause: "market_unresolved" });

  const allRoutes = graph.routes.get(market_id) || [];
  const neverPools = new Set(allRoutes.filter((r) => r.tier === AFFINITY_TIERS.BLOCKED).map((r) => r.pool_key));
  const routes = allRoutes.filter((r) => r.tier !== AFFINITY_TIERS.BLOCKED);

  // Operator override: one pool, every gate still applies, never into BLOCKED-NEVER.
  if (input.override) {
    const ov = obj(input.override);
    const pool_key = clean(ov.pool_key);
    const override = { pool_key, actor: clean(ov.actor) || null, reason: clean(ov.reason) || null };
    if (!override.actor || !override.reason) return hold(graph, { market_id, cause: "override_unaudited", override });
    if (!graph.pools.has(pool_key)) return hold(graph, { market_id, cause: "override_pool_unknown", override });
    if (neverPools.has(pool_key)) return hold(graph, { market_id, cause: "override_pool_blocked_for_market", override });
    const route = routes.find((r) => r.pool_key === pool_key) || { route_id: `override:${pool_key}`, market_id, pool_key, priority: 0, tier: "operator_override", enabled: true };
    const evaluation = evaluatePool(graph, { ...route, enabled: true }, index, eligibilityCtx);
    const pools_checked = [evaluation.context];
    if (!evaluation.eligible.length) return hold(graph, { market_id, cause: "override_pool_ineligible", pools_checked, override });
    return picked(graph, { decision: "operator_override", row: evaluation.eligible[0], evaluation, market_id, pools_checked, override });
  }

  if (!routes.length) return hold(graph, { market_id, cause: "market_has_no_routes" });

  const evaluations = routes.map((route) => evaluatePool(graph, route, index, eligibilityCtx));
  const pools_checked = evaluations.map((e) => e.context);
  const best = evaluations.find((e) => e.eligible.length) || null;

  // Thread continuity.
  let thread_reroute = null;
  let threadContext = null;
  const thread_phone = normalizeE164(input.thread_number);
  if (thread_phone) {
    const row = index.byPhone.get(thread_phone) || null;
    const thread_pool = graph.poolOfNumber.get(clean(row?.id)) || graph.poolOfNumber.get(thread_phone) || null;
    const evaluation = thread_pool ? evaluations.find((e) => e.route.pool_key === thread_pool) : null;
    const member = thread_pool ? (graph.numbersByPool.get(thread_pool) || []).find((m) => (m.textgrid_number_id && m.textgrid_number_id === clean(row?.id)) || m.phone_number === thread_phone) : null;
    const verdict = evaluateSenderEligibility(row, { ...eligibilityCtx, member_status: member?.status || "active" });
    threadContext = { phone: maskPhone(thread_phone), pool_key: thread_pool, eligible: verdict.ok, reason: verdict.reason };
    let reroute_reason = null;
    if (!verdict.ok) reroute_reason = `thread_number_${verdict.reason}`;
    else if (thread_pool && neverPools.has(thread_pool)) reroute_reason = "thread_number_pool_blocked_for_market";
    else if (!evaluation) reroute_reason = thread_pool ? "thread_number_pool_not_routed_for_market" : "thread_number_not_in_any_pool";
    else if (!evaluation.route.enabled || evaluation.context.pool_reason === "route_disabled" || evaluation.context.pool_reason === "pool_disabled") reroute_reason = "thread_number_route_disabled";
    else if (purpose === PURPOSES.PROACTIVE && best && evaluation.route.priority > best.route.priority) reroute_reason = "thread_number_lower_priority_than_available_route";
    if (!reroute_reason) {
      return picked(graph, { decision: "thread_continuity", row, evaluation, market_id, pools_checked });
    }
    thread_reroute = { from: maskPhone(thread_phone), from_pool: thread_pool, reason: reroute_reason };
  }

  if (!best) return hold(graph, { market_id, cause: "all_pools_ineligible", pools_checked, thread: threadContext });
  const result = picked(graph, { decision: "graph_route", row: best.eligible[0], evaluation: best, market_id, thread_reroute, pools_checked });
  if (thread_reroute) thread_reroute.to = maskPhone(result.number.phone_number);
  return result;
}

/** Plain-language hold explanation for operators ("Phoenix: Los Angeles pool all blocked; …"). */
export function describeHold(result) {
  if (!result?.held) return null;
  const market = result.market_label || "Unknown market";
  if (result.cause === "market_unresolved") return `${market}: market is not in the canonical registry; no route applies`;
  if (result.cause === "market_has_no_routes") return `${market}: no sender routes configured`;
  if (result.cause === "graph_unavailable") return "Routing graph unavailable";
  const parts = (result.pools_checked || []).map((p) => {
    const reasons = [...new Set(p.numbers.map((n) => n.reason).filter(Boolean))];
    return `${p.pool_name} (${p.tier}): ${p.pool_reason || "no eligible number"}${reasons.length ? ` [${reasons.join(", ")}]` : ""}`;
  });
  return `${market}: ${parts.join("; ") || result.cause}`;
}
