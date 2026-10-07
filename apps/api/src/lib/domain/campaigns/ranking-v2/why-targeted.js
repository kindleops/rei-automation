// ─── ranking-v2/why-targeted.js ──────────────────────────────────────────────
// Acquisition OS §18 — "why targeted" per prospect, e.g.
//   "tax delinquent · absentee · 18 yrs · 72% equity · vacant · high repair
//    burden · strong buyer liquidity in ZIP"
//
// Built ONLY from evidence that fired: seller-situation evidence codes (A1's
// raw-facts model), the graph's own raw columns, and the ZIP market-quality
// terms. Never a legacy Podio score, never a protected-class field, never an
// invented phrase. Internal: never shown to sellers.

import { describeMarketQuality } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'
import { EVIDENCE_CATALOG } from '@/lib/acquisition/seller-situation/index.js'

/**
 * Fallback operator labels. A1's EVIDENCE_CATALOG (seller-situation) is the
 * authority and wins whenever it knows the code.
 */
export const EVIDENCE_LABELS = Object.freeze({
  TAX_DELINQUENT: 'tax delinquent',
  TAX_DELINQUENT_MULTI_YEAR: 'multi-year tax delinquent',
  TAX_DELINQUENT_YEAR: 'tax delinquent',
  LIEN_RECORDED: 'recorded lien',
  ACTIVE_LIEN: 'active lien',
  HOA_LIEN: 'HOA lien',
  PREFORECLOSURE: 'pre-foreclosure',
  FORECLOSURE: 'foreclosure',
  UPCOMING_AUCTION: 'upcoming auction',
  BANK_OWNED: 'bank owned',
  CODE_VIOLATION: 'code violation',
  PROBATE: 'probate',
  INHERITED: 'inherited',
  VACANT: 'vacant',
  VACANT_VENDOR_FLAG: 'vacant',
  ZOMBIE_PROPERTY: 'zombie property',
  ABSENTEE_OWNER: 'absentee',
  ABSENTEE: 'absentee',
  OUT_OF_STATE_OWNER: 'out-of-state owner',
  OUT_OF_STATE: 'out-of-state owner',
  LONG_TENURE: 'long tenure',
  TENURE_15Y: '15+ yrs owned',
  TENURE_20Y: '20+ yrs owned',
  PORTFOLIO_3P: 'portfolio owner',
  PORTFOLIO: 'portfolio owner',
  HIGH_EQUITY: 'high equity',
  FREE_AND_CLEAR: 'free & clear',
  REPAIR_BURDEN: 'high repair burden',
  HIGH_REPAIR_BURDEN: 'high repair burden',
  POOR_CONDITION: 'poor condition',
  OLD_BUILD: 'pre-1960 build',
  HEAVILY_DATED: 'heavily dated',
  ADJUSTABLE_LOAN: 'adjustable loan',
  HIGH_LTV: 'high loan-to-value',
  DEBT_BURDEN: 'debt burden',
  RENTAL: 'rental',
  TIRED_LANDLORD: 'tired landlord (flag only)',
  TIRED_LANDLORD_CORROBORATED: 'tired landlord (corroborated)',
  NO_UPDATES: 'no recorded updates',
  LIS_PENDENS: 'lis pendens',
  JUDGMENT_LIEN: 'judgment lien',
  MUNICIPAL_LIEN: 'municipal lien',
  TAX_LIEN: 'tax lien',
  FORECLOSURE_ACTIVE: 'active foreclosure',
  AUCTION_WITHIN_90D: 'auction within 90 days',
  DEATH_EVENT: 'owner death record',
  CONDITION_UNSOUND: 'unsound condition',
  CONDITION_POOR: 'poor condition',
  CONDITION_FAIR: 'fair condition',
  ARM_LOAN: 'adjustable loan',
  LOAN_MATURES_24M: 'loan matures ≤24 mo',
  ENTITY_DISSOLVED: 'owner entity dissolved',
  NEGATIVE_EQUITY: 'negative equity',
  VACANT_RENTAL: 'vacant rental',
  HIGH_EQUITY_CORROBORATED: 'high equity (corroborated)',
  REPAIR_TIER_HEAVY_FORMULA: 'heavy repair estimate',
  VALUE_2X_PURCHASE: 'value 2× purchase price',
})

