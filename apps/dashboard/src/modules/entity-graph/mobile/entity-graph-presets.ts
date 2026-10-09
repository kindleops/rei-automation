/**
 * ONE-TAP FILTERS. Each preset is an ordinary field filter in the catalog's
 * vocabulary — nothing here the backend cannot execute, nothing it would
 * silently ignore. Toggling a preset adds/removes exactly that filter.
 */
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import type { EntityScope } from './entity-graph-mobile-format'

export type Preset = { key: string; label: string; tone?: 'alert' | 'warn' | 'buyer' | 'info'; filter: EntityGraphFieldFilter }
export type PresetGroup = { label: string; presets: Preset[] }

const f = (field_key: string, operator: string, value?: unknown): EntityGraphFieldFilter => ({ field_key, operator, value })

export const PRESETS: Partial<Record<EntityScope, PresetGroup[]>> = {
  properties: [
    {
      label: 'Distress on record',
      presets: [
        { key: 'probate', label: 'Probate', tone: 'alert', filter: f('records.has_probate', 'is_true') },
        { key: 'death', label: 'Death record', tone: 'alert', filter: f('records.has_death_record', 'is_true') },
        { key: 'lis', label: 'Lis pendens', tone: 'alert', filter: f('records.has_lis_pendens', 'is_true') },
        { key: 'fc', label: 'Foreclosure filing', tone: 'alert', filter: f('records.foreclosure_count', 'gte', 1) },
        { key: 'nod', label: 'Notice of default', tone: 'alert', filter: f('records.has_default_notice', 'is_true') },
        // either vendor source — the column and the "Tax Delinquent" flag disagree (453 vs 601 on a 5% slice); the Signals badge reads both
        { key: 'taxdel', label: 'Tax delinquent', tone: 'warn', filter: f('properties.tax_delinquent_any', 'is_true') },
        // an actual recorded lien — not a UCC filing, affidavit, probate or contract (records.lien_count counts all of those)
        { key: 'reclien', label: 'Recorded lien', tone: 'warn', filter: f('records.has_lien', 'is_true') },
        { key: 'taxlien', label: 'Tax lien', tone: 'warn', filter: f('records.has_tax_lien', 'is_true') },
        { key: 'judgment', label: 'Judgment', tone: 'warn', filter: f('records.has_judgment', 'is_true') },
        { key: 'mech', label: "Mechanic's lien", tone: 'warn', filter: f('records.has_mechanics_lien', 'is_true') },
        { key: 'divorce', label: 'Divorce record', tone: 'warn', filter: f('records.has_divorce_record', 'is_true') },
      ],
    },
    {
      label: 'Equity & debt',
      presets: [
        // Known equity only (equity_known_v1): the vendor equity_percent reads
        // 100% with no loan on file, so the raw column matched 164,245 of
        // ~177K properties for "60%+" (filter audit 2026-10-08).
        { key: 'equity60', label: 'Equity 60%+', filter: f('properties.known_equity_percent', 'gte', 60) },
        { key: 'freeclear', label: 'No open mortgage', filter: f('records.mortgage_count', 'lte', 0) },
        { key: 'rate7', label: 'Rate 7%+', filter: f('records.first_rate', 'gte', 7) },
        { key: 'ratelow', label: 'Rate under 4%', filter: f('records.first_rate', 'lte', 3.9999) },
        { key: 'private', label: 'Private lender', tone: 'info', filter: f('records.has_private_lender', 'is_true') },
        { key: 'arm', label: 'Adjustable rate', filter: f('records.has_adjustable', 'is_true') },
        { key: 'heloc', label: 'Credit line', filter: f('records.has_heloc', 'is_true') },
        { key: 'seller', label: 'Seller-financed', filter: f('records.has_seller_financing', 'is_true') },
        { key: 'twoloans', label: '2+ open loans', filter: f('records.mortgage_count', 'gte', 2) },
      ],
    },
    {
      label: 'Ownership & history',
      presets: [
        { key: 'absentee', label: 'Out-of-state owner', filter: f('properties.out_of_state_owner', 'is_true') },
        { key: 'corp', label: 'Company-owned', filter: f('properties.is_corporate_owner', 'is_true') },
        { key: 'owned20', label: 'Owned 20+ years', filter: f('records.years_owned', 'gte', 20) },
        { key: 'owned10', label: 'Owned 10+ years', filter: f('records.years_owned', 'gte', 10) },
        { key: 'recent', label: 'Sold in last 2 years', filter: f('records.years_owned', 'lte', 1) },
        { key: 'trustee', label: 'Bought at trustee/sheriff sale', tone: 'info', filter: f('records.last_sale_distress', 'is_true') },
        { key: 'intrafamily', label: 'Intrafamily / quitclaim', filter: f('records.last_sale_intrafamily', 'is_true') },
      ],
    },
    {
      label: 'Buyer crossover',
      presets: [
        { key: 'ownerbuyer', label: 'Owner is a repeat buyer', tone: 'buyer', filter: f('records.owner_buyer_acquisitions', 'gte', 2) },
        { key: 'owneractive', label: 'Owner still buying', tone: 'buyer', filter: f('records.owner_buyer_status', 'is_any_of', ['active']) },
        { key: 'ownerrepeat', label: 'Owner bought 5+', tone: 'buyer', filter: f('records.owner_buyer_acquisitions', 'gte', 5) },
      ],
    },
  ],
  buyers: [
    {
      label: 'Activity',
      presets: [
        { key: 'active', label: 'Active', tone: 'buyer', filter: f('buyers.activity_status', 'is_any_of', ['active']) },
        // the buyer index counts back from its latest recorded sale (not today): label says so
        { key: 'd90', label: 'Bought in last 90 days of sales data', tone: 'buyer', filter: f('buyers.trailing_90d', 'gte', 1) },
        { key: 'y3', label: '3+ in last 12 months of sales data', tone: 'buyer', filter: f('buyers.trailing_365d', 'gte', 3) },
        { key: 'p5', label: '5+ purchases', filter: f('buyers.acquisition_count', 'gte', 5) },
        { key: 'p25', label: '25+ purchases', filter: f('buyers.acquisition_count', 'gte', 25) },
        { key: 'slowing', label: 'Slowing down', tone: 'warn', filter: f('buyers.activity_status', 'is_any_of', ['slowing']) },
      ],
    },
    {
      label: 'Behaviour',
      presets: [
        { key: 'inst', label: 'Institutional', filter: f('buyers.archetype', 'is_any_of', ['institutional_high_volume_buyer']) },
        { key: 'flip', label: 'Flippers', filter: f('buyers.hold_flip', 'is_any_of', ['flip_like']) },
        { key: 'hold', label: 'Holders', filter: f('buyers.hold_flip', 'is_any_of', ['hold_like']) },
        { key: 'cash', label: '80%+ cash', filter: f('buyers.cash_share', 'gte', 0.8) },
        { key: 'sfr', label: 'Buys single family', filter: f('buyers.asset_families', 'is_any_of', ['sfr']) },
        { key: 'mf', label: 'Buys 2–4 units', filter: f('buyers.asset_families', 'is_any_of', ['small_multifamily_2_4']) },
        { key: 'apt', label: 'Buys apartments', filter: f('buyers.asset_families', 'is_any_of', ['apartments_5plus', 'multifamily_unspecified']) },
        { key: 'buybox', label: 'Has a buy box', filter: f('buyers.has_buybox', 'is_true') },
      ],
    },
    {
      label: 'Roles & identity',
      presets: [
        { key: 'cross', label: 'Buys and sells', tone: 'info', filter: f('buyers.is_crossover', 'is_true') },
        { key: 'owns', label: 'Owns in our universe', filter: f('buyers.owned_count', 'gte', 1) },
        { key: 'sold', label: 'Has sold', filter: f('buyers.sold_count', 'gte', 1) },
        { key: 'company', label: 'Companies', filter: f('buyers.entity_type', 'is_any_of', ['company']) },
        { key: 'person', label: 'Individuals', filter: f('buyers.entity_type', 'is_any_of', ['person']) },
      ],
    },
  ],
}

export function presetActive(filters: EntityGraphFieldFilter[], preset: Preset): boolean {
  return filters.some((x) => x.field_key === preset.filter.field_key
    && x.operator === preset.filter.operator
    && JSON.stringify(x.value ?? null) === JSON.stringify(preset.filter.value ?? null))
}

export function togglePreset(filters: EntityGraphFieldFilter[], preset: Preset): EntityGraphFieldFilter[] {
  if (presetActive(filters, preset)) {
    return filters.filter((x) => !(x.field_key === preset.filter.field_key && x.operator === preset.filter.operator
      && JSON.stringify(x.value ?? null) === JSON.stringify(preset.filter.value ?? null)))
  }
  // One constraint per field: a preset replaces any other filter on the same field.
  return [...filters.filter((x) => x.field_key !== preset.filter.field_key), preset.filter]
}
