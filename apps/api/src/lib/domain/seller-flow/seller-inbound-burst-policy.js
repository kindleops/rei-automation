// ─── seller-inbound-burst-policy.js ──────────────────────────────────────────
// Deterministic, pure seller-inbound burst timing + aggregation + safety policy.
//
// Reuses the existing shadow burst window floors from acquisition-brain
// (shadow-burst-timing.js) but NEVER uses seeded random debounce. Production
// debounce is a fixed trailing-edge interval.
//
// This module has zero I/O and is safe for unit tests with injected `now`.

import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

/**
 * Fixed trailing-edge quiet window.
 * Evidence: shadow planner BURST_DEBOUNCE_MIN_MS = 20_000 (floor of 20–40s
 * seeded range). Production forbids probabilistic timing, so we pin the floor.
 */
export const SELLER_INBOUND_BURST_DEBOUNCE_MS = 20_000;

/**
 * Hard cap for a single generation, aligned with shadow MAX_BURST_DURATION_MS.
 * Prevents a never-ending open burst when messages trickle forever.
 */
export const SELLER_INBOUND_BURST_MAX_DURATION_MS = 90_000;

/**
 * Claim lease: a claimed burst whose worker died becomes reclaimable after
 * this interval. Long enough for a slow V2 turn (webhook budget is 300s),
 * short enough that a crashed worker cannot strand a seller reply for long.
 */
export const SELLER_INBOUND_BURST_CLAIM_LEASE_MS = 300_000;

/**
 * At-least-once retry bound: a burst reclaimed more than this many times is
 * finalized as failed (explicit, observable) instead of retrying forever.
 */
export const SELLER_INBOUND_BURST_MAX_ATTEMPTS = 5;

export const SELLER_INBOUND_BURST_POLICY_VERSION = "seller_inbound_burst_policy_v1";

