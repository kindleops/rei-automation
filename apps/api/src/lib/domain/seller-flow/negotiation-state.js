// ─── negotiation-state.js ────────────────────────────────────────────────────
// Canonical persistent negotiation state (spec §2) — exactly one per deal,
// stored in acquisition_opportunities.metadata.negotiation_state and updated
// ONLY through applyNegotiationTurn so every write preserves invariants:
//
//   • immutable history: asking_price_history / offers_made / seller_counters /
//     seller_concessions are append-only; a seller changing their price never
//     overwrites where they started
//   • authority is ADE-only: recommended/floor/ceiling/direct-purchase max come
//     exclusively from a persisted ADE snapshot
//   • accepted-terms lock: once terms are accepted the economics freeze —
//     accepted_price can never exceed the seller's own current ask, price
//     negotiation stops, and only contract facts continue to accumulate
//   • deterministic bookkeeping: round counters, concession totals, next action
//
// Pure module — no I/O. Persistence stays in persist-seller-transition.js.

import { computeNegotiationGapMetrics } from "@/lib/domain/seller-flow/negotiation-policy.js";

export const NEGOTIATION_STATE_VERSION = "negotiation_state_v2";

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

export const CONTRACT_READINESS = Object.freeze({
  NOT_READY: "not_ready",
  COLLECTING: "collecting",
  READY: "ready",
});

/** Minimum contract facts before S6 may be entered (spec §14). */
const REQUIRED_CONTRACT_FIELDS = Object.freeze([
  "signers_identified",
  "seller_email",
  "vesting_confirmed",
  "occupancy_access_confirmed",
  "closing_timing_preference",
]);

export function evaluateContractReadiness(contractFacts = {}) {
  const facts = contractFacts && typeof contractFacts === "object" ? contractFacts : {};
  const unresolved = REQUIRED_CONTRACT_FIELDS.filter((field) => {
    const value = facts[field];
    return value === undefined || value === null || value === false || value === "";
  });
  if (facts.title_constraint || facts.probate_constraint) unresolved.push("title_or_probate_resolution");
  return {
    readiness: unresolved.length === 0
      ? CONTRACT_READINESS.READY
      : Object.keys(facts).length > 0
        ? CONTRACT_READINESS.COLLECTING
        : CONTRACT_READINESS.NOT_READY,
    unresolved_contract_fields: unresolved,
  };
}

/** Full §2 field set, null-initialized. */
export function createNegotiationState({
  deal_id = null,
  property_id = null,
  owner_id = null,
  thread_key = null,
  now = new Date().toISOString(),
} = {}) {
  return {
    version: NEGOTIATION_STATE_VERSION,
    deal_id,
    property_id,
    owner_id,
    thread_key,

    // Seller position
    initial_asking_price: null,
    current_asking_price: null,
    lowest_seller_indication: null,
    seller_net_requirement: null,
    asking_price_currency: "USD",
    asking_price_confidence: null,
    asking_price_source_message_id: null,
    asking_price_history: [],

    // Our position / authority (ADE-only)
    initial_offer: null,
    latest_offer: null,
    recommended_offer: null,
    authorized_offer_floor: null,
    authorized_offer_ceiling: null,
    direct_purchase_maximum: null,
    ade_snapshot_id: null,
    offers_made: [],

    // Movement
    seller_counters: [],
    seller_concessions: [],
    cumulative_concession_amount: 0,
    cumulative_concession_percentage: 0,
    negotiation_round: 0,

    // Strategy
    current_strategy: null,
    prior_strategies: [],
    resistance_type: null,
    motivation_signals: [],
    seller_sentiment: null,
    seller_priorities: [],

    // Property facts snapshot
    occupancy: null,
    condition_summary: null,
    repair_facts: [],
    repair_estimate: null,
    arv: null,
    comp_confidence: null,
    selected_comp_anchor: null,
    comp_anchors_used: [],
    timeline: null,
    closing_preference: null,

    // Alternate strategies
    alternate_strategy_eligibility: null,

    // Acceptance + contract
    accepted_price: null,
    accepted_terms: null,
    terms_accepted: false,
    terms_accepted_at: null,
    contract_readiness: CONTRACT_READINESS.NOT_READY,
    unresolved_contract_fields: [...REQUIRED_CONTRACT_FIELDS],
    contract_facts: {},

    // Zone + metrics
    negotiation_zone: null,
    gap_metrics: null,

    // Execution
    last_action: null,
    next_action: null,
    next_action_due_at: null,
    automation_confidence: null,
    human_review_reason: null,
    duplicate_acceptance_suppressed: false,

    created_at: now,
    updated_from_message_id: null,
    updated_at: now,
  };
}