const PROTECTED = /(race|ethnic|national|origin|religio|gender|sex|disab|familial|marital|age_|language)/i

const PATTERN_LABELS = [
  [/^EQUITY_(\d+)P$/, (m) => `${m[1]}%+ equity`],
  [/^TENURE_(\d+)Y$/, (m) => `${m[1]}+ yrs owned`],
  [/^PORTFOLIO_(\d+)P$/, (m) => `${m[1]}+ property portfolio`],
  [/^PORTFOLIO_(\d+)$/, (m) => `${m[1]}-property portfolio`],
  [/^LTV_(\d+)P$/, (m) => `${m[1]}%+ loan-to-value`],
  [/^BUILT_PRE_(\d{4})$/, (m) => `pre-${m[1]} build`],
  [/^TAX_RATE_GE_(\d+)(?:_(\d+))?PCT$/, (m) => `tax rate ≥${m[1]}${m[2] ? `.${m[2]}` : ''}%`],
]

/** Codes that are bookkeeping, not evidence an operator should read. */
const NON_EVIDENCE = new Set(['NO_SIGNAL', 'SOFT_SIGNALS_ONLY', 'COVERAGE_BELOW_40PCT', 'UNKNOWN', 'STUB'])

export function labelForEvidenceCode(code) {
  let key = String(code ?? '').trim().toUpperCase()
  if (!key || PROTECTED.test(key) || NON_EVIDENCE.has(key)) return null
  const authority = EVIDENCE_CATALOG?.[key]?.label
  if (authority) return authority
  // Vendor-flag codes (DealMachine property_flags list) read as the fact they flag.
  if (key.startsWith('VF_')) key = key.slice(3)
  if (EVIDENCE_LABELS[key]) return EVIDENCE_LABELS[key]
  for (const [re, fn] of PATTERN_LABELS) {
    const m = key.match(re)
    if (m) return fn(m)
  }
  return key.toLowerCase().replace(/_/g, ' ')
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * @returns {{code:string,label:string,kind:'situation'|'fact'|'market'|'contact',points:number|null,source:string}[]}
 */
export function buildWhyTargeted({ row = {}, situation = null, market = null, limit = 8 } = {}) {
  const out = []
  const seen = new Set()
  const push = (item) => {
    if (!item.label || seen.has(item.label)) return
    seen.add(item.label)
    out.push(item)
  }
  const evidence = Array.isArray(situation?.evidence) ? [...situation.evidence] : []
  evidence.sort((a, b) => (num(b.points) ?? 0) - (num(a.points) ?? 0))
  for (const e of evidence) {
    if ((num(e.points) ?? 0) <= 0) continue
    const label = labelForEvidenceCode(e.code)
    if (!label) continue
    push({ code: String(e.code), label, kind: 'situation', points: num(e.points), source: `${e.source_table || '?'}.${e.source_field || '?'}` })
  }
  // Raw graph facts that are evidence in their own right (only when present).
  const years = num(row.ownership_years)
  if (years !== null && years >= 10) push({ code: 'TENURE_YEARS', label: `${Math.floor(years)} yrs owned`, kind: 'fact', points: null, source: 'campaign_target_graph.ownership_years' })
  const eq = num(row.equity_percent)
  const loanKnown = num(row.total_loan_balance) !== null
  if (eq !== null && eq >= 40 && loanKnown) push({ code: 'EQUITY_PERCENT', label: `${Math.round(eq)}% equity`, kind: 'fact', points: null, source: 'campaign_target_graph.equity_percent' })
  if (row.tax_delinquent === true || row.tax_delinquent === 't') push({ code: 'TAX_DELINQUENT', label: 'tax delinquent', kind: 'fact', points: null, source: 'campaign_target_graph.tax_delinquent' })
  if (row.active_lien === true || row.active_lien === 't') push({ code: 'ACTIVE_LIEN', label: 'active lien', kind: 'fact', points: null, source: 'campaign_target_graph.active_lien' })
  const mq = describeMarketQuality(market)
  if (mq) push({ code: 'MARKET_QUALITY', label: `${market.label} market · ${mq}`, kind: 'market', points: null, source: market.provenance?.rollup || 'mi' })
  return out.slice(0, limit)
}

export function whyTargetedText(items = []) {
  return items.map((i) => i.label).join(' · ')
}
