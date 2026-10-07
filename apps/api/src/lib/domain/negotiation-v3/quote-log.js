// ─── negotiation-v3/quote-log.js ────────────────────────────────────────────
// §49–50: every number is LOGGED BEFORE SEND, and a logging failure BLOCKS the
// send (fail closed). An anchor is never a formal offer.
//
// Table: public.negotiation_quotes (PROPOSED_20261006120000 + observed-offer
// amendment PROPOSED_20261007042000 + v3 amendment PROPOSED_20261007060000).
// Until those are applied every write fails ⇒ every v3 money send is blocked.

import { recordNegotiationQuote } from "@/lib/domain/seller-flow/negotiation-quotes.js";
import { NEGOTIATION_ACTIONS, QUOTE_TYPES_V3 } from "./plan.js";

/** v3 type → persisted quote_type (anchor / formal_offer keep the 10-06 values). */
export const PERSISTED_QUOTE_TYPES = Object.freeze({
  [QUOTE_TYPES_V3.NEGOTIATION_ANCHOR]: "anchor",
  [QUOTE_TYPES_V3.CONCESSION]: "concession",
  [QUOTE_TYPES_V3.FORMAL_OFFER]: "formal_offer",
  [QUOTE_TYPES_V3.NO_NUMBER]: "no_number",
});