/** Upgrade any legacy persisted shape (v1 fields) to the canonical shape. */
export function normalizeNegotiationState(previous = null, seed = {}) {
  const base = createNegotiationState(seed);
  if (!previous || typeof previous !== "object") return base;

  const migrated = { ...base, ...previous };
  // v1 → v2 field renames (legacy fields preserved for readers, canonical wins)
  if (previous.initial_ask != null && migrated.initial_asking_price == null) {
    migrated.initial_asking_price = num(previous.initial_ask);
  }
  if (previous.current_ask != null && migrated.current_asking_price == null) {
    migrated.current_asking_price = num(previous.current_ask);
  }
  if (previous.negotiation_turn != null && !previous.negotiation_round) {
    migrated.negotiation_round = num(previous.negotiation_turn) ?? 0;
  }
  if (previous.strategy && !previous.current_strategy) {
    migrated.current_strategy = previous.strategy;
  }
  if (previous.accepted_at && !previous.terms_accepted_at) {
    migrated.terms_accepted_at = previous.accepted_at;
  }
  migrated.terms_accepted = previous.terms_accepted === true;
  migrated.asking_price_history = arr(previous.asking_price_history);
  // Legacy offers_made was a bare count — preserve the turn count as
  // placeholder ledger entries so concession limits keep holding.
  migrated.offers_made = Array.isArray(previous.offers_made)
    ? previous.offers_made
    : num(previous.offers_made) > 0
      ? Array.from({ length: num(previous.offers_made) }, () => ({ amount: null, legacy: true }))
      : [];
  migrated.seller_counters = arr(previous.seller_counters);
  migrated.seller_concessions = arr(previous.seller_concessions);
  migrated.prior_strategies = arr(previous.prior_strategies);
  migrated.comp_anchors_used = arr(previous.comp_anchors_used);
  migrated.repair_facts = arr(previous.repair_facts);
  migrated.motivation_signals = arr(previous.motivation_signals);
  migrated.seller_priorities = arr(previous.seller_priorities);
  migrated.version = NEGOTIATION_STATE_VERSION;
  return migrated;
}

/**
 * Apply one negotiation turn (usually one inbound message, sometimes a
 * recovery re-evaluation). Returns the next state; never mutates the input.
 */
