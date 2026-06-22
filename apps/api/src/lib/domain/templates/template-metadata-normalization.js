// Central normalization for template use_case, stage_code, touch, and language.

export const CANONICAL_USE_CASES = Object.freeze({
  OWNERSHIP_CHECK: 'ownership_check',
  OWNERSHIP_CHECK_FOLLOW_UP: 'ownership_check_follow_up',
  CONSIDER_SELLING: 'consider_selling',
  CONSIDER_SELLING_FOLLOW_UP: 'consider_selling_follow_up',
  SELLER_ASKING_PRICE: 'seller_asking_price',
  ASKING_PRICE_FOLLOW_UP: 'asking_price_follow_up',
  WHO_IS_THIS: 'who_is_this',
  WRONG_PERSON: 'wrong_person',
  NOT_OWNER: 'not_owner_acknowledgment',
  ENTITY_REPRESENTATIVE: 'entity_representative_clarification',
});

const USE_CASE_ALIASES = Object.freeze({
  asking_price: CANONICAL_USE_CASES.SELLER_ASKING_PRICE,
  'asking price': CANONICAL_USE_CASES.SELLER_ASKING_PRICE,
  seller_price_discovery: CANONICAL_USE_CASES.SELLER_ASKING_PRICE,
  asking_price_request: CANONICAL_USE_CASES.SELLER_ASKING_PRICE,
  'First Message': CANONICAL_USE_CASES.OWNERSHIP_CHECK,
});

const STAGE_BY_USE_CASE = Object.freeze({
  [CANONICAL_USE_CASES.OWNERSHIP_CHECK]: 'S1',
  [CANONICAL_USE_CASES.OWNERSHIP_CHECK_FOLLOW_UP]: 'S1',
  [CANONICAL_USE_CASES.CONSIDER_SELLING]: 'S2',
  [CANONICAL_USE_CASES.CONSIDER_SELLING_FOLLOW_UP]: 'S2',
  [CANONICAL_USE_CASES.SELLER_ASKING_PRICE]: 'S3',
  [CANONICAL_USE_CASES.ASKING_PRICE_FOLLOW_UP]: 'S3',
  [CANONICAL_USE_CASES.WHO_IS_THIS]: 'S1',
  [CANONICAL_USE_CASES.WRONG_PERSON]: 'S1',
  [CANONICAL_USE_CASES.NOT_OWNER]: 'S1',
  [CANONICAL_USE_CASES.ENTITY_REPRESENTATIVE]: 'S1',
});

const OPERATOR_STAGE_LABELS = Object.freeze({
  S1: 'S1 Ownership Confirmation',
  S2: 'S2 Selling Interest',
  S3: 'S3 Asking Price',
  S4: 'S4 Property Condition & Underwriting',
  S5: 'S5 Offer & Negotiation',
  S6: 'S6 Contract-to-Close',
});

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function normalizeCanonicalUseCase(value = null) {
  const raw = clean(value);
  if (!raw) return null;
  if (USE_CASE_ALIASES[raw]) return USE_CASE_ALIASES[raw];
  const lowered = lower(raw);
  if (USE_CASE_ALIASES[lowered]) return USE_CASE_ALIASES[lowered];
  return lowered.replace(/\s+/g, '_');
}

export function normalizeCanonicalStageCode({ use_case, stage_code, touch_number } = {}) {
  const normalizedUseCase = normalizeCanonicalUseCase(use_case);
  if (normalizedUseCase && STAGE_BY_USE_CASE[normalizedUseCase]) {
    return STAGE_BY_USE_CASE[normalizedUseCase];
  }
  const raw = upperStage(stage_code);
  if (raw && /^S[1-6]$/.test(raw)) return raw;
  if (Number(touch_number) >= 2) {
    // follow-up touch without explicit stage — infer from use case suffix
    if (normalizedUseCase?.includes('follow')) {
      return STAGE_BY_USE_CASE[normalizedUseCase.replace(/_follow_up$/, '')] || null;
    }
  }
  return raw || null;
}

function upperStage(value) {
  const raw = clean(value).toUpperCase();
  return raw || null;
}

export function normalizeTouchNumber({ touch_number, is_follow_up, is_first_touch, use_case } = {}) {
  const explicit = Number(touch_number);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(99, Math.floor(explicit));
  if (is_first_touch === true || is_first_touch === 'Yes') return 1;
  if (is_follow_up === true || is_follow_up === 'Yes') return 2;
  const uc = normalizeCanonicalUseCase(use_case);
  if (uc?.includes('follow_up')) return 2;
  return 1;
}

const LANGUAGE_ALIASES = Object.freeze({
  en: 'English',
  english: 'English',
  es: 'Spanish',
  spanish: 'Spanish',
  espanol: 'Spanish',
  ru: 'Russian',
  russian: 'Russian',
});

export function normalizeCanonicalLanguage(value = null) {
  const raw = clean(value);
  if (!raw) return null;
  const alias = LANGUAGE_ALIASES[lower(raw)];
  if (alias) return alias;
  // Title-case known canonical languages
  if (['English', 'Spanish', 'Russian'].includes(raw)) return raw;
  return raw;
}

export function resolveOperatorStageLabel(stageCode) {
  return OPERATOR_STAGE_LABELS[upperStage(stageCode)] || null;
}

export function normalizeTemplateDimensions(input = {}) {
  const use_case = normalizeCanonicalUseCase(input.use_case);
  const touch_number = normalizeTouchNumber({ ...input, use_case });
  const stage_code = normalizeCanonicalStageCode({ ...input, use_case, touch_number });
  const language = normalizeCanonicalLanguage(input.language);
  return {
    use_case,
    stage_code,
    stage_label: resolveOperatorStageLabel(stage_code),
    touch_number,
    language,
  };
}

export default {
  CANONICAL_USE_CASES,
  normalizeCanonicalUseCase,
  normalizeCanonicalStageCode,
  normalizeTouchNumber,
  normalizeCanonicalLanguage,
  normalizeTemplateDimensions,
  resolveOperatorStageLabel,
};