// Sentinel & five-state normalization (Phase 1 approval packet §3C registry).
// Raw values are ALWAYS preserved by callers; these helpers only produce the
// normalized view + value_state. States: known | unknown | unavailable | not_applicable.

export const STATES = Object.freeze({
  KNOWN: 'known', UNKNOWN: 'unknown', UNAVAILABLE: 'unavailable', NOT_APPLICABLE: 'not_applicable',
});

const TRUE_SET = new Set(['1', 'true', 'yes', 'y', 'h']);
const FALSE_SET = new Set(['0', 'false', 'no', 'n', 'r']);

export function parseBool(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return { value: null, state: STATES.UNKNOWN };
  if (TRUE_SET.has(s)) return { value: true, state: STATES.KNOWN };
  if (FALSE_SET.has(s)) return { value: false, state: STATES.KNOWN };
  return { value: null, state: STATES.UNKNOWN, note: `unparseable_bool:${s.slice(0, 20)}` };
}

export function parseNumber(raw, { sentinels = [], min = null, max = null, zeroMeansUnknown = false } = {}) {
  const s = String(raw ?? '').trim().replace(/[$,]/g, '');
  if (s === '') return { value: null, state: STATES.UNKNOWN };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, state: STATES.UNKNOWN, note: 'parse_fail' };
  if (sentinels.some((sv) => Math.abs(n - sv) < 1e-9)) {
    return { value: null, state: STATES.UNKNOWN, note: `sentinel:${n}` };
  }
  if (zeroMeansUnknown && n === 0) return { value: null, state: STATES.UNKNOWN, note: 'zero_means_unknown' };
  if ((min !== null && n < min) || (max !== null && n > max)) {
    return { value: null, state: STATES.UNKNOWN, note: `impossible:${n}` };
  }
  return { value: n, state: STATES.KNOWN };
}

// Field-level rules distilled from the registry. Keyed by canonical semantics,
// not raw column names, so all slot variants share one rule.
export const RULES = Object.freeze({
  equity_percent: { sentinels: [-999.99], min: -500, max: 100 },
  loan_term_months: { sentinels: [999], zeroMeansUnknown: true, min: 1, max: 600 },
  interest_rate: { min: 0, max: 30 },
  loan_balance: { min: 0, max: null },           // negatives are impossible (quarantine)
  household_count: { zeroMeansUnknown: true },   // vendor uses 0 = no data
  income_band_code: { zeroMeansUnknown: true },  // '$0' code 0 = unknown (OD-7 interim)
  year_built: { min: 1700, max: 2100 },
  portfolio_amount: { min: -1e9, max: 1e9 },     // hard guard; softer winsorize downstream
});

export const UNAVAILABLE_TOKENS = new Set(['restricted']);
export function parseCategorical(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, state: STATES.UNKNOWN };
  if (UNAVAILABLE_TOKENS.has(s.toLowerCase())) return { value: null, state: STATES.UNAVAILABLE, note: s };
  if (s.toLowerCase() === 'unknown') return { value: null, state: STATES.UNKNOWN, note: 'explicit_unknown' };
  return { value: s, state: STATES.KNOWN };
}

// Blanket/package-loan guard (T-05): balances impossibly large relative to value.
export function blanketLoanGuard(balance, propertyValue, multiple = 3) {
  if (balance === null || propertyValue === null || propertyValue <= 0) return false;
  return balance > propertyValue * multiple && balance > 1_000_000;
}

// Price-qualifier router (Phase 1 §3E / IX-15).
const VALUATION_OK = [/full amount stated/i, /rounded by county/i, /computed from transfer tax/i,
  /sales price from transfer tax/i, /affidavit of value/i, /transfer tax not keyed/i];
const VALUATION_CAUTION = [/assessment file/i];
const DISTRESS = [/non-?arms length/i, /sold for taxes/i, /redemption/i, /judgment amount/i, /no consideration|"0"|price as "0"/i];
const EVIDENCE_ONLY = [/exempt/i, /estimated sales price/i];

export function priceQualifierClass(qualifier) {
  const q = String(qualifier ?? '').trim();
  if (q === '') return 'unknown';
  if (VALUATION_OK.some((re) => re.test(q))) return 'valuation';
  if (VALUATION_CAUTION.some((re) => re.test(q))) return 'valuation_caution';
  if (DISTRESS.some((re) => re.test(q))) return 'distress_context';
  if (EVIDENCE_ONLY.some((re) => re.test(q))) return 'evidence_only';
  return 'unusable';
}