export function applyNegotiationTurn(previous, {
  price_signal = null,        // resolveAskingPriceSignal output
  ade_snapshot = null,        // persisted ADE score row
  ade_snapshot_id = null,
  strategy_decision = null,   // negotiation-strategy-router output
  zone = null,                // classifyNegotiationZone output
  transition = null,          // resolver transition
  engine_decision = null,     // stage engine decision (S4/S5 flags)
  facts = null,               // merged seller facts
  intent = null,
  seller_sentiment = null,
  classification_confidence = null,
  offer_execution = null,     // { queued, amount, template_use_case, queue_row_id }
  contract_facts = null,
  comp_anchor = null,         // comp-anchor policy selection
  source_message_id = null,
  now = new Date().toISOString(),
} = {}) {
  const state = normalizeNegotiationState(previous, {
    deal_id: previous?.deal_id ?? null,
    property_id: previous?.property_id ?? null,
    owner_id: previous?.owner_id ?? null,
    thread_key: previous?.thread_key ?? null,
    now,
  });

  const next = {
    ...state,
    asking_price_history: [...state.asking_price_history],
    offers_made: [...state.offers_made],
    seller_counters: [...state.seller_counters],
    seller_concessions: [...state.seller_concessions],
    prior_strategies: [...state.prior_strategies],
    comp_anchors_used: [...state.comp_anchors_used],
    repair_facts: [...state.repair_facts],
    motivation_signals: [...state.motivation_signals],
    seller_priorities: [...state.seller_priorities],
    contract_facts: { ...state.contract_facts },
    duplicate_acceptance_suppressed: false,
  };

  // ── 1. ADE authority (only source of monetary authority) ────────────────
  if (ade_snapshot) {
    const recommended = num(ade_snapshot.recommended_cash_offer);
    const floor = num(ade_snapshot.minimum_acceptable_offer);
    const ceiling = num(ade_snapshot.investor_ceiling_mid) ?? num(ade_snapshot.investor_ceiling_high);
    if (recommended !== null) next.recommended_offer = recommended;
    if (floor !== null) next.authorized_offer_floor = floor;
    if (ceiling !== null) next.authorized_offer_ceiling = ceiling;
    next.direct_purchase_maximum =
      num(ade_snapshot.investor_ceiling_high) ?? next.authorized_offer_ceiling ?? next.direct_purchase_maximum;
    next.arv = num(ade_snapshot.valuation_mid) ?? next.arv;
    next.repair_estimate = num(ade_snapshot.estimated_repairs) ?? next.repair_estimate;
    next.comp_confidence = num(ade_snapshot.valuation_confidence) ?? next.comp_confidence;
    if (ade_snapshot_id || ade_snapshot.id) next.ade_snapshot_id = ade_snapshot_id || ade_snapshot.id;
    next.alternate_strategy_eligibility = {
      subject_to_score: num(ade_snapshot.subject_to_score),
      seller_finance_score: num(ade_snapshot.seller_finance_score),
      novation_score: num(ade_snapshot.novation_score),
      lease_option_score: num(ade_snapshot.lease_option_score),
      best_strategy: ade_snapshot.best_strategy || null,
    };
  }

  // ── 2. Seller price movement (append-only history) ──────────────────────
  const signal = price_signal?.asking_price || null;
  if (signal?.value > 0 && !next.terms_accepted) {
    const value = num(signal.value);
    const previousAsk = num(next.current_asking_price);
    const isFirst = next.initial_asking_price == null;

    if (isFirst) {
      next.initial_asking_price = value;
    }

    if (previousAsk === null || value !== previousAsk) {
      next.asking_price_history.push({
        value,
        price_type: signal.price_type || "exact",
        confidence: signal.confidence ?? null,
        extracted_text: signal.extracted_text || null,
        source_message_id: signal.source_message_id || source_message_id || null,
        kind: isFirst ? "initial" : price_signal?.is_counter ? "counter" : "revision",
        at: now,
      });

      if (!isFirst && price_signal?.is_counter) {
        next.seller_counters.push({
          amount: value,
          at: now,
          source_message_id: signal.source_message_id || source_message_id || null,
        });
        next.negotiation_round += 1;
      }

      if (previousAsk !== null && value < previousAsk) {
        const concession = previousAsk - value;
        next.seller_concessions.push({
          amount: concession,
          from: previousAsk,
          to: value,
          at: now,
          source_message_id: signal.source_message_id || source_message_id || null,
        });
        next.cumulative_concession_amount += concession;
        next.cumulative_concession_percentage =
          next.initial_asking_price > 0
            ? round2((next.cumulative_concession_amount / next.initial_asking_price) * 100)
            : 0;
      }

      next.current_asking_price = value;
      next.asking_price_confidence = signal.confidence ?? null;
      next.asking_price_source_message_id = signal.source_message_id || source_message_id || null;
      next.asking_price_currency = signal.currency || "USD";
    }

    const indications = next.asking_price_history.map((h) => num(h.value)).filter((v) => v !== null);
    next.lowest_seller_indication = indications.length ? Math.min(...indications) : null;
    if (signal.price_type === "net") next.seller_net_requirement = value;
  }

  // ── 3. Facts snapshot ────────────────────────────────────────────────────
  if (facts && typeof facts === "object") {
    if (facts.occupancy_status || facts.occupancy) next.occupancy = facts.occupancy_status || facts.occupancy;
    if (facts.condition_summary || facts.condition_level) {
      next.condition_summary = facts.condition_summary || facts.condition_level;
    }
    if (facts.timeline) next.timeline = facts.timeline;
    if (facts.closing_preference) next.closing_preference = facts.closing_preference;
    if (facts.repair_fact && !next.repair_facts.some((r) => r.fact === facts.repair_fact)) {
      next.repair_facts.push({ fact: facts.repair_fact, at: now, source_message_id });
    }
    if (Array.isArray(facts.motivation_signals)) {
      for (const m of facts.motivation_signals) {
        if (!next.motivation_signals.includes(m)) next.motivation_signals.push(m);
      }
    }
  }
  if (engine_decision?.resistance_type) next.resistance_type = engine_decision.resistance_type;
  else if (engine_decision?.negotiation_posture === "anchored") next.resistance_type = "price_anchored";
  if (seller_sentiment || intent) next.seller_sentiment = clean(seller_sentiment || intent) || next.seller_sentiment;

  // ── 4. Comp anchor bookkeeping ───────────────────────────────────────────
  if (comp_anchor?.eligible) {
    next.selected_comp_anchor = comp_anchor.anchor;
    const anchorId = comp_anchor.anchor?.comp_property_id || comp_anchor.anchor?.sale_price;
    if (!next.comp_anchors_used.some((a) => (a.comp_property_id || a.sale_price) === anchorId)) {
      next.comp_anchors_used.push({ ...comp_anchor.anchor, disclosed_at: now });
    }
  }

  // ── 5. Strategy ──────────────────────────────────────────────────────────
  if (strategy_decision?.strategy) {
    if (next.current_strategy && next.current_strategy !== strategy_decision.strategy) {
      next.prior_strategies.push({ strategy: next.current_strategy, replaced_at: now });
    }
    next.current_strategy = strategy_decision.strategy;
  }

  // ── 6. Our offers (append-only ledger, ceiling-guarded) ─────────────────
  const executedAmount = num(offer_execution?.amount);
  if (offer_execution?.queued && executedAmount !== null && !next.terms_accepted) {
    const ceiling = num(next.authorized_offer_ceiling);
    // Authority violation is recorded, never silently accepted.
    const withinAuthority = ceiling === null || executedAmount <= ceiling;
    next.offers_made.push({
      amount: executedAmount,
      strategy: strategy_decision?.strategy || next.current_strategy || null,
      template_use_case: offer_execution.template_use_case || null,
      queue_row_id: offer_execution.queue_row_id || null,
      within_authority: withinAuthority,
      at: now,
    });
    if (next.initial_offer == null) next.initial_offer = executedAmount;
    next.latest_offer = executedAmount;
    next.negotiation_round += 1;
  }

  // ── 7. Accepted-terms lock (spec §14) ───────────────────────────────────
  const acceptanceSignal = Boolean(
    strategy_decision?.strategy === "accept_seller_terms" ||
      transition?.workflow_event_types?.includes("SELLER_ACCEPTED_OFFER") ||
      engine_decision?.outcome === "seller_accepts_offer"
  );
  if (acceptanceSignal) {
    if (next.terms_accepted) {
      // Duplicate acceptance: economics are already locked — suppress.
      next.duplicate_acceptance_suppressed = true;
    } else {
      const ask = num(next.current_asking_price);
      const ceiling = num(next.authorized_offer_ceiling);
      const latestOffer = num(next.latest_offer);
      // Accepted price: when the seller accepts OUR offer it is that offer;
      // when WE accept the seller's ask it is their ask — never more than the
      // seller requested, never above the ceiling.
      let accepted = null;
      if (engine_decision?.outcome === "seller_accepts_offer" && latestOffer !== null) {
        accepted = latestOffer;
      } else if (ask !== null) {
        accepted = ceiling !== null ? Math.min(ask, ceiling) : ask;
      } else if (latestOffer !== null) {
        accepted = latestOffer;
      }
      if (accepted !== null) {
        next.terms_accepted = true;
        next.accepted_price = accepted;
        next.terms_accepted_at = now;
        next.accepted_terms = {
          price: accepted,
          basis: engine_decision?.outcome === "seller_accepts_offer" ? "seller_accepted_our_offer" : "we_accepted_seller_ask",
          closing_preference: next.closing_preference || null,
          source_message_id: source_message_id || null,
        };
      } else {
        next.human_review_reason = "acceptance_without_priceable_terms";
      }
    }
  }

  // ── 8. Contract facts + readiness ────────────────────────────────────────
  if (contract_facts && typeof contract_facts === "object") {
    next.contract_facts = { ...next.contract_facts, ...contract_facts };
  }
  const readiness = evaluateContractReadiness(next.contract_facts);
  next.contract_readiness = next.terms_accepted ? readiness.readiness : CONTRACT_READINESS.NOT_READY;
  next.unresolved_contract_fields = readiness.unresolved_contract_fields;

  // ── 9. Zone + gap metrics ────────────────────────────────────────────────
  if (zone?.zone) next.negotiation_zone = zone.zone;
  next.gap_metrics = computeNegotiationGapMetrics({
    current_ask: next.current_asking_price,
    initial_ask: next.initial_asking_price,
    recommended_offer: next.recommended_offer,
    latest_offer: next.latest_offer,
    initial_offer: next.initial_offer,
    authorized_offer_floor: next.authorized_offer_floor,
    authorized_offer_ceiling: next.authorized_offer_ceiling,
    arv: next.arv,
    repair_estimate: next.repair_estimate,
    valuation_confidence: next.comp_confidence,
    comp_confidence: next.comp_confidence,
  });

  // ── 10. Execution bookkeeping ────────────────────────────────────────────
  next.last_action = offer_execution?.queued
    ? "offer_queued"
    : strategy_decision?.next_action || transition?.next_action || next.last_action;
  next.next_action = strategy_decision?.next_action || transition?.next_action || next.next_action;
  next.next_action_due_at =
    strategy_decision?.next_action_due_at || transition?.next_action_due_at || next.next_action_due_at;

  const confidences = [
    num(classification_confidence),
    num(signal?.confidence),
    num(next.gap_metrics?.deal_confidence),
  ].filter((v) => v !== null);
  next.automation_confidence = confidences.length
    ? round2(Math.min(...confidences))
    : next.automation_confidence;

  if (strategy_decision?.review_reason) next.human_review_reason = strategy_decision.review_reason;
  else if (transition?.review_reason) next.human_review_reason = transition.review_reason;
  else if (price_signal?.needs_clarification) next.human_review_reason = price_signal.clarification_reason;

  next.updated_from_message_id = source_message_id || next.updated_from_message_id;
  next.updated_at = now;

  // Legacy read aliases (v1 field names still consumed by existing readers and
  // tests) — always derived, never independently written.
  next.initial_ask = next.initial_asking_price;
  next.current_ask = next.current_asking_price;
  next.negotiation_turn = next.negotiation_round;
  next.accepted_at = next.terms_accepted_at;
  next.last_seller_sentiment = next.seller_sentiment;
  next.next_move = next.next_action;
  next.strategy = next.current_strategy;

  return next;
}

export default {
  NEGOTIATION_STATE_VERSION,
  CONTRACT_READINESS,
  createNegotiationState,
  normalizeNegotiationState,
  applyNegotiationTurn,
  evaluateContractReadiness,
};
