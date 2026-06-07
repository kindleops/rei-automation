function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeRoutingMarketKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeRoutingPhone(value) {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

export function stateFromMarketLabel(value) {
  const match = clean(value).match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : "";
}

export const REGIONAL_ROUTING_RULES = Object.freeze([
  Object.freeze({
    name: "ca_to_los_angeles",
    states: Object.freeze(["ca"]),
    target_markets: Object.freeze(["Los Angeles, CA"]),
  }),
  Object.freeze({
    name: "west_mountain_to_los_angeles",
    states: Object.freeze(["or", "wa", "nv", "az", "id", "ut", "nm", "co"]),
    target_markets: Object.freeze(["Los Angeles, CA"]),
  }),
  Object.freeze({
    name: "midwest_to_minneapolis",
    states: Object.freeze(["mn", "wi", "ia", "nd", "sd", "ne", "il", "in", "mi", "oh", "mo"]),
    target_markets: Object.freeze(["Minneapolis, MN"]),
  }),
  Object.freeze({
    name: "southern_plains_to_dallas_then_houston",
    states: Object.freeze(["ok", "ar", "ks"]),
    target_markets: Object.freeze(["Dallas, TX", "Houston, TX"]),
  }),
  Object.freeze({
    name: "louisiana_to_houston",
    states: Object.freeze(["la"]),
    target_markets: Object.freeze(["Houston, TX"]),
  }),
  Object.freeze({
    name: "texas_to_dallas_then_houston",
    states: Object.freeze(["tx"]),
    target_markets: Object.freeze(["Dallas, TX", "Houston, TX"]),
  }),
  Object.freeze({
    name: "georgia_to_atlanta",
    states: Object.freeze(["ga"]),
    target_markets: Object.freeze(["Atlanta, GA"]),
  }),
  Object.freeze({
    name: "carolinas_to_charlotte",
    states: Object.freeze(["nc", "sc"]),
    target_markets: Object.freeze(["Charlotte, NC"]),
  }),
  Object.freeze({
    name: "florida_to_jacksonville_then_miami",
    states: Object.freeze(["fl"]),
    target_markets: Object.freeze(["Jacksonville, FL", "Miami, FL"]),
  }),
  Object.freeze({
    name: "northeast_to_miami",
    states: Object.freeze(["ny", "nj", "pa", "md", "va", "dc", "de", "ct", "ri", "ma", "nh", "vt", "me"]),
    target_markets: Object.freeze(["Miami, FL"]),
  }),
  Object.freeze({
    name: "southeast_inland_to_atlanta_then_charlotte",
    states: Object.freeze(["al", "ms", "tn", "ky"]),
    target_markets: Object.freeze(["Atlanta, GA", "Charlotte, NC"]),
  }),
]);

export function findRegionalRoutingRule(state) {
  const normalizedState = clean(state).toLowerCase();
  return REGIONAL_ROUTING_RULES.find((rule) => rule.states.includes(normalizedState)) || null;
}

function normalizedAliases(number = {}) {
  const aliases = Array.isArray(number.aliases)
    ? number.aliases
    : Array.isArray(number.approved_market_aliases)
      ? number.approved_market_aliases
      : [];
  return aliases.map(normalizeRoutingMarketKey).filter(Boolean);
}

function normalizedNumber(number = {}) {
  return {
    ...number,
    phone_number: normalizeRoutingPhone(
      number.phone_number || number.normalized_phone || number.number || number.e164
    ),
    market: clean(number.market || number.market_name || number.seller_market),
  };
}

export function isHealthBlockedSender(phoneNumber, blockedSenderNumbers = []) {
  const normalized = normalizeRoutingPhone(phoneNumber);
  if (!normalized) return false;
  return new Set(
    (Array.isArray(blockedSenderNumbers) ? blockedSenderNumbers : [blockedSenderNumbers])
      .map(normalizeRoutingPhone)
      .filter(Boolean)
  ).has(normalized);
}

export function buildSafeTextgridRouteTiers({
  market = null,
  state = null,
  numbers = [],
  blocked_sender_numbers = [],
  target_market_aliases = [],
  allow_regional_fallback = true,
} = {}) {
  const sellerMarket = clean(market);
  const sellerState = clean(state).toUpperCase() || stateFromMarketLabel(sellerMarket);
  const sellerMarketKey = normalizeRoutingMarketKey(sellerMarket);
  const aliasKeys = new Set(
    (Array.isArray(target_market_aliases) ? target_market_aliases : [target_market_aliases])
      .map(normalizeRoutingMarketKey)
      .filter((key) => key && key !== sellerMarketKey)
  );
  const blockedSet = new Set(
    (Array.isArray(blocked_sender_numbers) ? blocked_sender_numbers : [blocked_sender_numbers])
      .map(normalizeRoutingPhone)
      .filter(Boolean)
  );
  const activeNumbers = (Array.isArray(numbers) ? numbers : [])
    .map(normalizedNumber)
    .filter((number) => number.phone_number && number.market);
  const safeNumbers = activeNumbers.filter(
    (number) => !number.health_blocked && !blockedSet.has(number.phone_number)
  );
  const exact = safeNumbers.filter(
    (number) => normalizeRoutingMarketKey(number.market) === sellerMarketKey
  );
  const alias = safeNumbers.filter((number) => {
    const marketKey = normalizeRoutingMarketKey(number.market);
    return (
      !exact.includes(number) &&
      (aliasKeys.has(marketKey) || normalizedAliases(number).includes(sellerMarketKey))
    );
  });
  const rule = findRegionalRoutingRule(sellerState);
  const regionalTiers = allow_regional_fallback
    ? (rule?.target_markets || []).map((targetMarket, index) => ({
        route_type: "approved_state_fallback",
        routing_rule_name: rule.name,
        route_priority: index + 1,
        target_market: targetMarket,
        candidates: safeNumbers.filter(
          (number) =>
            normalizeRoutingMarketKey(number.market) ===
            normalizeRoutingMarketKey(targetMarket)
        ),
      }))
    : [];

  return {
    seller_market: sellerMarket || null,
    seller_state: sellerState || null,
    active_numbers: activeNumbers,
    safe_numbers: safeNumbers,
    health_blocked_sender_count: Math.max(0, activeNumbers.length - safeNumbers.length),
    routing_rule_name: rule?.name || null,
    tiers: [
      {
        route_type: "exact_market_match",
        routing_rule_name: "exact_market_match",
        route_priority: 0,
        target_market: sellerMarket || null,
        candidates: exact,
      },
      {
        route_type: "approved_alias_match",
        routing_rule_name: "approved_alias_match",
        route_priority: 0,
        target_market: [...aliasKeys][0] || null,
        candidates: alias,
      },
      ...regionalTiers,
    ],
  };
}

export function selectSafeTextgridRoute(input = {}) {
  const route = buildSafeTextgridRouteTiers(input);
  const chooseCandidate =
    typeof input.choose_candidate === "function"
      ? input.choose_candidate
      : (candidates) => candidates[0] || null;

  for (const tier of route.tiers) {
    if (!tier.candidates.length) continue;
    const selected = chooseCandidate(tier.candidates, tier);
    if (!selected) continue;
    return {
      ok: true,
      routing_allowed: true,
      route_type: tier.route_type,
      routing_rule_name: tier.routing_rule_name,
      target_market: tier.target_market,
      selected,
      selected_textgrid_number: selected.phone_number,
      selected_textgrid_market: selected.market,
      seller_market: route.seller_market,
      seller_state: route.seller_state,
      health_blocked_sender_count: route.health_blocked_sender_count,
      active_number_count: route.active_numbers.length,
      safe_number_count: route.safe_numbers.length,
    };
  }

  const fallbackAllowed = input.allow_regional_fallback !== false;
  const reason = !route.active_numbers.length
    ? "NO_ACTIVE_TEXTGRID_NUMBERS"
    : !route.safe_numbers.length
      ? "ALL_ACTIVE_TEXTGRID_NUMBERS_HEALTH_BLOCKED"
      : !fallbackAllowed
        ? "NO_VALID_LOCAL_TEXTGRID_NUMBER"
        : "NO_APPROVED_ROUTING_PATH";

  return {
    ok: false,
    routing_allowed: false,
    route_type: "no_sender_route",
    routing_rule_name: route.routing_rule_name,
    selected: null,
    selected_textgrid_number: null,
    selected_textgrid_market: null,
    seller_market: route.seller_market,
    seller_state: route.seller_state,
    routing_block_reason: reason,
    health_blocked_sender_count: route.health_blocked_sender_count,
    active_number_count: route.active_numbers.length,
    safe_number_count: route.safe_numbers.length,
  };
}

export default {
  REGIONAL_ROUTING_RULES,
  buildSafeTextgridRouteTiers,
  findRegionalRoutingRule,
  isHealthBlockedSender,
  normalizeRoutingMarketKey,
  normalizeRoutingPhone,
  selectSafeTextgridRoute,
  stateFromMarketLabel,
};
