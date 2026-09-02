import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import {
  compactCount,
  compactCurrency,
  humanizeEnum,
  resolveMarket,
  type EntityScope,
} from './entity-graph-mobile-format'

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
}

export type ColumnGroup =
  | 'overview' | 'geography' | 'property' | 'ownership'
  | 'people' | 'contacts' | 'signals' | 'scores' | 'provenance'

export const COLUMN_GROUP_LABELS: Record<ColumnGroup, string> = {
  overview: 'Overview',
  geography: 'Geography',
  property: 'Property',
  ownership: 'Ownership',
  people: 'People / entity',
  contacts: 'Contacts',
  signals: 'Acquisition & signals',
  scores: 'Scores, value & equity',
  provenance: 'Provenance & system',
}

export const COLUMN_GROUP_ORDER: ColumnGroup[] = [
  'overview', 'geography', 'property', 'ownership',
  'people', 'contacts', 'signals', 'scores', 'provenance',
]

export type TableColumn = {
  key: string
  label: string
  group: ColumnGroup
  /** Backend sort column; absent means the column is display-only. */
  sortBy?: string
  align?: 'right'
  width: number
  render: (result: EntitySearchResult) => string | null
}

/**
 * Columns are declared per scope with an explicit width because the grid is
 * horizontally scrolled under a pinned identity column — an auto-width table
 * reflows every time a page appends and the sticky column drifts.
 *
 * `sortBy` is only set where the browse adapter genuinely orders by that
 * column (BROWSE_SORT_COLUMNS in entity-graph-service.js). A header that looks
 * sortable but silently does nothing is worse than a plain header.
 */
