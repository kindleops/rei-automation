// ─── acquisition-brain/shadow-burst-timing.js ──────────────────────────────
// Deterministic burst grouping + reply-timing planner (shadow only).
// Never creates production queue rows or invokes providers.

import { createHash } from "node:crypto";
import { buildShadowFactState } from "./shadow-fact-state.js";
import { FACT_CONTRACT_VERSION, toJsonSafe } from "./fact-provenance-contract.js";
import { ACQUISITION_BRAIN_VERSION } from "./lifecycle-registry.js";

export const SHADOW_BURST_EVENT = "acquisition_brain_shadow_burst_plan";
export const BURST_DEBOUNCE_MIN_MS = 20_000;
export const BURST_DEBOUNCE_MAX_MS = 40_000;

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

function clean(value) {
  return String(value ?? "").trim();
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

/**
 * Contact window: 08:00 ≤ local < 21:00 America/Chicago.
 */
export function evaluateContactWindowShadow(now = new Date(), timezone = "America/Chicago") {
  const d = now instanceof Date ? now : new Date(now);
  let hour = 12;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(d);
    hour = Number(parts.find((p) => p.type === "hour")?.value || 12);
  } catch {
    hour = d.getUTCHours();
  }
  const allowed = hour >= 8 && hour < 21;
  let next_eligible_at = null;
  if (!allowed) {
    const probe = new Date(d.getTime());
    for (let i = 0; i < 200; i += 1) {
      probe.setUTCMinutes(probe.getUTCMinutes() + 15);
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(probe);
        const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
        const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
        if (h === 8 && m < 15) {
          next_eligible_at = new Date(probe.getTime() - m * 60_000).toISOString();
          break;
        }
      } catch {
        break;
      }
    }
  }
  return {
    allowed,
    timezone,
    reason: allowed ? "inside_local_send_window" : "outside_local_send_window",
    next_eligible_at,
  };
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
 * Build a burst plan from ordered inbound messages on one E.164 thread.
 * Pure; no I/O. Does not create queue rows.
 */
export function planShadowBurst({
  thread_key = null,
  messages = [],
  now = new Date(),
  timezone = "America/Chicago",
  facts_before = [],
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);
  if (!thread.startsWith("+")) {
    return {
      ok: false,
      reason: "non_e164_thread",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const ordered = [...messages].sort((a, b) => {
    const ta = Date.parse(a.timestamp || a.created_at || a.received_at || 0) || 0;
    const tb = Date.parse(b.timestamp || b.created_at || b.received_at || 0) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id || a.message_event_id || "").localeCompare(
      String(b.id || b.message_event_id || "")
    );
  });

  if (!ordered.length) {
    return {
      ok: false,
      reason: "empty_burst",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const first_id = clean(first.id || first.message_event_id);
  const burst_seed = `${thread}:${first_id}`;
  const debounce_ms = seededInRange(burst_seed, BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  const first_at = first.timestamp || first.created_at || new Date(now).toISOString();
  const latest_at = last.timestamp || last.created_at || first_at;
  const debounce_until = new Date(Date.parse(latest_at) + debounce_ms).toISOString();

  // Sequential fact merge (strongest memory)
  let seq_facts = Array.isArray(facts_before) ? [...facts_before] : [];
  const message_ids = [];
  let final_seq = null;
  for (const m of ordered) {
    const mid = clean(m.id || m.message_event_id);
    message_ids.push(mid);
    final_seq = buildShadowFactState({
      facts_before: seq_facts,
      message: m.message || m.message_body || "",
      classification: m.classification || {
        primary_intent: m.detected_intent || m.primary_intent || "unclear",
        confidence: m.confidence ?? 0.9,
        language: m.language || null,
      },
      message_event_id: mid,
      source_timestamp: m.timestamp || m.created_at,
    });
    seq_facts = final_seq.facts_after;
  }

  const nba = final_seq.proposed_next_best_action;
  const timing_label = selectTimingPolicy(nba, final_seq.fact_bag || {});
  const timing_range = TIMING_POLICIES[timing_label] || TIMING_POLICIES.clear_proposal_interest;
  const contact = evaluateContactWindowShadow(now, timezone);

  let delay_ms = null;
  let next_eligible_at = null;
  let timing_reason = timing_label;

  if (nba === "opt_out" || nba === "suppress") {
    timing_reason = "terminal_no_reply";
  } else if (timing_range.transport === false) {
    timing_reason = timing_label;
  } else if (!contact.allowed) {
    timing_reason = "deferred_contact_window";
    next_eligible_at = contact.next_eligible_at;
  } else {
    delay_ms = seededInRange(
      `${burst_seed}:${timing_label}`,
      timing_range.min_ms,
      timing_range.max_ms
    );
    next_eligible_at = new Date(Date.parse(latest_at) + delay_ms).toISOString();
  }

  const burst_id = createHash("sha256")
    .update(`${thread}:${first_id}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  const burst_version = ordered.length;

  const plan = {
    burst_id,
    thread_key: thread,
    first_message_at: first_at,
    latest_message_at: latest_at,
    debounce_until,
    debounce_ms,
    inbound_message_ids: message_ids,
    burst_version,
    facts_before: facts_before || [],
    facts_after: final_seq.facts_after,
    questions_already_answered: final_seq.questions_already_answered,
    questions_skipped_as_answered: final_seq.questions_already_answered,
    next_missing_fact: final_seq.next_missing_fact,
    final_proposed_nba: nba,
    final_template_use_case: templateForNba(nba),
    timing_policy: timing_reason,
    timing_seed: `${burst_seed}:${timing_label}`,
    selected_delay_ms: delay_ms,
    contact_window: contact,
    next_eligible_at,
    superseded_reply_plans: message_ids.slice(0, -1).map((id, i) => ({
      plan_id: `superseded:${id}`,
      reason: "superseded_by_newer_inbound",
      sequence: i + 1,
    })),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    may_transport: false,
    processing_duration_ms: Math.max(0, Date.now() - t0),
    fact_contract_version: FACT_CONTRACT_VERSION,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
  };

  return {
    ok: true,
    plan: toJsonSafe(plan),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    event: {
      event_type: SHADOW_BURST_EVENT,
      dedupe_key: `acquisition_brain_shadow_burst_plan:${burst_id}:${burst_version}`,
      conversation_thread_id: thread,
      payload: toJsonSafe(plan),
    },
  };
}

export default {
  SHADOW_BURST_EVENT,
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  TIMING_POLICIES,
  seededUnit,
  seededInRange,
  evaluateContactWindowShadow,
  selectTimingPolicy,
  planShadowBurst,
};
