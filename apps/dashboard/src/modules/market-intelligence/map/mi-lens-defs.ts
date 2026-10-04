/**
 * Market Intelligence lenses for the Map's lens registry. A LEAF module (type
 * imports only): views/map/mobile/map-lenses.ts spreads these into MAP_LENSES at
 * module init, so nothing here may import the Map or the shell.
 */
import type { MapLens } from '../../../views/map/mobile/map-lenses'

const lens = (metric: string, label: string, sub: string, format: MapLens['format'], attribution = 'Market Intelligence · canonical sales'): MapLens => ({
  id: `mi_${metric}`, label, sub, family: 'intel', source: `mi:${metric}`, legacyMode: 'acquisition', ramp: 'intel', format, attribution, areal: true,
})

export const MI_MAP_LENSES: ReadonlyArray<MapLens> = [
  lens('sales_count', 'Sales volume', 'Recorded sales in the period, by area', 'count'),
  lens('investor_purchase_count', 'Investor purchases', 'Sales with an investor buyer, by area', 'count'),
  lens('investor_purchase_share', 'Investor share', 'Investor purchases ÷ sales with a recorded buyer', 'share'),
  lens('cash_purchase_share', 'Cash share', 'Cash purchases ÷ sales with cash evidence', 'share'),
  lens('median_sale_price', 'Median price', 'Median qualified sale price', 'usdk'),
  lens('median_ppsf', 'Price / sq ft', 'Median qualified $ per sq ft', 'usd'),
  lens('median_price_per_unit', 'Price / unit', 'Median qualified 2–4 / 5+ price per unit', 'usdk'),
  lens('sales_growth', 'Sales change', 'Complete-month window vs the prior one (valid baselines only)', 'pct'),
  lens('entity_owned_count', 'Entity-owned now', 'Properties currently owned by a company (a state, not purchases)', 'count'),
  lens('company_buyer_count', 'Buyer activity', 'Distinct named company buyers in the period', 'count'),
  lens('seller_record_count', 'Seller density', 'Seller records (campaign graph summary)', 'count', 'Campaign target graph · summary'),
  lens('sms_eligible_count', 'Reachable sellers', 'SMS-eligible seller records (graph flag)', 'count', 'Campaign target graph · summary'),
  lens('tax_delinquent_share', 'Tax delinquency', 'Share of properties tax-delinquent', 'share', 'Property universe'),
  lens('avg_distress_score', 'Distress', 'Mean distress-tag score', 'score', 'Property universe'),
  lens('median_household_income', 'Household income', 'Median household income · ACS', 'usdk', 'US Census ACS 5-yr'),
]

