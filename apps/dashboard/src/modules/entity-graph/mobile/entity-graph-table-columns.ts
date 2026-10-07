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

/**
 * A property with no record-summary row has unknown loan / lien counts. The
 * API sends `captured: false` and a placeholder 0; the table says "—".
 */
/** The equity cell under equity_known_v1 (see the Equity column). */
export function equityLabel(r: EntitySearchResult): string {
  const d = r.details
  if (d?.equityRule === 'free_and_clear') return 'Free & clear'
  if (typeof d?.equity === 'number' && d.equityRule === 'loan_and_value') return `${Math.round(d.equity)}%`
  if (d?.equityRule === 'vendor_high_equity_flag') return 'High (flag)'
  if (d?.equityRule === 'vendor_low_equity_flag') return 'Low (flag)'
  return 'Unknown'
}

const recordsCaptured = (r: EntitySearchResult): boolean => Boolean(r.details?.records) && r.details?.records?.captured !== false

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
  /**
   * Property column the browse row does not carry: loaded only while visible,
   * for the rows on screen, through /api/cockpit/entity-graph/columns, and
   * read back from `details.row`. Absent value renders "—".
   */
  field?: string
  /** Raw comparable value for sorting the loaded rows (null sorts last). */
  sortValue?: (result: EntitySearchResult) => string | number | null
}

/**
 * Columns are declared per scope with an explicit width because the grid is
 * horizontally scrolled under a pinned identity column — an auto-width table
 * reflows every time a page appends and the sticky column drifts.
 *
 * `sortBy` asks the browse adapter for a whole-cohort order on that column
 * (an index-backed offset sort, or keyset when a (column, property_id) index
 * exists — entity-graph-property-sort.js). The server answers
 * sort.sortApplied=false when it cannot, and the table then sorts the loaded
 * rows and says so; a header never silently does nothing.
 */