function clean(value) {
  return String(value ?? "").trim();
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the row for one move. Pure. Throws on any contract violation so no
 * caller can persist (or send) an amount without its evidence.
 *
 * ids: { thread_key, inbound_message_event_id, property_id, opportunity_id (deal), master_owner_id,
 *        language, template_id, use_case, send_queue_key, quoted_at }
 */
export function buildQuoteLogRow(plan, move, ids = {}) {
  if (!move?.requires_log) throw new Error("negotiation_v3_move_not_loggable");
  const quote_type = PERSISTED_QUOTE_TYPES[move.quote_type];
  if (!quote_type) throw new Error(`negotiation_v3_invalid_quote_type:${move.quote_type}`);
  const thread_key = clean(ids.thread_key);
  if (!thread_key || !clean(move.rule_branch)) throw new Error("negotiation_v3_missing_identity");
  const amount = num(move.amount);
  if (quote_type === "no_number") {
    if (amount != null) throw new Error("negotiation_v3_no_number_carries_amount");
  } else {
    if (move.action !== NEGOTIATION_ACTIONS.QUOTE) throw new Error("negotiation_v3_amount_without_quote_action");
    if (!plan?.ok || !plan?.authority?.ok) throw new Error("negotiation_v3_amount_without_authority");
    if (amount == null || amount <= 0) throw new Error("negotiation_v3_amount_required");
    if (amount > plan.ceiling) throw new Error("negotiation_v3_amount_above_ceiling");
    if (amount > plan.autonomous_limit) throw new Error("negotiation_v3_amount_above_autonomous_limit");
    if (!clean(ids.template_id) || !clean(ids.language)) throw new Error("negotiation_v3_amount_requires_template_and_language");
  }
  const event = clean(ids.inbound_message_event_id) || "no_event";
  const quote_key = `nv3:${thread_key}:${event}:${quote_type}:${amount ?? 0}`;
  const comp = move.language_branch === "comps" ? move.comp_support || null : null;
  return {
    quote_key,
    quote_type,
    quote_source: "automated",
    amount,
    max_offer_at_quote: plan?.ceiling ?? null,
    recommended_offer_at_quote: plan?.recommended ?? null,
    target_at_quote: plan?.target ?? null,
    autonomous_limit_at_quote: plan?.autonomous_limit ?? null,
    fair_floor_at_quote: plan?.fair_floor ?? null,
    previous_lc_amount: num(ids.previous_lc_amount),
    unit_count: move.per_unit?.units ?? null,
    per_unit_low: move.per_unit?.low ?? null,
    per_unit_high: move.per_unit?.high ?? null,
    engine: plan?.authority?.source || "acquisition_decision_engine",
    engine_version: plan?.authority?.engine_version ?? null,
    negotiation_engine_version: move.engine_version || plan?.version || null,
    negotiation_config_version: move.config_version || plan?.config_version || null,
    score_version: plan?.strategy?.score_version ?? null, // seller-situation model (A1); never a price input
    score_snapshot_id: plan?.authority?.snapshot_id ?? null,
    score_computed_at: plan?.authority?.computed_at ?? null,
    decision_tier: plan?.authority?.decision_tier ?? null,
    rule_branch: clean(move.rule_branch),
    language_branch: move.language_branch || null,
    comp_ids: comp?.ids || [],
    comp_prices: comp?.prices || [],
    asking_price: num(ids.asking_price ?? plan?.seller_ask),
    language: clean(ids.language) || null,
    template_id: clean(ids.template_id) || null,
    use_case: clean(ids.use_case) || null,
    send_queue_key: clean(ids.send_queue_key) || null,
    inbound_message_event_id: clean(ids.inbound_message_event_id) || null,
    thread_key,
    property_id: clean(ids.property_id ?? plan?.property_id) || null,
    master_owner_id: clean(ids.master_owner_id) || null,
    opportunity_id: clean(ids.opportunity_id) || null,
    seller_offer_id: clean(ids.seller_offer_id) || null,
    condition_evidence: plan?.seller_evidence || {},
    situation_evidence: plan?.strategy
      ? { situation: plan.strategy.situation, angle: plan.strategy.angle, high_pressure: plan.strategy.high_pressure, evidence_codes: plan.strategy.evidence_codes }
      : {},
    market_evidence: plan?.market || {},
    evidence: { explain: [...(plan?.explain || []), ...(move.explain || [])].slice(0, 30) },
    quoted_at: ids.quoted_at || new Date().toISOString(),
  };
}

/**
 * LOG, THEN SEND. `send(row)` is called only after the quote row is durably
 * written. Any failure (bad row, no client, write error) ⇒ nothing is sent.
 */
export async function logQuoteThenSend({ supabase, plan, move, ids, send, record = recordNegotiationQuote } = {}) {
  let row;
  try {
    row = buildQuoteLogRow(plan, move, ids);
  } catch (error) {
    return { sent: false, blocked: "quote_row_invalid", reason: error.message };
  }
  const written = await record(supabase, row);
  if (!written?.ok) return { sent: false, blocked: "quote_log_failed", reason: written?.reason || "unknown", row };
  if (typeof send !== "function") return { sent: false, blocked: "no_sender", row };
  const result = await send(row);
  return { sent: true, row, quote: written.row, result };
}

/**
 * §50 / §82 Deal Intelligence read model: anchor vs concession vs formal offer
 * kept apart; current LC position = the last money quote.
 */
export function summarizeNegotiationQuotes(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => String(a.quoted_at).localeCompare(String(b.quoted_at)));
  const money = list.filter((q) => ["anchor", "concession", "formal_offer"].includes(q.quote_type) && num(q.amount) != null);
  const pick = (t) => list.filter((q) => q.quote_type === t);
  const last = money[money.length - 1] || null;
  return {
    anchors: pick("anchor").map((q) => ({ amount: num(q.amount), quoted_at: q.quoted_at, rule: q.rule_branch || null })),
    concessions: pick("concession").map((q) => ({ amount: num(q.amount), previous: num(q.previous_lc_amount), quoted_at: q.quoted_at, rule: q.rule_branch || null })),
    formal_offers: pick("formal_offer").map((q) => ({ amount: num(q.amount), quoted_at: q.quoted_at, offer_id: q.seller_offer_id || null })),
    no_number: pick("no_number").length + pick("confirm_basics_no_number").length,
    current_position: last ? { amount: num(last.amount), type: last.quote_type, quoted_at: last.quoted_at } : null,
    lc_positions: money.map((q) => num(q.amount)),
  };
}
