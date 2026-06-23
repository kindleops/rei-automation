function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function normalizeCoverageMarket(value) {
  return clean(value)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stateFromMarketLabel(value) {
  const match = clean(value).match(/,\s*([A-Za-z]{2})(?:\b|$)/);
  return match ? match[1].toUpperCase() : "";
}

function normalizeState(value, fallbackMarket = "") {
  const state = clean(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(state)) return state;
  return stateFromMarketLabel(fallbackMarket);
}

function normalizeRule(rule = {}) {
  const raw_sender_market = clean(rule.sender_market);
  const raw_target_market = clean(rule.target_market);
  const sender_market = normalizeCoverageMarket(raw_sender_market);
  const target_market = normalizeCoverageMarket(raw_target_market);
  return {
    ...rule,
    sender_market,
    sender_state: normalizeState(rule.sender_state, raw_sender_market),
    target_market,
    target_state: normalizeState(rule.target_state, raw_target_market),
  };
}

export const TEXTGRID_MARKET_COVERAGE = Object.freeze({
  exact_local_markets: Object.freeze([
    {
      sender_market: "Houston, TX",
      sender_state: "TX",
      target_market: "Houston, TX",
      target_state: "TX",
      reason: "exact_local_inventory",
    },
  ]),
  approved_regional_fallbacks: Object.freeze([
    {
      sender_market: "Minneapolis, MN",
      sender_state: "MN",
      target_market: "Indianapolis, IN",
      target_state: "IN",
      reason: "limited_textgrid_inventory_explicit_approval",
    },
    {
      sender_market: "Dallas, TX",
      sender_state: "TX",
      target_market: "Tulsa, OK",
      target_state: "OK",
      reason: "limited_textgrid_inventory_explicit_approval",
    },
    {
      sender_market: "Los Angeles, CA",
      sender_state: "CA",
      target_market: "Phoenix, AZ",
      target_state: "AZ",
      reason: "limited_textgrid_inventory_explicit_approval",
    },
  ]),
});

const EXACT_LOCAL_MARKETS = TEXTGRID_MARKET_COVERAGE.exact_local_markets.map(normalizeRule);
const APPROVED_REGIONAL_FALLBACKS =
  TEXTGRID_MARKET_COVERAGE.approved_regional_fallbacks.map(normalizeRule);

function marketKey(value) {
  return lower(normalizeCoverageMarket(value));
}

function matchesRule(rule, candidate) {
  return (
    marketKey(rule.sender_market) === marketKey(candidate.sender_market) &&
    rule.sender_state === candidate.sender_state &&
    marketKey(rule.target_market) === marketKey(candidate.target_market) &&
    rule.target_state === candidate.target_state
  );
}

export function resolveTextgridMarketCoverage(input = {}) {
  const raw_sender_market = clean(input.sender_market ?? input.senderMarket);
  const raw_target_market = clean(input.target_market ?? input.targetMarket);
  const sender_market = normalizeCoverageMarket(raw_sender_market);
  const target_market = normalizeCoverageMarket(raw_target_market);
  const sender_state = normalizeState(input.sender_state ?? input.senderState, raw_sender_market);
  const target_state = normalizeState(input.target_state ?? input.targetState, raw_target_market);
  const candidate = {
    sender_market: raw_sender_market || sender_market,
    sender_state,
    target_market: raw_target_market || target_market,
    target_state,
  };

  const exactConfig = EXACT_LOCAL_MARKETS.find((rule) => matchesRule(rule, candidate)) || null;
  const exactLocal =
    marketKey(sender_market) === marketKey(target_market) &&
    sender_state &&
    target_state &&
    sender_state === target_state;

  if (exactLocal || exactConfig) {
    return {
      ok: true,
      tier: "exact_local_match",
      reason: "exact_local_match",
      fallback_ack_required: false,
      ...candidate,
    };
  }

  const approved = APPROVED_REGIONAL_FALLBACKS.find((rule) => matchesRule(rule, candidate)) || null;
  if (approved) {
    return {
      ok: true,
      tier: "approved_regional_fallback",
      reason: approved.reason,
      fallback_ack_required: true,
      ...candidate,
    };
  }

  return {
    ok: false,
    tier: "unapproved_cross_state_fallback",
    reason: "unapproved_cross_state_fallback",
    fallback_ack_required: false,
    ...candidate,
  };
}

export default {
  TEXTGRID_MARKET_COVERAGE,
  normalizeCoverageMarket,
  resolveTextgridMarketCoverage,
  stateFromMarketLabel,
};