export const SCOPE_TABLE_COLUMNS: Record<EntityScope, TableColumn[]> = {
  properties: [
    { key: 'market', group: 'geography', label: 'Market', sortBy: 'market', width: 132, render: (r) => resolveMarket(r).label },
    { key: 'assetType', group: 'property', label: 'Type', width: 84, render: (r) => text(r.details?.assetType) },
    { key: 'value', group: 'scores', label: 'Value', sortBy: 'estimated_value', align: 'right', width: 84, render: (r) => compactCurrency(r.details?.value) },
    {
      /**
       * equity_known_v1 (owner, 2026-10-07): the vendor equity_percent reads
       * 100% whenever no loan is on file. The server sends the evidence-based
       * value (details.equity is null unless known) and the rule; the column
       * says "Free & clear", a vendor class, or "Unknown" — never a
       * fabricated 100%. No server sort: equity_percent orders the unknowns
       * first, so the loaded rows are sorted (known % first, unknown last).
       */
      key: 'equity',
      group: 'scores',
      label: 'Equity',
      align: 'right',
      width: 82,
      render: (r) => equityLabel(r),
      sortValue: (r) => (typeof r.details?.equity === 'number' ? r.details.equity : null),
    },
    /**
     * §9 — the "Score" column is gone.
     *
     * It sorted and rendered `final_acquisition_score`, a Podio-era OUTPUT the
     * current Decision Engine never reads (see decisionAuthority.js, which names
     * it explicitly among the columns that are "never inputs to this engine").
     * Headed simply "Score" in a table of live acquisition data, it read as the
     * engine's verdict on 104,217 properties of which 163 have an engine row.
     * Current economics live in `property_acquisition_scores` and are surfaced in
     * the detail sheet, where the engine's state can be stated alongside them.
     */
    { key: 'owner', group: 'ownership', label: 'Owner', width: 170, render: (r) => text(r.details?.ownerName) },
    {
      key: 'ownerBuyer',
      group: 'ownership',
      label: 'Owner buys',
      align: 'right',
      width: 96,
      render: (r) => {
        const b = r.details?.records?.ownerBuyer
        return b ? `${b.acquisitions ?? '—'} · ${b.status ?? ''}`.trim() : null
      },
    },
    { key: 'loans', group: 'signals', label: 'Loans', sortBy: 'rec_mortgage_count', align: 'right', width: 62, render: (r) => (recordsCaptured(r) ? String(r.details!.records!.mortgageCount) : null) },
    { key: 'balance', group: 'scores', label: 'Balance', sortBy: 'rec_mortgage_balance', align: 'right', width: 88, render: (r) => compactCurrency(r.details?.records?.mortgageBalance) },
    { key: 'rate', group: 'signals', label: 'Rate', align: 'right', width: 64, render: (r) => (typeof r.details?.records?.firstRate === 'number' ? `${Number(r.details.records.firstRate).toFixed(2)}%` : null) },
    { key: 'lender', group: 'signals', label: 'Lender', width: 170, render: (r) => text(r.details?.records?.firstLender) },
    { key: 'liens', group: 'signals', label: 'Liens', sortBy: 'rec_lien_count', align: 'right', width: 60, render: (r) => (recordsCaptured(r) ? String(r.details!.records!.lienCount) : null) },
    { key: 'lastSale', group: 'signals', label: 'Last sale', sortBy: 'rec_last_sale_date', width: 96, render: (r) => text(r.details?.records?.lastSaleDate)?.slice(0, 7) ?? null },
    { key: 'lastPrice', group: 'scores', label: 'Sale price', align: 'right', width: 90, render: (r) => compactCurrency(r.details?.records?.lastSalePrice) },
    { key: 'records', group: 'signals', label: 'Recorded signals', width: 220, render: (r) => (r.details?.records?.signals ?? []).map((s) => s.label).join(' · ') || null },
    { key: 'units', group: 'property', label: 'Units', sortBy: 'units_count', align: 'right', width: 60, render: (r) => compactCount(r.details?.units) },
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
  buyers: [
    { key: 'purchases', group: 'overview', label: 'Purchases', sortBy: 'acquisition_count', align: 'right', width: 88, render: (r) => compactCount(r.details?.acquisitions) },
    { key: 'status', group: 'overview', label: 'Activity', width: 88, render: (r) => humanizeEnum(r.details?.activityStatus) },
    { key: 'market', group: 'geography', label: 'Primary market', width: 150, render: (r) => text(r.details?.primaryMarket) },
    { key: 'archetype', group: 'signals', label: 'Archetype', width: 150, render: (r) => text(r.details?.archetypeLabel) },
    { key: 'last', group: 'overview', label: 'Last buy', sortBy: 'last_acquisition', width: 96, render: (r) => text(r.details?.lastAcquisition)?.slice(0, 7) ?? null },
    { key: 'year', group: 'overview', label: '12 mo', sortBy: 'trailing_365d', align: 'right', width: 64, render: (r) => compactCount(r.details?.trailing365) },
    { key: 'median', group: 'scores', label: 'Median price', align: 'right', width: 100, render: (r) => compactCurrency(r.details?.priceP50) },
    { key: 'cash', group: 'scores', label: 'Cash', align: 'right', width: 64, render: (r) => (typeof r.details?.cashShare === 'number' ? `${Math.round(r.details.cashShare * 100)}%` : null) },
    { key: 'owns', group: 'ownership', label: 'Owns here', sortBy: 'owned_count', align: 'right', width: 84, render: (r) => compactCount(r.details?.ownedCount) },
    { key: 'sold', group: 'ownership', label: 'Sold', align: 'right', width: 64, render: (r) => compactCount(r.details?.soldCount) },
    { key: 'kind', group: 'people', label: 'Kind', width: 90, render: (r) => (r.details?.entityKind === 'person' ? 'Individual' : 'Company') },
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
    properties: ['value', 'equity', 'loans', 'balance', 'rate', 'liens', 'lastSale', 'owner', 'market'],
    buyers: ['purchases', 'status', 'market', 'last', 'year', 'median', 'owns'],
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
  buyers: null,
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

  { key: 'total_loan_balance', label: 'Loan balance', group: 'scores', width: 112, numeric: true },
  { key: 'assd_total_value', label: 'Assessed value', group: 'scores', width: 120, numeric: true },
  { key: 'sale_price', label: 'Last sale price', group: 'scores', width: 118, numeric: true },
  { key: 'sale_date', label: 'Last sale date', group: 'scores', width: 118 },
  { key: 'arv_estimate', label: 'ARV estimate', group: 'scores', width: 118, numeric: true },
  { key: 'rent_estimate', label: 'Rent estimate', group: 'scores', width: 118, numeric: true },
  { key: 'cap_rate', label: 'Cap rate', group: 'scores', width: 92, numeric: true },
  { key: 'ppsf', label: 'PPSF', group: 'scores', width: 84, numeric: true },
  { key: 'estimated_repair_cost', label: 'Repair estimate', group: 'scores', width: 126, numeric: true },
  { key: 'rehab_level', label: 'Rehab level', group: 'scores', width: 106 },
  /* cash_offer / structured_motivation_score / deal_strength_score /
     tag_distress_score / ai_score removed — see the note on the Score column
     above and domain/acquisition/legacy-acquisition-fields. */

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

/** Mirrors KEYSET_SORT_COLUMNS (entity-graph-property-sort.js): picker fields the server may sort. */
const SERVER_SORTABLE_FIELDS = new Set([
  'year_built', 'effective_year_built', 'total_bedrooms', 'total_baths', 'building_square_feet', 'lot_square_feet',
  'equity_amount', 'estimated_repair_cost', 'sale_date', 'sale_price', 'zoning', 'total_loan_balance', 'ownership_years',
])

function rawSortValue(key: string, numeric: boolean | undefined, result: EntitySearchResult): string | number | null {
  const raw = (result.details?.row ?? {})[key]
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (numeric) {
    const num = Number(raw)
    return Number.isFinite(num) ? num : null
  }
  return String(raw).toLowerCase()
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
      field: extra.key,
      // Asks the server for a whole-cohort sort; the server answers with
      // sort.sortApplied=false when no (column, property_id) index exists and
      // the table falls back to "sorted within loaded rows".
      sortBy: SERVER_SORTABLE_FIELDS.has(extra.key) ? extra.key : undefined,
      render: (r) => renderRawField(extra.key, extra.numeric, r),
      sortValue: (r) => rawSortValue(extra.key, extra.numeric, r),
    })
  }
  SCOPE_TABLE_COLUMNS.properties.push({
    key: 'property_id',
    label: 'Property ID',
    group: 'provenance',
    width: 130,
    render: (r) => text(r.entityId),
  })
}

