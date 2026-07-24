// ─── acquisition-brain/shadow-burst-timing.js ──────────────────────────────
// Deterministic burst segmentation + reply-timing planner (shadow only).
// Never creates production queue rows or invokes providers.

import { createHash } from "node:crypto";
import { buildShadowFactState } from "./shadow-fact-state.js";
import {
  FACT_CONTRACT_VERSION,
  FACT_TYPES,
  toJsonSafe,
} from "./fact-provenance-contract.js";
import { ACQUISITION_BRAIN_VERSION } from "./lifecycle-registry.js";

export const SHADOW_BURST_EVENT = "acquisition_brain_shadow_burst_plan";
export const BURST_PLANNER_VERSION = "acquisition_brain_burst_planner_v2";
export const BURST_DEBOUNCE_MIN_MS = 20_000;
export const BURST_DEBOUNCE_MAX_MS = 40_000;
export const MAX_BURST_DURATION_MS = 90_000;
/** Bounded lookback when loading open-burst context from message_events. */
export const BURST_LOOKBACK_MS = 5 * 60_000;
export const BURST_LOOKBACK_MAX_ROWS = 25;

export const TIMING_POLICIES = Object.freeze({
  ownership_confirmation: { min_ms: 25_000, max_ms: 75_000 },
  clear_proposal_interest: { min_ms: 25_000, max_ms: 75_000 },
  price_condition: { min_ms: 40_000, max_ms: 120_000 },
  complex_authority: { min_ms: 60_000, max_ms: 180_000 },
  urgent_compliant: { min_ms: 15_000, max_ms: 45_000 },
  human_review: { min_ms: null, max_ms: null, transport: false },
  terminal_no_reply: { min_ms: null, max_ms: null, transport: false },
  deferred_contact_window: { min_ms: null, max_ms: null, transport: false },
});

const CONTACT_OPEN_HOUR = 8;
const CONTACT_CLOSE_HOUR = 21;
const FALLBACK_TIMEZONE = "America/Chicago";

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

function msgId(m) {
  return clean(m?.id || m?.message_event_id);
}

function msgTs(m) {
  const raw = m?.timestamp || m?.received_at || m?.event_timestamp || m?.created_at;
  const n = Date.parse(raw || 0);
  return Number.isFinite(n) ? n : 0;
}

function msgTsIso(m) {
  const n = msgTs(m);
  return n ? new Date(n).toISOString() : null;
}

export function isValidIanaTimezone(tz) {
  const t = clean(tz);
  if (!t || t.length < 3) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: t }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Deterministic 0..1 from seed string. */
export function seededUnit(seed) {
  const hex = createHash("sha256").update(String(seed), "utf8").digest("hex");
  const n = parseInt(hex.slice(0, 8), 16);
  return n / 0xffffffff;
}

export function seededInRange(seed, min_ms, max_ms) {
  if (min_ms == null || max_ms == null) return null;
  const u = seededUnit(seed);
  return Math.round(min_ms + u * (max_ms - min_ms));
}

