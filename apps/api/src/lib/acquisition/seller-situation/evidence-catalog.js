// ─── seller-situation/evidence-catalog.js ───────────────────────────────────
// Operator-facing labels for "why targeted" (§18). INTERNAL ONLY — never
// rendered into seller-facing text (§56, §57). Mirrored into the PROPOSED
// reference table public.seller_situation_evidence_codes.
// kind: hard = forced-sale-grade signal (tier A/B), strong / support = stack
// signal (tier B), context = scored but never decides a tier.

export const EVIDENCE_CATALOG = Object.freeze({
  FORECLOSURE_ACTIVE: { label: 'Foreclosure filing (recorded)', kind: 'hard' },
  FORECLOSURE_STALE_NOD: { label: 'Old notice of default (stale)', kind: 'context' },
  AUCTION_WITHIN_90D: { label: 'Auction within 90 days', kind: 'hard' },
  VF_PREFORECLOSURE: { label: 'Preforeclosure (DealMachine flag)', kind: 'hard' },
  TAX_DELINQUENT: { label: 'Tax delinquent', kind: 'hard' },
  TAX_DELINQUENT_MULTI_YEAR: { label: 'Tax delinquent 2+ years', kind: 'hard' },
  VF_TAX_DELINQUENT: { label: 'Tax delinquent (DealMachine flag)', kind: 'hard' },
  TAX_LIEN: { label: 'Recorded tax lien', kind: 'hard' },
  LIS_PENDENS: { label: 'Lis pendens recorded', kind: 'hard' },
  JUDGMENT_LIEN: { label: 'Judgment lien', kind: 'hard' },
  MUNICIPAL_LIEN: { label: 'Municipal lien (code/utility)', kind: 'hard' },
  MUNICIPAL_LIEN_UPKEEP: { label: 'Municipal lien (upkeep burden)', kind: 'context' },
  HOA_LIEN: { label: 'HOA lien', kind: 'hard' },
  LIEN_RECORDED: { label: 'Recorded lien', kind: 'hard' },
  VF_ACTIVE_LIEN: { label: 'Active lien (DealMachine flag)', kind: 'hard' },
  LIEN_AMOUNT_GE_5PCT_VALUE: { label: 'Liens ≥ 5% of value', kind: 'context' },
  PROBATE: { label: 'Probate filing', kind: 'hard' },
  DEATH_EVENT: { label: 'Owner death recorded', kind: 'hard' },
  VF_PROBATE: { label: 'Probate (DealMachine flag)', kind: 'hard' },
  VACANT: { label: 'Vacant', kind: 'hard' },
  VF_VACANT: { label: 'Vacant (DealMachine flag)', kind: 'hard' },
  VACANT_UPKEEP: { label: 'Vacant (upkeep burden)', kind: 'context' },
  VACANT_RENTAL: { label: 'Vacant rental', kind: 'context' },
  ENTITY_DISSOLVED: { label: 'Owning entity dissolved', kind: 'strong' },
  CONDITION_UNSOUND: { label: 'Condition: unsound', kind: 'hard' },
  CONDITION_POOR: { label: 'Condition: poor', kind: 'hard' },
  CONDITION_FAIR: { label: 'Condition: fair', kind: 'strong' },
  VF_HEAVILY_DATED: { label: 'Heavily dated (DealMachine flag)', kind: 'support' },
  VF_NO_UPDATES: { label: 'No updates (DealMachine flag)', kind: 'context' },
  BUILT_PRE_1960: { label: 'Built before 1960', kind: 'support' },
  BUILT_PRE_1980: { label: 'Built before 1980', kind: 'context' },
  REPAIR_TIER_HEAVY_FORMULA: { label: 'Heavy repair tier (formula estimate)', kind: 'context' },
  ABSENTEE: { label: 'Absentee owner', kind: 'support' },
  OUT_OF_STATE: { label: 'Out-of-state owner', kind: 'strong' },
  RENTAL_ASSET_CLASS: { label: 'Rental asset (2+ units)', kind: 'context' },
  TENURE_20Y: { label: 'Owned 20+ years', kind: 'strong' },
  TENURE_15Y: { label: 'Owned 15+ years', kind: 'support' },
  TENURE_10Y: { label: 'Owned 10+ years', kind: 'context' },
  TENURE_5Y: { label: 'Owned 5+ years', kind: 'context' },
  PORTFOLIO_5P: { label: 'Owns 5+ properties', kind: 'strong' },
  PORTFOLIO_3P: { label: 'Owns 3–4 properties', kind: 'strong' },
  PORTFOLIO_2: { label: 'Owns 2 properties', kind: 'context' },
  TIRED_LANDLORD_CORROBORATED: { label: 'Tired landlord (corroborated by portfolio)', kind: 'strong' },
  VF_TIRED_LANDLORD: { label: 'Tired landlord (DealMachine flag only)', kind: 'context' },
  OLD_RENTAL_STOCK: { label: 'Older rental (50+ yrs)', kind: 'context' },
  RENTAL_CONDITION_BURDEN: { label: 'Rental in fair/poor condition', kind: 'context' },
  EQUITY_80P: { label: 'Equity ≥ 80%', kind: 'support' },
  EQUITY_60P: { label: 'Equity ≥ 60%', kind: 'support' },
  EQUITY_40P: { label: 'Equity ≥ 40%', kind: 'support' },
  EQUITY_20P: { label: 'Equity ≥ 20%', kind: 'context' },
  FREE_AND_CLEAR: { label: 'Free and clear (raw_facts_v1 rows only; retired in v1.1)', kind: 'context' },
  VF_FREE_AND_CLEAR: { label: 'Free and clear (DealMachine flag)', kind: 'support' },
  VF_HIGH_EQUITY: { label: 'High equity (DealMachine flag, no %)', kind: 'support' },
  HIGH_EQUITY_CORROBORATED: { label: 'High equity (corroborated)', kind: 'context' },
  LONG_HOLD_EQUITY: { label: 'Long hold (15+ yrs) equity', kind: 'context' },
  MID_HOLD_EQUITY: { label: 'Hold 10+ yrs equity', kind: 'context' },
  VALUE_2X_PURCHASE: { label: 'Value ≥ 2× purchase price', kind: 'context' },
  NON_PRIMARY_EQUITY: { label: 'Equity in a non-primary asset', kind: 'context' },
  TAX_RATE_GE_2PCT: { label: 'Property tax ≥ 2% of value', kind: 'context' },
  TAX_RATE_GE_1_5PCT: { label: 'Property tax ≥ 1.5% of value', kind: 'context' },
  CAPITAL_GAINS_EXPOSURE: { label: 'Large embedded gain (absentee, 10+ yrs)', kind: 'context' },
  LTV_95P: { label: 'Loan ≥ 95% of value', kind: 'strong' },
  LTV_80P: { label: 'Loan ≥ 80% of value', kind: 'strong' },
  LTV_65P: { label: 'Loan ≥ 65% of value', kind: 'context' },
  LTV_45P: { label: 'Loan ≥ 45% of value', kind: 'context' },
  NEGATIVE_EQUITY: { label: 'Negative equity', kind: 'context' },
  PAYMENT_GE_6PCT_VALUE: { label: 'Debt service ≥ 6% of value / yr', kind: 'context' },
  FORECLOSURE_DEBT_ENFORCEMENT: { label: 'Lender enforcing debt', kind: 'context' },
  ARM_LOAN: { label: 'Adjustable-rate loan', kind: 'strong' },
  LOAN_MATURES_24M: { label: 'Loan matures within 24 months', kind: 'strong' },
  JUNIOR_LIEN: { label: 'Junior mortgage lien', kind: 'context' },
});

export function evidenceLabel(code) {
  return EVIDENCE_CATALOG[code]?.label ?? code;
}

/** Compact "why targeted" line, strongest first: "Tax delinquent · Vacant · Owned 20+ years". */
export function whyTargeted(evidence = [], { max = 6 } = {}) {
  const rank = { hard: 0, strong: 1, support: 2, context: 3 };
  const seen = new Set();
  return [...evidence]
    .sort((a, b) => (rank[EVIDENCE_CATALOG[a.code]?.kind] ?? 9) - (rank[EVIDENCE_CATALOG[b.code]?.kind] ?? 9) || b.points - a.points)
    .filter((e) => (seen.has(e.code) ? false : seen.add(e.code)))
    .slice(0, max)
    .map((e) => evidenceLabel(e.code))
    .join(' · ');
}
