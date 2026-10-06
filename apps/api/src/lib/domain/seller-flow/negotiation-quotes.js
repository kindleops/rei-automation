// ─── negotiation-quotes.js ──────────────────────────────────────────────────
// LOGGING MODEL (owner 2026-10-06): every number we put to a seller is
// persisted with its evidence, and a NEGOTIATION ANCHOR is never written as
// the active FORMAL OFFER.
//
//   quote_type  anchor                    a number to negotiate around ("around $X")
//               formal_offer              an offer version (seller_offers) — linked by seller_offer_id
//               confirm_basics_no_number  "that price should work" — no number sent, the ask is recorded
//
// Table: public.negotiation_quotes (PROPOSED migration
// PROPOSED_20261006120000_negotiation_quotes.sql). Until it is applied every
// monetary write fails, and the caller FAILS CLOSED (no number is sent).

export const NEGOTIATION_QUOTES_TABLE = "negotiation_quotes";
export const QUOTE_TYPES = Object.freeze({
  ANCHOR: "anchor",
  FORMAL_OFFER: "formal_offer",
  CONFIRM_BASICS: "confirm_basics_no_number",
});

/** Use cases that quote (or confirm) a price, and what kind of quote each is. */
export const QUOTE_USE_CASE_TYPES = Object.freeze({
  as_is_comp_anchor: QUOTE_TYPES.ANCHOR,
  price_anchor_above_max: QUOTE_TYPES.ANCHOR,
  comp_anchor: QUOTE_TYPES.ANCHOR,
  price_works_confirm_basics: QUOTE_TYPES.CONFIRM_BASICS,
  initial_offer: QUOTE_TYPES.FORMAL_OFFER,
  conditional_offer: QUOTE_TYPES.FORMAL_OFFER,
  counter_offer: QUOTE_TYPES.FORMAL_OFFER,
  final_offer: QUOTE_TYPES.FORMAL_OFFER,
  offer_reveal_cash: QUOTE_TYPES.FORMAL_OFFER,
});

const MONEY_PLACEHOLDER_RE = /\{\{\s*(offer_price|smart_cash_offer_display|comp_anchor_statement)\s*\}\}/;

function clean(value) {
  return String(value ?? "").trim();
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The quote type a rendered template implies (null = not a price message). */
export function quoteTypeFor({ use_case = null, template_body = "" } = {}) {
  const known = QUOTE_USE_CASE_TYPES[clean(use_case).toLowerCase()];
  if (known) return known;
  // Any OTHER template that renders money is an anchor until proven otherwise.
  return MONEY_PLACEHOLDER_RE.test(String(template_body || "")) ? QUOTE_TYPES.ANCHOR : null;
}

/**
 * Build the row. Pure. `amount` is the number actually rendered (null for
 * confirm_basics). Throws on a contract violation so a caller cannot write a
 * monetary quote without its evidence.
 */
export function buildNegotiationQuote({
  quote_key,
  quote_type,
  amount = null,
  max_offer = null,
  recommended_offer = null,
  engine_version = null,
  score_snapshot_id = null,
  score_computed_at = null,
  decision_tier = null,
  rule_branch,
  comp_ids = [],
  comp_prices = [],
  asking_price = null,
  language = null,
  template_id = null,
  use_case = null,
  send_queue_key = null,
  inbound_message_event_id = null,
  thread_key,
  property_id = null,
  master_owner_id = null,
  opportunity_id = null,
  seller_offer_id = null,
  evidence = {},
  quoted_at = new Date().toISOString(),
} = {}) {
  if (!Object.values(QUOTE_TYPES).includes(quote_type)) throw new Error(`negotiation_quote_invalid_type:${quote_type}`);
  if (!clean(quote_key) || !clean(thread_key) || !clean(rule_branch)) throw new Error("negotiation_quote_missing_identity");
  const a = num(amount);
  const max = num(max_offer);
  if (quote_type === QUOTE_TYPES.CONFIRM_BASICS) {
    if (a != null) throw new Error("negotiation_quote_confirm_basics_carries_no_number");
  } else {
    if (a == null || a <= 0) throw new Error("negotiation_quote_amount_required");
    if (max == null || max <= 0) throw new Error("negotiation_quote_max_offer_required");
    if (a > max) throw new Error("negotiation_quote_above_max_offer");
  }
  return {
    quote_key: clean(quote_key),
    quote_type,
    amount: a,
    max_offer_at_quote: max,
    recommended_offer_at_quote: num(recommended_offer),
    engine: "acquisition_decision_engine",
    engine_version: clean(engine_version) || null,
    score_snapshot_id: clean(score_snapshot_id) || null,
    score_computed_at: score_computed_at || null,
    decision_tier: clean(decision_tier) || null,
    rule_branch: clean(rule_branch),
    comp_ids: (comp_ids || []).map(clean).filter(Boolean),
    comp_prices: (comp_prices || []).map(num).filter((v) => v != null),
    asking_price: num(asking_price),
    language: clean(language) || null,
    template_id: clean(template_id) || null,
    use_case: clean(use_case) || null,
    send_queue_key: clean(send_queue_key) || null,
    inbound_message_event_id: clean(inbound_message_event_id) || null,
    thread_key: clean(thread_key),
    property_id: clean(property_id) || null,
    master_owner_id: clean(master_owner_id) || null,
    opportunity_id: clean(opportunity_id) || null,
    seller_offer_id: clean(seller_offer_id) || null,
    evidence: evidence && typeof evidence === "object" ? evidence : {},
    quoted_at,
  };
}

/** Idempotent upsert on quote_key. Returns { ok, row?, reason? }. Never throws. */
export async function recordNegotiationQuote(supabase, row) {
  try {
    if (!supabase?.from) return { ok: false, reason: "negotiation_quotes_no_client" };
    const { data, error } = await supabase
      .from(NEGOTIATION_QUOTES_TABLE)
      .upsert(row, { onConflict: "quote_key" })
      .select("id,quote_key")
      .maybeSingle();
    if (error) return { ok: false, reason: `negotiation_quote_write_failed:${clean(error.code || error.message)}` };
    return { ok: true, row: data || row };
  } catch (error) {
    return { ok: false, reason: `negotiation_quote_write_failed:${clean(error?.message)}` };
  }
}

/** Deal Intelligence line: "Anchor $185K quoted 10-06 (rule: above_max)". */
export function describeQuote(q = {}) {
  const amt = num(q.amount);
  const money = amt == null ? null : amt >= 1000 ? `$${Math.round(amt / 1000)}K` : `$${amt}`;
  const d = new Date(q.quoted_at || q.created_at || Date.now());
  const date = Number.isFinite(d.getTime()) ? `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}` : "—";
  const kind = q.quote_type === QUOTE_TYPES.ANCHOR ? "Anchor" : q.quote_type === QUOTE_TYPES.FORMAL_OFFER ? "Formal offer" : "Price confirmed (no number)";
  return `${kind}${money ? ` ${money}` : ""} quoted ${date} (rule: ${clean(q.rule_branch) || "—"})`;
}

export default recordNegotiationQuote;