export const BURST_STATUSES = Object.freeze({
  OPEN: "open",
  CLAIMED: "claimed",
  COMPLETED: "completed",
  SUPPRESSED: "suppressed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const SAFETY_KINDS = Object.freeze({
  OPT_OUT: "opt_out",
  WRONG_NUMBER: "wrong_number",
  HOSTILE_OR_LEGAL: "hostile_or_legal",
  CONTACT_SUPPRESSION: "contact_suppression",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function parseIsoMs(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : fallback;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Canonical grouping key: resolved E.164 thread_key (never raw phone alone
 * when resolveCanonicalInboundThreadKey already produced a thread).
 */
export function resolveBurstGroupKey({ thread_key = null, inbound_from = null } = {}) {
  const key = clean(thread_key) || clean(inbound_from);
  if (!key) return null;
  // Prefer E.164; bare 10-digit is normalized by inbound handler before here.
  return key;
}

/**
 * Immediate safety latch signals — must not wait for debounce flush.
 * Body + optional classification intent. Fail closed on known terminals.
 */
export function detectImmediateSafetySignal({
  message = "",
  classification = null,
  intent = null,
} = {}) {
  const body = clean(message);
  const upper = body.toUpperCase();
  const primary = lower(
    intent ||
      classification?.primary_intent ||
      classification?.detected_intent ||
      ""
  );
  const secondary = [
    ...(Array.isArray(classification?.secondary_intents)
      ? classification.secondary_intents
      : []),
    classification?.secondary_intent,
  ]
    .filter(Boolean)
    .map(lower);

  const compliance = lower(classification?.compliance_flag);

  if (
    primary === "opt_out" ||
    secondary.includes("opt_out") ||
    compliance === "stop_texting" ||
    upper === "STOP" ||
    upper === "STOP." ||
    /^STOP\b/.test(upper) ||
    /\b(stop texting|stop messaging|remove me|unsubscribe|do not (text|contact)|don't text)\b/i.test(
      body
    )
  ) {
    return { latch: true, kind: SAFETY_KINDS.OPT_OUT, reason: "opt_out_or_stop" };
  }

  if (
    primary === "wrong_number" ||
    primary === "wrong_person" ||
    /\bwrong number\b/i.test(body)
  ) {
    return { latch: true, kind: SAFETY_KINDS.WRONG_NUMBER, reason: "wrong_number" };
  }

  if (
    primary === "hostile_or_legal" ||
    /\b(i will sue|i'll sue|lawyer|attorney|legal action|cease and desist)\b/i.test(body)
  ) {
    return {
      latch: true,
      kind: SAFETY_KINDS.HOSTILE_OR_LEGAL,
      reason: "hostile_or_legal",
    };
  }

  return { latch: false, kind: null, reason: null };
}

/**
 * Trailing-edge eligibility: each append restarts debounce from last_received_at,
 * never beyond first_received_at + hard cap.
 */
export function computeEligibleAt({
  first_received_at,
  last_received_at,
  debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
  max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
} = {}) {
  const firstMs = parseIsoMs(first_received_at);
  const lastMs = parseIsoMs(last_received_at, firstMs);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) {
    throw new Error("invalid_burst_timestamps");
  }
  const hardCloseMs = firstMs + max_duration_ms;
  const trailingMs = lastMs + debounce_ms;
  return toIso(Math.min(trailingMs, hardCloseMs));
}

export function computeHardCloseAt({
  first_received_at,
  max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
} = {}) {
  const firstMs = parseIsoMs(first_received_at);
  if (!Number.isFinite(firstMs)) throw new Error("invalid_burst_first_received_at");
  return toIso(firstMs + max_duration_ms);
}

export function isBurstEligible({ eligible_at, now } = {}) {
  const eligibleMs = parseIsoMs(eligible_at);
  const nowMs = parseIsoMs(now, Date.now());
  if (!Number.isFinite(eligibleMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= eligibleMs;
}

/**
 * Single claimability authority shared by every store implementation.
 *
 * Invariants:
 *  - completed_at set → never claimable again (completed AND finalized-
 *    suppressed bursts are terminal).
 *  - status=claimed → reclaimable ONLY after the claim lease expired
 *    (crash recovery); a fresh claim can never be stolen.
 *  - status=open/suppressed with a live claim lease (in-flight suppressed
 *    finalize) → not claimable until the lease expires.
 *  - failed / cancelled → terminal, never claimable.
 */
export function isClaimableBurst({
  burst,
  now,
  lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
} = {}) {
  if (!burst) return false;
  if (burst.completed_at) return false;
  const nowMs = parseIsoMs(now, Date.now());
  const claimedMs = parseIsoMs(burst.claimed_at, null);
  const leaseActive =
    Number.isFinite(claimedMs) && nowMs < claimedMs + Number(lease_ms || 0);
  if (burst.status === BURST_STATUSES.CLAIMED) {
    return Number.isFinite(claimedMs) && !leaseActive;
  }
  if (
    burst.status === BURST_STATUSES.OPEN ||
    burst.status === BURST_STATUSES.SUPPRESSED
  ) {
    if (leaseActive) return false;
    return isBurstEligible({ eligible_at: burst.eligible_at, now: nowMs });
  }
  return false;
}

/**
 * Deterministic constituent identity for dedupe (provider message id preferred).
 */
export function constituentKey(message = {}) {
  return (
    clean(message.provider_message_id) ||
    clean(message.event_id) ||
    clean(message.id) ||
    clean(message.inbound_event_id) ||
    null
  );
}

/**
 * Merge ordered unique constituents. Duplicates (same provider id) are ignored
 * and must NOT extend the deadline.
 */
export function appendConstituent(existing = [], next = {}) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const key = constituentKey(next);
  if (key && list.some((m) => constituentKey(m) === key)) {
    return { constituents: list, appended: false, duplicate: true };
  }
  const row = {
    event_id: clean(next.event_id || next.inbound_event_id || next.id) || null,
    provider_message_id: clean(next.provider_message_id) || null,
    body: clean(next.body ?? next.message ?? next.message_body),
    received_at: next.received_at || next.inbound_received_at || null,
  };
  if (!row.body && !row.provider_message_id && !row.event_id) {
    return { constituents: list, appended: false, duplicate: false };
  }
  list.push(row);
  list.sort((a, b) => {
    const ta = parseIsoMs(a.received_at, 0);
    const tb = parseIsoMs(b.received_at, 0);
    if (ta !== tb) return ta - tb;
    return String(constituentKey(a) || "").localeCompare(String(constituentKey(b) || ""));
  });
  return { constituents: list, appended: true, duplicate: false };
}

/** Chronological constituent order shared by aggregation + price reduction. */
export function orderBurstConstituents(constituents = []) {
  return [...(constituents || [])].sort((a, b) => {
    const ta = parseIsoMs(a.received_at, 0);
    const tb = parseIsoMs(b.received_at, 0);
    if (ta !== tb) return ta - tb;
    return String(constituentKey(a) || "").localeCompare(String(constituentKey(b) || ""));
  });
}

/**
 * Deterministic aggregation for a single V2/classifier turn.
 * Newline-delimited bodies preserve chronological order and clause boundaries
 * for the existing heuristic classifier / fact extractor (no AI).
 */
export function aggregateBurstMessage(constituents = []) {
  const ordered = orderBurstConstituents(constituents);
  const bodies = ordered.map((m) => clean(m.body)).filter(Boolean);
  return {
    message: bodies.join("\n"),
    message_count: bodies.length,
    ordered_event_ids: ordered.map((m) => m.event_id).filter(Boolean),
    ordered_provider_ids: ordered.map((m) => m.provider_message_id).filter(Boolean),
    first_received_at: ordered[0]?.received_at || null,
    last_received_at: ordered[ordered.length - 1]?.received_at || null,
  };
}

/**
 * Burst-aware asking-price reduction: latest-explicit-value wins.
 *
 * Each constituent is evaluated INDIVIDUALLY with the existing single-message
 * monetary authority (resolveAskingPriceSignal — semantics unchanged), then
 * folded chronologically:
 *
 *  - A constituent that yields a canonical unambiguous asking price becomes
 *    the effective price, superseding any earlier in-burst price
 *    ("$350k" → "Actually $325k" ⇒ 325000).
 *  - A constituent whose own price statements are internally conflicting
 *    (clarification_reason=conflicting_price_statements) fails the burst
 *    closed: the seller's latest explicit statement is self-contradictory, so
 *    no price is promoted and clarification is surfaced.
 *  - A low-confidence/ambiguous mention ("Actually maybe 325") NEVER
 *    overrides an earlier canonical price — mirroring single-message policy,
 *    where low-confidence mentions are excluded from canonical resolution.
 *    (If the caller supplies a deal-level `reference`, bare-number scaling is
 *    whatever resolveAskingPriceSignal already permits — existing policy.)
 *  - A constituent with no promotable price ("Actually ignore that") never
 *    fabricates or clears a replacement amount.
 *
 * Returns the same shape as resolveAskingPriceSignal plus burst audit fields.
 */
export function resolveBurstAskingPriceSignal(constituents = [], {
  reference = null,
  negotiationActive = false,
  now = null,
} = {}) {
  const ordered = orderBurstConstituents(constituents);
  let canonical = null;
  let clarification = null;
  const informational_mentions = [];
  const all_mentions = [];
  const superseded_values = [];

  for (const fragment of ordered) {
    const body = clean(fragment?.body ?? fragment?.message);
    if (!body) continue;
    const signal = resolveAskingPriceSignal(body, {
      reference,
      negotiationActive,
      sourceMessageId: constituentKey(fragment),
      now,
    });
    informational_mentions.push(...(signal.informational_mentions || []));
    all_mentions.push(...(signal.all_mentions || []));

    if (signal.asking_price) {
      if (canonical?.asking_price) superseded_values.push(canonical.asking_price.value);
      canonical = signal;
      clarification = null;
      continue;
    }
    if (signal.needs_clarification) {
      if (signal.clarification_reason === "conflicting_price_statements") {
        if (canonical?.asking_price) superseded_values.push(canonical.asking_price.value);
        canonical = null;
        clarification = signal;
      } else if (!canonical) {
        clarification = signal;
      }
    }
  }

  if (canonical) {
    return {
      ...canonical,
      informational_mentions,
      all_mentions,
      burst_reduced: true,
      superseded_values,
    };
  }
  return {
    asking_price: null,
    is_counter: false,
    needs_clarification: Boolean(clarification),
    clarification_reason: clarification?.clarification_reason || null,
    informational_mentions,
    all_mentions,
    burst_reduced: true,
    superseded_values,
  };
}

/**
 * Decision idempotency for a completed burst generation.
 */
export function buildBurstDecisionIdempotencyKey({
  thread_key,
  generation,
  burst_id,
} = {}) {
  return `seller_inbound_burst_decision:${clean(thread_key)}:g${Number(generation) || 0}:${clean(burst_id)}`;
}

export function buildBurstId({ thread_key, generation, first_event_id } = {}) {
  return `sib:${clean(thread_key)}:g${Number(generation) || 1}:${clean(first_event_id) || "unknown"}`;
}

/**
 * Open a new burst generation from the first message.
 */
export function createOpenBurstState({
  thread_key,
  generation = 1,
  message,
  now,
  debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
  max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
} = {}) {
  const group = resolveBurstGroupKey({ thread_key });
  if (!group) throw new Error("missing_burst_thread_key");
  const received_at = message?.received_at || now;
  const { constituents } = appendConstituent([], message);
  const first_event_id =
    constituents[0]?.event_id || constituents[0]?.provider_message_id || "unknown";
  const safety = detectImmediateSafetySignal({
    message: message?.body || message?.message,
    classification: message?.classification,
  });
  const hard_close_at = computeHardCloseAt({
    first_received_at: received_at,
    max_duration_ms,
  });
  const eligible_at = computeEligibleAt({
    first_received_at: received_at,
    last_received_at: received_at,
    debounce_ms,
    max_duration_ms,
  });
  return {
    thread_key: group,
    generation: Number(generation) || 1,
    burst_id: buildBurstId({
      thread_key: group,
      generation,
      first_event_id,
    }),
    status: safety.latch ? BURST_STATUSES.SUPPRESSED : BURST_STATUSES.OPEN,
    first_event_id,
    latest_event_id: first_event_id,
    constituents,
    first_received_at: received_at,
    last_received_at: received_at,
    eligible_at: safety.latch ? received_at : eligible_at,
    hard_close_at,
    safety_latched: safety.latch,
    safety_reason: safety.reason,
    safety_kind: safety.kind,
    version: 1,
    policy_version: SELLER_INBOUND_BURST_POLICY_VERSION,
    decision_idempotency_key: null,
    claim_token: null,
    claimed_at: null,
    claimed_by: null,
    completed_at: null,
    attempt_count: 0,
  };
}

/**
 * Append a message into an open burst. Pure — returns next state.
 * Duplicate provider delivery: no-op (no deadline extension).
 * If open burst is past hard_close relative to new message, caller should
 * open generation N+1 instead (append returns { rollover: true }).
 */
export function projectAppendToOpenBurst({
  burst,
  message,
  now,
  debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
  max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
} = {}) {
  if (!burst || burst.status !== BURST_STATUSES.OPEN) {
    return { ok: false, reason: "burst_not_open", rollover: true };
  }
  const received_at = message?.received_at || now;
  const receivedMs = parseIsoMs(received_at, parseIsoMs(now));
  const hardCloseMs = parseIsoMs(burst.hard_close_at);
  // Message after hard close → new generation (not lost, not in this burst).
  if (Number.isFinite(hardCloseMs) && Number.isFinite(receivedMs) && receivedMs > hardCloseMs) {
    return { ok: false, reason: "past_hard_close", rollover: true };
  }

  const { constituents, appended, duplicate } = appendConstituent(
    burst.constituents,
    message
  );
  if (duplicate || !appended) {
    return {
      ok: true,
      appended: false,
      duplicate: Boolean(duplicate),
      burst: { ...burst },
    };
  }

  const safety = detectImmediateSafetySignal({
    message: message?.body || message?.message,
    classification: message?.classification,
  });
  const latest_event_id =
    constituents[constituents.length - 1]?.event_id ||
    constituents[constituents.length - 1]?.provider_message_id ||
    burst.latest_event_id;

  const next = {
    ...burst,
    constituents,
    latest_event_id,
    last_received_at: received_at,
    eligible_at: computeEligibleAt({
      first_received_at: burst.first_received_at,
      last_received_at: received_at,
      debounce_ms,
      max_duration_ms,
    }),
    version: Number(burst.version || 1) + 1,
  };

  if (safety.latch || burst.safety_latched) {
    next.safety_latched = true;
    next.safety_reason = safety.reason || burst.safety_reason;
    next.safety_kind = safety.kind || burst.safety_kind;
    // Eligible immediately so flush can finalize as suppressed.
    next.eligible_at = received_at;
    if (safety.latch) {
      next.status = BURST_STATUSES.SUPPRESSED;
    }
  }

  return { ok: true, appended: true, duplicate: false, burst: next };
}

export default {
  SELLER_INBOUND_BURST_DEBOUNCE_MS,
  SELLER_INBOUND_BURST_MAX_DURATION_MS,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  SELLER_INBOUND_BURST_MAX_ATTEMPTS,
  detectImmediateSafetySignal,
  computeEligibleAt,
  isClaimableBurst,
  aggregateBurstMessage,
  resolveBurstAskingPriceSignal,
  createOpenBurstState,
  projectAppendToOpenBurst,
};