export const SCOPE_TABLE_COLUMNS: Record<EntityScope, TableColumn[]> = {
  properties: [
    { key: 'market', group: 'geography', label: 'Market', sortBy: 'market', width: 132, render: (r) => resolveMarket(r).label },
    { key: 'assetType', group: 'property', label: 'Type', width: 84, render: (r) => text(r.details?.assetType) },
    { key: 'value', group: 'scores', label: 'Value', sortBy: 'estimated_value', align: 'right', width: 84, render: (r) => compactCurrency(r.details?.value) },
    {
      key: 'equity',
      group: 'scores',
      label: 'Equity',
      align: 'right',
      width: 68,
      render: (r) => (typeof r.details?.equity === 'number' ? `${Math.round(r.details.equity)}%` : null),
    },
    {
      key: 'score',
      group: 'scores',
      label: 'Score',
      sortBy: 'final_acquisition_score',
      align: 'right',
      width: 64,
      render: (r) => {
        const score = r.details?.acquisitionScore ?? r.score
        return typeof score === 'number' ? String(Math.round(score)) : null
      },
    },
    { key: 'owner', group: 'ownership', label: 'Owner', width: 156, render: (r) => text(r.details?.ownerName) },
    {
      key: 'contacts',
      group: 'contacts',
      label: 'Reachable',
      align: 'right',
      width: 84,
      render: (r) => {
        const n = r.linkedCounts.reachableContacts ?? r.linkedCounts.contacts
        return typeof n === 'number' ? String(n) : null
      },
    },
    { key: 'units', group: 'property', label: 'Units', align: 'right', width: 60, render: (r) => compactCount(r.details?.units) },
    { key: 'zip', group: 'geography', label: 'ZIP', width: 72, render: (r) => text(r.details?.zip) },
    { key: 'flags', group: 'signals', label: 'Signals', width: 200, render: (r) => text(r.details?.flags) },
  ],
  master_owners: [
    { key: 'ownerType', group: 'ownership', label: 'Owner type', width: 150, render: (r) => humanizeEnum(r.details?.ownerType) },
    { key: 'tier', group: 'ownership', label: 'Tier', width: 74, render: (r) => humanizeEnum(r.details?.priorityTier) },
    {
      key: 'portfolio',
      group: 'ownership',
      label: 'Properties',
      sortBy: 'property_count',
      align: 'right',
      width: 90,
      render: (r) => compactCount(r.linkedCounts.properties),
    },
    {
      key: 'portfolioValue',
      group: 'scores',
      label: 'Portfolio',
      sortBy: 'portfolio_total_value',
      align: 'right',
      width: 92,
      render: (r) => compactCurrency(r.details?.portfolioValue),
    },
    {
      key: 'coverage',
      group: 'contacts',
      label: 'Coverage',
      align: 'right',
      width: 84,
      render: (r) => {
        const c = r.linkedCounts.contactCoverage
        return typeof c === 'number' ? `${Math.min(100, Math.round(c))}%` : null
      },
    },
    { key: 'people', group: 'people', label: 'People', align: 'right', width: 70, render: (r) => compactCount(r.linkedCounts.prospects) },
    { key: 'contacts', group: 'contacts', label: 'Contacts', align: 'right', width: 80, render: (r) => compactCount(r.linkedCounts.contacts) },
    {
      key: 'priority',
      group: 'scores',
      label: 'Priority',
      sortBy: 'priority_score',
      align: 'right',
      width: 76,
      render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null),
    },
  ],
  people: [
    { key: 'occupation', group: 'people', label: 'Occupation', width: 190, render: (r) => text(r.details?.occupation) },
    { key: 'language', group: 'people', label: 'Language', width: 92, render: (r) => text(r.details?.language) },
    { key: 'owner', group: 'ownership', label: 'Linked owner', width: 168, render: (r) => text(r.details?.ownerName) },
    { key: 'properties', group: 'ownership', label: 'Properties', align: 'right', width: 90, render: (r) => compactCount(r.linkedCounts.properties) },
    { key: 'contacts', group: 'contacts', label: 'Contacts', align: 'right', width: 84, render: (r) => compactCount(r.linkedCounts.contacts) },
    {
      key: 'contactScore',
      group: 'contacts',
      label: 'Contact score',
      sortBy: 'contact_score_final',
      align: 'right',
      width: 108,
      render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null),
    },
  ],
  organizations: [
    { key: 'entityType', group: 'ownership', label: 'Entity type', width: 140, render: (r) => text(r.details?.entityType) ?? text(r.subtitle) },
    { key: 'mailing', group: 'geography', label: 'Mailing address', width: 250, render: (r) => text(r.details?.mailingAddress) },
  ],
  contact_methods: [
    { key: 'type', group: 'contacts', label: 'Line type', width: 96, render: (r) => text(r.details?.phoneType) ?? text(r.details?.contactType) },
    { key: 'linked', group: 'people', label: 'Linked to', width: 190, render: (r) => text(r.subtitle) },
    { key: 'eligibility', group: 'contacts', label: 'Status', width: 100, render: (r) => text(r.details?.eligibility) },
    { key: 'reachability', group: 'contacts', label: 'Reachability', width: 110, render: (r) => text(r.details?.reachability) },
    {
      key: 'score',
      group: 'scores',
      label: 'Score',
      sortBy: 'contact_score_final',
      align: 'right',
      width: 70,
      render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null),
    },
  ],
}

export function defaultVisibleColumns(scope: EntityScope): string[] {
  // A sensible first screen, not everything — the rest is one tap away in the
  // column picker, and the choice persists per scope.
  const all = SCOPE_TABLE_COLUMNS[scope].map((c) => c.key)
  const preferred: Partial<Record<EntityScope, string[]>> = {
    properties: ['market', 'assetType', 'value', 'equity', 'score', 'owner', 'contacts'],
    master_owners: ['ownerType', 'tier', 'portfolio', 'portfolioValue', 'coverage'],
    people: ['occupation', 'language', 'properties', 'contacts'],
    organizations: ['entityType', 'mailing'],
    contact_methods: ['type', 'linked', 'eligibility', 'reachability'],
  }
  return preferred[scope] ?? all
}

/** Backend sort column behind each scope's pinned identity column. */
export const IDENTITY_SORT_COLUMN: Record<EntityScope, string | null> = {
  properties: 'property_address_full',
  master_owners: 'display_name',
  people: 'full_name',
  organizations: 'owner_name',
  contact_methods: null,
}