export function computeBurstId(thread_key, first_message_id) {
  return createHash("sha256")
    .update(`${clean(thread_key)}:${clean(first_message_id)}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function computeBurstContentHash(message_ids = [], timestamps = []) {
  const payload = (message_ids || [])
    .map((id, i) => `${clean(id)}@${timestamps[i] || ""}`)
    .join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}

export function orderInboundMessages(messages = []) {
  const seen = new Set();
  const deduped = [];
  for (const m of messages || []) {
    const id = msgId(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(m);
  }
  return deduped.sort((a, b) => {
    const ta = msgTs(a);
    const tb = msgTs(b);
    if (ta !== tb) return ta - tb;
    return msgId(a).localeCompare(msgId(b));
  });
}

function intentOf(m) {
  return clean(
    m?.classification?.primary_intent ||
      m?.detected_intent ||
      m?.primary_intent ||
      ""
  ).toLowerCase();
}

function isTerminalComplianceMessage(m) {
  const intent = intentOf(m);
  const body = clean(m?.message || m?.message_body).toUpperCase();
  if (intent === "opt_out" || body === "STOP" || body === "STOP." || /^STOP\b/.test(body)) {
    return { terminal: true, kind: "opt_out" };
  }
  if (intent === "wrong_number" || /wrong\s+number/i.test(body)) {
    return { terminal: true, kind: "wrong_number" };
  }
  if (
    intent === "never_owned" ||
    intent === "sold_property" ||
    intent === "ownership_denied" ||
    /never\s+owned|i\s+sold\s+it|not\s+the\s+owner/i.test(body)
  ) {
    return { terminal: true, kind: "ownership_denial" };
  }
  if (intent === "hostile" || /sue\s+you|lawyer|attorney|legal\s+action/i.test(body)) {
    return { terminal: true, kind: "legal_threat" };
  }
  return { terminal: false, kind: null };
}

/**
 * Pure burst segmentation. A thread is not automatically one burst.
 */
export function segmentInboundBursts({
  thread_key = null,
  ordered_messages = null,
  messages = null,
  debounce_min_ms = BURST_DEBOUNCE_MIN_MS,
  debounce_max_ms = BURST_DEBOUNCE_MAX_MS,
  max_burst_duration_ms = MAX_BURST_DURATION_MS,
} = {}) {
  const thread = clean(thread_key);
  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      reason: "non_e164_thread",
      bursts: [],
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const ordered = orderInboundMessages(ordered_messages || messages || []);
  if (!ordered.length) {
    return { ok: true, bursts: [], thread_key: thread };
  }

  const bursts = [];
  let open = null;

  const closeOpen = (reason, status = "closed") => {
    if (!open) return;
    open.status = status;
    open.closure_reason = reason;
    open.last_message_id = open.ordered_message_ids[open.ordered_message_ids.length - 1];
    bursts.push(open);
    open = null;
  };

  for (const m of ordered) {
    const id = msgId(m);
    const ts = msgTs(m);
    const ts_iso = new Date(ts).toISOString();
    const term = isTerminalComplianceMessage(m);

    if (!open) {
      const debounce_ms = seededInRange(
        `${thread}:${id}`,
        debounce_min_ms,
        debounce_max_ms
      );
      const hard_close_at_ms = ts + max_burst_duration_ms;
      const debounce_until_ms = Math.min(ts + debounce_ms, hard_close_at_ms);
      open = {
        burst_id: computeBurstId(thread, id),
        thread_key: thread,
        first_message_id: id,
        last_message_id: id,
        ordered_message_ids: [id],
        ordered_timestamps: [ts_iso],
        first_message_at: ts_iso,
        latest_message_at: ts_iso,
        debounce_ms,
        debounce_until: new Date(debounce_until_ms).toISOString(),
        hard_close_at: new Date(hard_close_at_ms).toISOString(),
        status: term.terminal ? "terminal" : "collecting",
        closure_reason: term.terminal ? term.kind : null,
        terminal_kind: term.terminal ? term.kind : null,
        messages: [m],
      };
      if (term.terminal) {
        closeOpen(term.kind, "terminal");
      }
      continue;
    }

    const hard_close_ms = Date.parse(open.hard_close_at);
    const debounce_until_ms = Date.parse(open.debounce_until);

    // Join only while burst open: within hard cap and within current debounce window
    const joins =
      ts <= hard_close_ms &&
      ts <= debounce_until_ms &&
      open.status === "collecting";

    if (!joins) {
      closeOpen(open.closure_reason || "debounce_or_hard_cap_elapsed", open.status === "terminal" ? "terminal" : "closed");
      // start new burst with this message
      const debounce_ms = seededInRange(
        `${thread}:${id}`,
        debounce_min_ms,
        debounce_max_ms
      );
      const hard_close_at_ms = ts + max_burst_duration_ms;
      const next_debounce_until = Math.min(ts + debounce_ms, hard_close_at_ms);
      open = {
        burst_id: computeBurstId(thread, id),
        thread_key: thread,
        first_message_id: id,
        last_message_id: id,
        ordered_message_ids: [id],
        ordered_timestamps: [ts_iso],
        first_message_at: ts_iso,
        latest_message_at: ts_iso,
        debounce_ms,
        debounce_until: new Date(next_debounce_until).toISOString(),
        hard_close_at: new Date(hard_close_at_ms).toISOString(),
        status: term.terminal ? "terminal" : "collecting",
        closure_reason: term.terminal ? term.kind : null,
        terminal_kind: term.terminal ? term.kind : null,
        messages: [m],
      };
      if (term.terminal) closeOpen(term.kind, "terminal");
      continue;
    }

    // Extend burst
    open.ordered_message_ids.push(id);
    open.ordered_timestamps.push(ts_iso);
    open.latest_message_at = ts_iso;
    open.last_message_id = id;
    open.messages.push(m);
    const extended_until = Math.min(ts + open.debounce_ms, hard_close_ms);
    open.debounce_until = new Date(extended_until).toISOString();
    if (term.terminal) {
      open.status = "terminal";
      open.terminal_kind = term.kind;
      open.closure_reason = term.kind;
      closeOpen(term.kind, "terminal");
    }
  }

  if (open) {
    // Leave collecting if still open; caller decides provisional vs final via now
    if (!open.closure_reason) open.closure_reason = null;
    bursts.push(open);
  }

  return {
    ok: true,
    thread_key: thread,
    bursts: bursts.map((b) => ({
      ...b,
      burst_content_hash: computeBurstContentHash(
        b.ordered_message_ids,
        b.ordered_timestamps
      ),
      message_count: b.ordered_message_ids.length,
    })),
  };
}

/**
 * Deterministic timezone resolution. Temporary fallback: America/Chicago.
 */
export function resolveShadowTimezone({
  property_timezone = null,
  campaign_timezone = null,
  sender_timezone = null,
  thread_timezone = null,
  operational_fallback = FALLBACK_TIMEZONE,
} = {}) {
  const chain = [
    { timezone: property_timezone, source: "property_market", confidence: "high" },
    { timezone: campaign_timezone, source: "campaign_market", confidence: "high" },
    { timezone: sender_timezone, source: "sender_market", confidence: "medium" },
    { timezone: thread_timezone, source: "thread_metadata", confidence: "medium" },
  ];
  for (const c of chain) {
    if (c.timezone && isValidIanaTimezone(c.timezone)) {
      return {
        timezone: clean(c.timezone),
        source: c.source,
        confidence: c.confidence,
        fallback_used: false,
        resolution_failure_reason: null,
      };
    }
    if (c.timezone && !isValidIanaTimezone(c.timezone)) {
      return {
        timezone: null,
        source: c.source,
        confidence: "none",
        fallback_used: false,
        resolution_failure_reason: `invalid_timezone:${clean(c.timezone)}`,
        human_review_required: true,
      };
    }
  }
  if (isValidIanaTimezone(operational_fallback)) {
    return {
      timezone: clean(operational_fallback),
      source: "operational_fallback",
      confidence: "low",
      fallback_used: true,
      resolution_failure_reason: null,
    };
  }
  return {
    timezone: null,
    source: "none",
    confidence: "none",
    fallback_used: false,
    resolution_failure_reason: "no_valid_timezone",
    human_review_required: true,
  };
}

function getZonedParts(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Find UTC instant for local wall time in timezone (handles DST via binary search).
 */
export function zonedLocalToUtc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  timezone = FALLBACK_TIMEZONE,
}) {
  // Approximate from UTC then refine
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 8; i += 1) {
    const p = getZonedParts(new Date(guess), timezone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = want - asUtc;
    if (Math.abs(delta) < 1000) break;
    guess += delta;
  }
  return new Date(guess);
}

/**
 * Contact-window evaluation for a specific planned timestamp (not merely now).
 * Allowed: local hour in [08:00, 21:00).
 */
export function evaluateContactWindowAt(planned_at, timezone = FALLBACK_TIMEZONE) {
  if (!isValidIanaTimezone(timezone)) {
    return {
      allowed: false,
      timezone: timezone || null,
      reason: "invalid_timezone",
      next_eligible_at: null,
      human_review_required: true,
    };
  }
  const d = planned_at instanceof Date ? planned_at : new Date(planned_at);
  if (!Number.isFinite(d.getTime())) {
    return {
      allowed: false,
      timezone,
      reason: "invalid_timestamp",
      next_eligible_at: null,
      human_review_required: true,
    };
  }
  const p = getZonedParts(d, timezone);
  const allowed = p.hour >= CONTACT_OPEN_HOUR && p.hour < CONTACT_CLOSE_HOUR;
  if (allowed) {
    return {
      allowed: true,
      timezone,
      reason: "inside_local_send_window",
      next_eligible_at: d.toISOString(),
      local_hour: p.hour,
      local_minute: p.minute,
    };
  }

  // Next opening: if before 08:00 same day; if after/at 21:00 next calendar day 08:00
  let y = p.year;
  let mo = p.month;
  let day = p.day;
  if (p.hour >= CONTACT_CLOSE_HOUR) {
    const noon = zonedLocalToUtc({
      year: y,
      month: mo,
      day,
      hour: 12,
      timezone,
    });
    const nextNoon = new Date(noon.getTime() + 24 * 60 * 60_000);
    const np = getZonedParts(nextNoon, timezone);
    y = np.year;
    mo = np.month;
    day = np.day;
  }
  const next = zonedLocalToUtc({
    year: y,
    month: mo,
    day,
    hour: CONTACT_OPEN_HOUR,
    minute: 0,
    second: 0,
    timezone,
  });
  return {
    allowed: false,
    timezone,
    reason: "outside_local_send_window",
    next_eligible_at: next.toISOString(),
    local_hour: p.hour,
    local_minute: p.minute,
  };
}

/** @deprecated prefer evaluateContactWindowAt — kept for call sites */
export function evaluateContactWindowShadow(now = new Date(), timezone = FALLBACK_TIMEZONE) {
  return evaluateContactWindowAt(now, timezone);
}

export function selectTimingPolicy(nba, facts = {}) {
  if (nba === "opt_out" || nba === "suppress") return "terminal_no_reply";
  if (facts.probate || facts.spouse_co_owner || facts.entity_type === "llc") {
    return "complex_authority";
  }
  if (nba === "request_asking_price" || nba === "confirm_interest") {
    return "clear_proposal_interest";
  }
  if (nba === "request_condition" || nba === "prepare_proposal_review") {
    return "price_condition";
  }
  if (nba === "request_ownership") return "ownership_confirmation";
  if (nba === "human_review") return "human_review";
  return "clear_proposal_interest";
}

function templateForNba(nba) {
  if (nba === "request_asking_price") return "seller_asking_price";
  if (nba === "confirm_interest") return "consider_selling";
  if (nba === "request_ownership") return "ownership_check";
  if (nba === "request_condition") return "condition_probe";
  return null;
}

/**
 * Correct reply-time equation:
 *   raw_reply_at = latest + selected_delay
 *   planned = max(debounce_until, raw_reply_at)
 *   then contact-window adjust
 */
export function computeReplyTiming({
  latest_message_at,
  debounce_until,
  debounce_ms = null,
  timing_label = "clear_proposal_interest",
  burst_seed = "",
  timezone = FALLBACK_TIMEZONE,
  terminal = false,
  timezone_resolution = null,
} = {}) {
  const latest_ms = Date.parse(latest_message_at);
  const debounce_ms_at = Date.parse(debounce_until);

  if (terminal || TIMING_POLICIES[timing_label]?.transport === false) {
    return {
      timing_policy: terminal ? "terminal_no_reply" : timing_label,
      timing_seed: `${burst_seed}:${timing_label}`,
      selected_reply_delay_ms: null,
      debounce_delay_ms: debounce_ms,
      raw_reply_at: null,
      planned_send_at_before_contact_window: null,
      final_planned_send_at: null,
      effective_delay_from_latest_message_ms: null,
      may_transport: false,
      contact_window: null,
    };
  }

  if (timezone_resolution?.resolution_failure_reason || !isValidIanaTimezone(timezone)) {
    return {
      timing_policy: "human_review",
      timing_seed: `${burst_seed}:${timing_label}`,
      selected_reply_delay_ms: null,
      debounce_delay_ms: debounce_ms,
      raw_reply_at: null,
      planned_send_at_before_contact_window: null,
      final_planned_send_at: null,
      effective_delay_from_latest_message_ms: null,
      may_transport: false,
      contact_window: {
        allowed: false,
        reason: timezone_resolution?.resolution_failure_reason || "invalid_timezone",
        human_review_required: true,
      },
    };
  }

  const range = TIMING_POLICIES[timing_label] || TIMING_POLICIES.clear_proposal_interest;
  const timing_seed = `${burst_seed}:${timing_label}`;
  const selected_reply_delay_ms = seededInRange(timing_seed, range.min_ms, range.max_ms);
  const raw_reply_at_ms = latest_ms + selected_reply_delay_ms;
  const planned_before_cw_ms = Math.max(debounce_ms_at, raw_reply_at_ms);
  const planned_before_cw = new Date(planned_before_cw_ms).toISOString();

  const cw = evaluateContactWindowAt(planned_before_cw_ms, timezone);
  let final_ms = planned_before_cw_ms;
  let timing_policy = timing_label;
  if (!cw.allowed) {
    timing_policy = "deferred_contact_window";
    final_ms = Date.parse(cw.next_eligible_at);
  }

  return {
    timing_policy,
    timing_seed,
    selected_reply_delay_ms,
    debounce_delay_ms: debounce_ms,
    raw_reply_at: new Date(raw_reply_at_ms).toISOString(),
    planned_send_at_before_contact_window: planned_before_cw,
    final_planned_send_at: new Date(final_ms).toISOString(),
    effective_delay_from_latest_message_ms: final_ms - latest_ms,
    may_transport: false,
    contact_window: cw,
    next_eligible_at: new Date(final_ms).toISOString(),
  };
}

function mergeFactsForMessages(messages, facts_before = []) {
  let seq_facts = Array.isArray(facts_before) ? [...facts_before] : [];
  let final_seq = null;
  for (const m of messages) {
    final_seq = buildShadowFactState({
      facts_before: seq_facts,
      message: m.message || m.message_body || "",
      classification: m.classification || {
        primary_intent: m.detected_intent || m.primary_intent || "unclear",
        confidence: m.confidence ?? m.classification_confidence ?? 0.9,
        language: m.language || null,
      },
      message_event_id: msgId(m),
      source_timestamp: msgTsIso(m),
    });
    seq_facts = final_seq.facts_after;
  }
  return final_seq;
}

/**
 * Plan a single segmented burst (not entire thread).
 * prior_plan_events: only real prior plans for supersession records.
 */
export function planShadowBurst({
  thread_key = null,
  messages = [],
  now = new Date(),
  timezone = null,
  timezone_context = null,
  facts_before = [],
  prior_plan_events = [],
  burst = null,
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);
  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      reason: "non_e164_thread",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const tz_res =
    timezone_context ||
    resolveShadowTimezone({
      property_timezone: timezone,
      operational_fallback: FALLBACK_TIMEZONE,
    });

  let segment = burst;
  if (!segment) {
    const seg = segmentInboundBursts({
      thread_key: thread,
      messages,
    });
    if (!seg.ok || !seg.bursts.length) {
      return {
        ok: false,
        reason: seg.reason || "empty_burst",
        may_enqueue: false,
        may_send: false,
        may_mutate_stages: false,
        segmentation: seg,
      };
    }
    // Plan the last burst that includes the latest message set provided
    segment = seg.bursts[seg.bursts.length - 1];
  }

  const burst_messages = segment.messages || messages;
  const final_seq = mergeFactsForMessages(burst_messages, facts_before);
  if (!final_seq) {
    return {
      ok: false,
      reason: "empty_burst",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const now_ms = (now instanceof Date ? now : new Date(now)).getTime();
  const debounce_until_ms = Date.parse(segment.debounce_until);
  const is_terminal =
    segment.status === "terminal" ||
    final_seq.proposed_next_best_action === "opt_out" ||
    final_seq.proposed_next_best_action === "suppress";

  let burst_status = segment.status;
  let plan_status = "provisional";
  if (is_terminal) {
    burst_status = "terminal";
    plan_status = "final_shadow";
  } else if (now_ms >= debounce_until_ms) {
    burst_status = "closed";
    plan_status = "final_shadow";
  } else {
    burst_status = "collecting";
    plan_status = "provisional";
  }

  const nba = final_seq.proposed_next_best_action;
  // Stage 7–10 never from seller text alone (mapFacts already enforces)
  const timing_label = selectTimingPolicy(nba, final_seq.fact_bag || {});
  const burst_seed = `${thread}:${segment.first_message_id}`;
  const timing = computeReplyTiming({
    latest_message_at: segment.latest_message_at,
    debounce_until: segment.debounce_until,
    debounce_ms: segment.debounce_ms,
    timing_label,
    burst_seed,
    timezone: tz_res.timezone || FALLBACK_TIMEZONE,
    terminal: is_terminal,
    timezone_resolution: tz_res,
  });

  // Only record supersession when a real prior plan event existed for this burst_id
  const content_hash =
    segment.burst_content_hash ||
    computeBurstContentHash(segment.ordered_message_ids, segment.ordered_timestamps);
  const superseded_reply_plans = [];
  for (const prev of prior_plan_events || []) {
    const p = prev?.payload || prev;
    if (!p) continue;
    if (p.burst_id !== segment.burst_id) continue;
    if (p.burst_content_hash === content_hash) continue;
    superseded_reply_plans.push({
      plan_id: prev.id || p.plan_id || null,
      dedupe_key: prev.dedupe_key || p.dedupe_key || null,
      prior_content_hash: p.burst_content_hash || null,
      reason: "superseded_by_newer_inbound",
    });
  }

  const plan = {
    burst_id: segment.burst_id,
    burst_content_hash: content_hash,
    burst_version: content_hash,
    planner_version: BURST_PLANNER_VERSION,
    thread_key: thread,
    first_message_id: segment.first_message_id,
    last_message_id: segment.last_message_id,
    first_message_at: segment.first_message_at,
    latest_message_at: segment.latest_message_at,
    debounce_ms: segment.debounce_ms,
    debounce_until: segment.debounce_until,
    hard_close_at: segment.hard_close_at,
    inbound_message_ids: segment.ordered_message_ids,
    burst_status,
    plan_status,
    closure_reason: segment.closure_reason,
    terminal_kind: segment.terminal_kind || null,
    facts_before: facts_before || [],
    facts_after: final_seq.facts_after,
    questions_already_answered: final_seq.questions_already_answered,
    questions_skipped_as_answered: final_seq.questions_already_answered,
    next_missing_fact: final_seq.next_missing_fact,
    final_proposed_nba: nba,
    final_template_use_case: templateForNba(nba),
    ...timing,
    // aliases for consumers
    selected_delay_ms: timing.selected_reply_delay_ms,
    planned_send_at: timing.final_planned_send_at,
    timezone_resolution: tz_res,
    superseded_reply_plans,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    may_transport: false,
    processing_duration_ms: Math.max(0, Date.now() - t0),
    fact_contract_version: FACT_CONTRACT_VERSION,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
  };

  // planned_send_at must never precede debounce_until or latest_message
  if (plan.final_planned_send_at) {
    const send_ms = Date.parse(plan.final_planned_send_at);
    const deb_ms = Date.parse(segment.debounce_until);
    const lat_ms = Date.parse(segment.latest_message_at);
    if (send_ms < deb_ms || send_ms < lat_ms) {
      // should only happen under deferred window which is still >= debounce usually
      // if deferred next open is after debounce, ok; enforce floor
      const floored = Math.max(send_ms, deb_ms, lat_ms);
      plan.final_planned_send_at = new Date(floored).toISOString();
      plan.planned_send_at = plan.final_planned_send_at;
      plan.effective_delay_from_latest_message_ms = floored - lat_ms;
    }
  }

  const dedupe_key = `acquisition_brain_shadow_burst_plan:${segment.burst_id}:${content_hash}:${BURST_PLANNER_VERSION}`;

  return {
    ok: true,
    plan: toJsonSafe(plan),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    event: {
      event_type: SHADOW_BURST_EVENT,
      dedupe_key,
      conversation_thread_id: thread,
      payload: toJsonSafe(plan),
    },
  };
}

/**
 * Plan all bursts from a message history (historical replay).
 */
export function planAllShadowBursts(input = {}) {
  const seg = segmentInboundBursts(input);
  if (!seg.ok) return { ok: false, ...seg, plans: [] };
  const plans = [];
  for (const burst of seg.bursts) {
    const r = planShadowBurst({
      ...input,
      messages: burst.messages,
      burst,
    });
    if (r.ok) plans.push(r);
  }
  return { ok: true, segmentation: seg, plans, bursts: seg.bursts };
}

/**
 * Load recent inbound messages for open-burst context (bounded).
 */
export async function loadRecentInboundForBurst({
  supabase = null,
  thread_key = null,
  now = new Date(),
  lookback_ms = BURST_LOOKBACK_MS,
  max_rows = BURST_LOOKBACK_MAX_ROWS,
} = {}) {
  const thread = clean(thread_key);
  if (!supabase?.from || !isCanonicalE164(thread)) {
    return {
      ok: false,
      messages: [],
      reason: !isCanonicalE164(thread) ? "non_e164_thread" : "missing_supabase",
    };
  }
  const since = new Date(
    (now instanceof Date ? now : new Date(now)).getTime() - lookback_ms
  ).toISOString();
  try {
    const { data, error } = await supabase
      .from("message_events")
      .select(
        "id,message_body,detected_intent,classification_confidence,language,created_at,received_at,event_timestamp,thread_key,direction"
      )
      .eq("direction", "inbound")
      .eq("thread_key", thread)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(max_rows);
    if (error) throw error;
    const messages = orderInboundMessages(
      (data || []).map((m) => ({
        id: m.id,
        message: m.message_body,
        message_body: m.message_body,
        detected_intent: m.detected_intent,
        classification: {
          primary_intent: m.detected_intent || "unclear",
          confidence: m.classification_confidence ?? 0.85,
          language: m.language || null,
        },
        language: m.language,
        timestamp: m.received_at || m.event_timestamp || m.created_at,
        created_at: m.created_at,
        received_at: m.received_at,
      }))
    );
    return {
      ok: true,
      messages,
      lookback_ms,
      max_rows,
      since,
      rows: messages.length,
    };
  } catch (error) {
    return {
      ok: false,
      messages: [],
      reason: error?.message || "history_load_failed",
      lookback_ms,
      max_rows,
    };
  }
}

export async function loadPriorBurstPlans({
  supabase = null,
  thread_key = null,
  limit = 5,
} = {}) {
  const thread = clean(thread_key);
  if (!supabase?.from || !isCanonicalE164(thread)) {
    return { ok: false, plans: [], reason: "unavailable" };
  }
  try {
    const { data, error } = await supabase
      .from("automation_events")
      .select("id,dedupe_key,payload,created_at,event_type")
      .eq("event_type", SHADOW_BURST_EVENT)
      .eq("conversation_thread_id", thread)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { ok: true, plans: data || [] };
  } catch (error) {
    return { ok: false, plans: [], reason: error?.message || "prior_plan_load_failed" };
  }
}

/**
 * Live shadow evaluation for current inbound (fail-open friendly pure core).
 */
export function evaluateShadowBurstForInbound({
  thread_key = null,
  current_message = null,
  recent_messages = [],
  prior_plan_events = [],
  facts_before = [],
  now = new Date(),
  timezone_context = null,
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);
  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      reason: "non_e164_or_archived_alias",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const combined = orderInboundMessages([
    ...(recent_messages || []),
    ...(current_message ? [current_message] : []),
  ]);
  if (!combined.length) {
    return {
      ok: false,
      reason: "empty_burst",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const seg = segmentInboundBursts({ thread_key: thread, messages: combined });
  if (!seg.ok || !seg.bursts.length) {
    return {
      ok: false,
      reason: seg.reason || "segmentation_failed",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  // Active burst is the one containing the current message id, else last
  const current_id = msgId(current_message) || msgId(combined[combined.length - 1]);
  let active =
    seg.bursts.find((b) => b.ordered_message_ids.includes(current_id)) ||
    seg.bursts[seg.bursts.length - 1];

  const planned = planShadowBurst({
    thread_key: thread,
    messages: active.messages,
    burst: active,
    now,
    facts_before,
    prior_plan_events,
    timezone_context:
      timezone_context || resolveShadowTimezone({ operational_fallback: FALLBACK_TIMEZONE }),
  });

  if (!planned.ok) return planned;

  return {
    ...planned,
    segmentation: {
      burst_count: seg.bursts.length,
      active_burst_id: active.burst_id,
      all_burst_ids: seg.bursts.map((b) => b.burst_id),
    },
    processing_duration_ms: Math.max(0, Date.now() - t0),
  };
}

export async function emitShadowBurstPlan(result, deps = {}) {
  const emit = deps.emitAutomationEvent;
  if (typeof emit !== "function" || !result?.event) {
    return { ok: false, reason: "emit_unavailable" };
  }
  try {
    const out = await emit(
      {
        event_type: result.event.event_type,
        dedupe_key: result.event.dedupe_key,
        source: "acquisition_brain_shadow",
        conversation_thread_id: result.event.conversation_thread_id,
        payload: result.event.payload,
      },
      deps.supabase ? { supabase: deps.supabase, supabaseClient: deps.supabase } : {}
    );
    return { ok: true, event: out };
  } catch (error) {
    return { ok: false, reason: error?.message || "emit_failed" };
  }
}

/**
 * Full live path: load context → segment → plan → emit (optional).
 */
export async function evaluateAndEmitShadowBurst({
  thread_key = null,
  current_message = null,
  facts_before = [],
  now = new Date(),
  timezone_context = null,
  supabase = null,
  emitAutomationEvent = null,
  emit = true,
} = {}) {
  const t0 = Date.now();
  let recent = { messages: [], ok: true };
  let prior = { plans: [], ok: true };

  try {
    recent = await loadRecentInboundForBurst({
      supabase,
      thread_key,
      now,
    });
  } catch {
    recent = { messages: [], ok: false, reason: "history_load_failed" };
  }

  try {
    prior = await loadPriorBurstPlans({ supabase, thread_key });
  } catch {
    prior = { plans: [], ok: false };
  }

  // Ensure current message is present even if not yet in DB
  const evaluation = evaluateShadowBurstForInbound({
    thread_key,
    current_message,
    recent_messages: recent.messages || [],
    prior_plan_events: prior.plans || [],
    facts_before,
    now,
    timezone_context,
  });

  let emit_result = { ok: false, skipped: true };
  if (emit && evaluation.ok && typeof emitAutomationEvent === "function") {
    try {
      emit_result = await emitShadowBurstPlan(evaluation, {
        emitAutomationEvent,
        supabase,
      });
    } catch (error) {
      emit_result = { ok: false, reason: error?.message || "emit_failed" };
    }
  }

  return {
    ...evaluation,
    load: {
      recent_ok: recent.ok !== false,
      recent_rows: (recent.messages || []).length,
      lookback_ms: BURST_LOOKBACK_MS,
      max_rows: BURST_LOOKBACK_MAX_ROWS,
      prior_plans: (prior.plans || []).length,
      prior_ok: prior.ok !== false,
    },
    emit: emit_result,
    total_duration_ms: Math.max(0, Date.now() - t0),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
  };
}

export default {
  SHADOW_BURST_EVENT,
  BURST_PLANNER_VERSION,
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  MAX_BURST_DURATION_MS,
  BURST_LOOKBACK_MS,
  BURST_LOOKBACK_MAX_ROWS,
  TIMING_POLICIES,
  seededUnit,
  seededInRange,
  computeBurstId,
  computeBurstContentHash,
  orderInboundMessages,
  segmentInboundBursts,
  resolveShadowTimezone,
  zonedLocalToUtc,
  evaluateContactWindowAt,
  evaluateContactWindowShadow,
  selectTimingPolicy,
  computeReplyTiming,
  planShadowBurst,
  planAllShadowBursts,
  loadRecentInboundForBurst,
  loadPriorBurstPlans,
  evaluateShadowBurstForInbound,
  emitShadowBurstPlan,
  evaluateAndEmitShadowBurst,
};