/* ── Sorting the loaded rows ─────────────────────────────────────────── */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Comparable values for the hand-tuned columns whose rendered text does not
 * sort ("$1.2M", "12K", "2 · active"). Anything not listed sorts by its
 * rendered text.
 */
const HAND_SORT_VALUES: Partial<Record<EntityScope, Record<string, (r: EntitySearchResult) => string | number | null>>> = {
  properties: {
    value: (r) => num(r.details?.value),
    equity: (r) => num(r.details?.equity),
    ownerBuyer: (r) => num(r.details?.records?.ownerBuyer?.acquisitions),
    loans: (r) => (recordsCaptured(r) ? num(r.details?.records?.mortgageCount) : null),
    balance: (r) => num(r.details?.records?.mortgageBalance),
    rate: (r) => num(r.details?.records?.firstRate),
    liens: (r) => (recordsCaptured(r) ? num(r.details?.records?.lienCount) : null),
    lastSale: (r) => text(r.details?.records?.lastSaleDate),
    lastPrice: (r) => num(r.details?.records?.lastSalePrice),
    units: (r) => num(r.details?.units),
  },
  master_owners: {
    portfolio: (r) => num(r.linkedCounts.properties),
    portfolioValue: (r) => num(r.details?.portfolioValue),
    coverage: (r) => num(r.linkedCounts.contactCoverage),
    people: (r) => num(r.linkedCounts.prospects),
    contacts: (r) => num(r.linkedCounts.contacts),
    priority: (r) => num(r.score),
  },
  people: {
    properties: (r) => num(r.linkedCounts.properties),
    contacts: (r) => num(r.linkedCounts.contacts),
    contactScore: (r) => num(r.score),
  },
  buyers: {
    purchases: (r) => num(r.details?.acquisitions),
    last: (r) => text(r.details?.lastAcquisition),
    year: (r) => num(r.details?.trailing365),
    median: (r) => num(r.details?.priceP50),
    cash: (r) => num(r.details?.cashShare),
    owns: (r) => num(r.details?.ownedCount),
    sold: (r) => num(r.details?.soldCount),
  },
  contact_methods: {
    score: (r) => num(r.score),
  },
}

export function columnSortValue(scope: EntityScope, column: TableColumn, result: EntitySearchResult): string | number | null {
  if (column.sortValue) return column.sortValue(result)
  const hand = HAND_SORT_VALUES[scope]?.[column.key]
  if (hand) return hand(result)
  const rendered = column.render(result)
  return rendered ? rendered.toLowerCase() : null
}

export type HeaderSort = { key: string; dir: 'asc' | 'desc' }

/** Header click cycle: none → asc → desc → none. */
export function nextHeaderSort(current: HeaderSort | null, key: string): HeaderSort | null {
  if (!current || current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return null
}

/**
 * Sort the loaded rows by one column. Nulls (no value) always last, whatever
 * the direction; equal values keep their server order (stable tie-break).
 */
export function sortLoadedRows(
  scope: EntityScope,
  rows: readonly EntitySearchResult[],
  column: TableColumn,
  dir: 'asc' | 'desc',
): EntitySearchResult[] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, value: columnSortValue(scope, column, row) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index
      if (a.value === null) return 1
      if (b.value === null) return -1
      let cmp = 0
      if (typeof a.value === 'number' && typeof b.value === 'number') cmp = a.value - b.value
      else cmp = String(a.value).localeCompare(String(b.value), undefined, { numeric: true })
      return cmp !== 0 ? cmp * sign : a.index - b.index
    })
    .map((entry) => entry.row)
}

/** The enrichment fields the visible columns need (property scope only). */
export function visibleEnrichmentFields(scope: EntityScope, visible: readonly string[]): string[] {
  if (scope !== 'properties') return []
  const set = new Set(visible)
  return SCOPE_TABLE_COLUMNS.properties.filter((c) => c.field && set.has(c.key)).map((c) => c.field as string)
}