/**
 * Extended catalog, generated from the raw source columns the browse adapter
 * returns on `details.row`. These are the fields the column picker exposes
 * beyond the hand-tuned defaults, so "every legitimate field" is reachable
 * without hard-coding 80 render functions.
 *
 * Internal plumbing (row_hash, upsert_key, *_match_key, search_profile_hash,
 * raw_payload_json) is not selected by the adapter at all, so it cannot leak
 * here.
 */
const EXTRA_PROPERTY_COLUMNS: Array<{ key: string; label: string; group: ColumnGroup; width?: number; numeric?: boolean }> = [
  { key: 'property_address_county_name', label: 'County', group: 'geography', width: 130 },
  { key: 'subdivision_name', label: 'Subdivision', group: 'geography', width: 150 },
  { key: 'school_district_name', label: 'School district', group: 'geography', width: 170 },
  { key: 'flood_zone', label: 'Flood zone', group: 'geography', width: 100 },
  { key: 'zoning', label: 'Zoning', group: 'geography', width: 96 },
  { key: 'latitude', label: 'Latitude', group: 'geography', width: 96, numeric: true },
  { key: 'longitude', label: 'Longitude', group: 'geography', width: 96, numeric: true },
  { key: 'apn_parcel_id', label: 'APN / parcel', group: 'provenance', width: 140 },

  { key: 'year_built', label: 'Year built', group: 'property', width: 92, numeric: true },
  { key: 'effective_year_built', label: 'Eff. year built', group: 'property', width: 110, numeric: true },
  { key: 'stories', label: 'Stories', group: 'property', width: 72, numeric: true },
  { key: 'total_bedrooms', label: 'Beds', group: 'property', width: 64, numeric: true },
  { key: 'total_baths', label: 'Baths', group: 'property', width: 64, numeric: true },
  { key: 'building_square_feet', label: 'Building sqft', group: 'property', width: 110, numeric: true },
  { key: 'lot_acreage', label: 'Lot acres', group: 'property', width: 92, numeric: true },
  { key: 'lot_square_feet', label: 'Lot sqft', group: 'property', width: 92, numeric: true },
  { key: 'building_condition', label: 'Condition', group: 'property', width: 110 },
  { key: 'building_quality', label: 'Quality', group: 'property', width: 100 },
  { key: 'garage', label: 'Garage', group: 'property', width: 96 },
  { key: 'pool', label: 'Pool', group: 'property', width: 80 },
  { key: 'basement', label: 'Basement', group: 'property', width: 96 },
  { key: 'heating_type', label: 'Heating', group: 'property', width: 110 },
  { key: 'roof_cover', label: 'Roof', group: 'property', width: 100 },
  { key: 'sewer', label: 'Sewer', group: 'property', width: 90 },
  { key: 'water', label: 'Water', group: 'property', width: 90 },
  { key: 'property_class', label: 'Property class', group: 'property', width: 120 },

  { key: 'owner_name', label: 'Owner name (raw)', group: 'ownership', width: 170 },
  { key: 'owner_address_full', label: 'Owner address', group: 'ownership', width: 210 },
  { key: 'ownership_years', label: 'Years owned', group: 'ownership', width: 100, numeric: true },
  { key: 'is_corporate_owner', label: 'Corporate owner', group: 'ownership', width: 120 },
  { key: 'out_of_state_owner', label: 'Absentee owner', group: 'ownership', width: 118 },
  { key: 'priority_tier', label: 'Priority tier', group: 'ownership', width: 100 },

  { key: 'best_phone', label: 'Best phone', group: 'contacts', width: 130 },
  { key: 'best_email', label: 'Best email', group: 'contacts', width: 180 },
  { key: 'sms_eligible', label: 'SMS eligible', group: 'contacts', width: 106 },
  { key: 'contact_status', label: 'Contact status', group: 'contacts', width: 120 },
  { key: 'best_language', label: 'Language', group: 'contacts', width: 96 },
  { key: 'timezone', label: 'Timezone', group: 'contacts', width: 110 },

  { key: 'tax_delinquent', label: 'Tax delinquent', group: 'signals', width: 116 },
  { key: 'tax_delinquent_year', label: 'Tax delinq. year', group: 'signals', width: 120, numeric: true },
  { key: 'active_lien', label: 'Active lien', group: 'signals', width: 100 },
  { key: 'is_hot_preforeclosure', label: 'Hot pre-foreclosure', group: 'signals', width: 140 },
  { key: 'seller_tags_text', label: 'Seller tags', group: 'signals', width: 210 },
  { key: 'acquisition_bucket', label: 'Acquisition bucket', group: 'signals', width: 140 },

  { key: 'equity_amount', label: 'Equity $', group: 'scores', width: 100, numeric: true },
  { key: 'total_loan_balance', label: 'Loan balance', group: 'scores', width: 112, numeric: true },
  { key: 'assd_total_value', label: 'Assessed value', group: 'scores', width: 120, numeric: true },
  { key: 'sale_price', label: 'Last sale price', group: 'scores', width: 118, numeric: true },
  { key: 'sale_date', label: 'Last sale date', group: 'scores', width: 118 },
  { key: 'arv_estimate', label: 'ARV estimate', group: 'scores', width: 118, numeric: true },
  { key: 'rent_estimate', label: 'Rent estimate', group: 'scores', width: 118, numeric: true },
  { key: 'cap_rate', label: 'Cap rate', group: 'scores', width: 92, numeric: true },
  { key: 'ppsf', label: 'PPSF', group: 'scores', width: 84, numeric: true },
  { key: 'cash_offer', label: 'Cash offer', group: 'scores', width: 106, numeric: true },
  { key: 'estimated_repair_cost', label: 'Repair estimate', group: 'scores', width: 126, numeric: true },
  { key: 'rehab_level', label: 'Rehab level', group: 'scores', width: 106 },
  { key: 'structured_motivation_score', label: 'Motivation', group: 'scores', width: 100, numeric: true },
  { key: 'deal_strength_score', label: 'Deal strength', group: 'scores', width: 112, numeric: true },
  { key: 'tag_distress_score', label: 'Distress score', group: 'scores', width: 116, numeric: true },
  { key: 'ai_score', label: 'AI score', group: 'scores', width: 90, numeric: true },

  { key: 'property_id', label: 'Property ID', group: 'provenance', width: 130 },
  { key: 'master_owner_id', label: 'Master owner ID', group: 'provenance', width: 190 },
  { key: 'source_system', label: 'Source system', group: 'provenance', width: 130 },
  { key: 'created_at', label: 'Created', group: 'provenance', width: 118 },
  { key: 'updated_at', label: 'Updated', group: 'provenance', width: 118 },
  { key: 'exported_at_utc', label: 'Exported', group: 'provenance', width: 118 },
]

