function clean(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[\s-]+/g, "_");
}

export const ACQUISITION_STAGES = Object.freeze({
  OWNERSHIP_CHECK: "ownership_check",
  CONSIDER_SELLING: "consider_selling",
  ASKING_PRICE: "asking_price",
  CONDITION: "condition",
  OFFER_NEGOTIATION: "offer_negotiation",
});

export const ACQUISITION_STAGE_LIST = Object.freeze(
  Object.values(ACQUISITION_STAGES)
);

export const ACQUISITION_STAGE_ALIASES = Object.freeze({
  ownership_confirmation: ACQUISITION_STAGES.OWNERSHIP_CHECK,
  s1: ACQUISITION_STAGES.OWNERSHIP_CHECK,
  selling_interest: ACQUISITION_STAGES.CONSIDER_SELLING,
  offer_interest_confirmation: ACQUISITION_STAGES.CONSIDER_SELLING,
  s2: ACQUISITION_STAGES.CONSIDER_SELLING,
  price_or_offer: ACQUISITION_STAGES.ASKING_PRICE,
  seller_price_discovery: ACQUISITION_STAGES.ASKING_PRICE,
  seller_asking_price: ACQUISITION_STAGES.ASKING_PRICE,
  s3: ACQUISITION_STAGES.ASKING_PRICE,
  condition_probe: ACQUISITION_STAGES.CONDITION,
  price_high_condition_probe: ACQUISITION_STAGES.CONDITION,
  price_works_confirm_basics: ACQUISITION_STAGES.CONDITION,
  ask_condition_clarifier: ACQUISITION_STAGES.CONDITION,
  s4: ACQUISITION_STAGES.CONDITION,
  offer_reveal: ACQUISITION_STAGES.OFFER_NEGOTIATION,
  negotiation: ACQUISITION_STAGES.OFFER_NEGOTIATION,
  s5: ACQUISITION_STAGES.OFFER_NEGOTIATION,
});

const CANONICAL_STAGE_SET = new Set(ACQUISITION_STAGE_LIST);

export function normalizeAcquisitionStage(
  value,
  fallback = ACQUISITION_STAGES.OWNERSHIP_CHECK
) {
  const normalized = normalizeKey(value);
  if (!normalized) return fallback;
  if (CANONICAL_STAGE_SET.has(normalized)) return normalized;
  if (ACQUISITION_STAGE_ALIASES[normalized]) {
    return ACQUISITION_STAGE_ALIASES[normalized];
  }
  if (normalized.includes("offer") || normalized.includes("negotiation")) {
    return ACQUISITION_STAGES.OFFER_NEGOTIATION;
  }
  return fallback;
}

export function isCanonicalAcquisitionStage(value) {
  return CANONICAL_STAGE_SET.has(normalizeKey(value));
}