/** ZIPs, years and ids must not be thousands-separated. */
const LITERAL_NUMERIC = /(zip|year|_id$|apn|parcel|latitude|longitude)/i
const CURRENCY = /(value|price|amount|balance|offer|cost|estimate)/i

function renderRawField(key: string, numeric: boolean | undefined, result: EntitySearchResult): string | null {
  const raw = (result.details?.row ?? {})[key]
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No'
  const value = String(raw)
  if (!numeric || LITERAL_NUMERIC.test(key)) return value
  const num = Number(value)
  if (!Number.isFinite(num)) return value
  if (CURRENCY.test(key)) return compactCurrency(num) ?? value
  return Math.abs(num) >= 1000 ? num.toLocaleString() : String(Math.round(num * 100) / 100)
}

// Append the generated columns, skipping any key a hand-tuned column already owns.
{
  const existing = new Set(SCOPE_TABLE_COLUMNS.properties.map((c) => c.key))
  for (const extra of EXTRA_PROPERTY_COLUMNS) {
    if (existing.has(extra.key)) continue
    SCOPE_TABLE_COLUMNS.properties.push({
      key: extra.key,
      label: extra.label,
      group: extra.group,
      width: extra.width ?? 120,
      align: extra.numeric ? 'right' : undefined,
      render: (r) => renderRawField(extra.key, extra.numeric, r),
    })
  }
}
