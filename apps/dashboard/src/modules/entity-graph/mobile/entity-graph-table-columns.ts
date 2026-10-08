import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { humanBucket, propertySignals } from './property-signals'
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
  const amt = typeof d?.equityAmount === 'number' ? compactCurrency(d.equityAmount) : null
  if (d?.equityRule === 'free_and_clear') return amt ? `${amt} · free & clear` : 'Free & clear'
  if (d?.equityRule === 'no_recorded_mortgage') return amt ? `${amt} · 100%` : '100%'
  if (typeof d?.equity === 'number' && (d.equityRule === 'loan_and_value' || d.equityRule === 'recorded_mortgage_balance')) return amt ? `${amt} · ${Math.round(d.equity)}%` : `${Math.round(d.equity)}%`
  if (d?.equityRule === 'vendor_high_equity_flag') return 'High (flag)'
  if (d?.equityRule === 'vendor_low_equity_flag') return 'Low (flag)'
  return 'Unknown'
}

const recordsCaptured = (r: EntitySearchResult): boolean => Boolean(r.details?.records) && r.details?.records?.captured !== false

export type ColumnGroup =
  | 'overview' | 'outreach' | 'geography' | 'market' | 'property' | 'ownership' | 'owner'
  | 'people' | 'contacts' | 'signals' | 'scores' | 'engine' | 'provenance'

export const COLUMN_GROUP_LABELS: Record<ColumnGroup, string> = {
  overview: 'Overview',
  outreach: 'Outreach, pipeline & campaigns',
  geography: 'Geography',
  market: 'ZIP market (Market Intelligence)',
  property: 'Property',
  ownership: 'Ownership (on the property)',
  owner: 'Owner record (master owner)',
  people: 'People / entity',
  contacts: 'Contacts',
  signals: 'Debt, liens & sales',
  scores: 'Value & equity',
  engine: 'Decision Engine',
  provenance: 'Advanced / debug (ids, system)',
}

export const COLUMN_GROUP_ORDER: ColumnGroup[] = [
  'overview', 'outreach', 'geography', 'market', 'property', 'ownership', 'owner',
  'people', 'contacts', 'signals', 'scores', 'engine', 'provenance',
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
  /** Rendered from `details.outreach` (GET /entity-graph/outreach-state), loaded while visible. */
  outreach?: boolean
  /** Column-picker definition: where the value comes from, said plainly. */
  source?: string
  /** Rendered as colored signal badges on the desk (property-signals.ts). */
  signals?: boolean
  /** Extra enrichment fields a computed column reads from `details.row`. */
  fields?: string[]
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
const humanizeCode = (v: string | null | undefined): string | null => (v ? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null)
const outreachDay = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}
/** Plain words for the campaign readiness reasons (the same codes the builder writes). */
export const SMS_BLOCK_LABEL: Record<string, string> = {
  not_in_campaign_audience: 'Not in campaign audience',
  missing_phone: 'No phone',
  NO_PHONE: 'No phone',
  non_sms_capable: 'No SMS line',
  pending_prior_touch: 'Recently contacted',
  suppressed: 'Suppressed',
  suppression_blocked: 'Suppressed',
  wrong_number: 'Wrong number',
  active_queue_item: 'Already queued',
  routing_blocked: 'No sender coverage',
  graph_not_queue_eligible: 'Not queue-eligible',
  missing_identity_linkage: 'No person + phone',
  entity_contact_requires_review: 'Entity contact review',
  identity_not_verified: 'Identity not verified',
  missing_timezone: 'No time zone',
  ambiguous_phone_ownership: 'Shared phone',
}
export const smsBlockLabel = (code: string | null | undefined): string => (code ? SMS_BLOCK_LABEL[code] ?? humanizeCode(code) ?? code : '')

/**
 * OUTREACH COLUMNS (owner, 2026-10-08): last contact, stage, status and SMS
 * eligibility on every row — from /entity-graph/outreach-state, which answers
 * eligibility with the campaign target builder's own readiness rule.
 */
const OUTREACH_COLUMNS: TableColumn[] = [
  {
    key: 'smsEligible', group: 'outreach', label: 'SMS eligible', width: 230, outreach: true,
    source: 'Campaign target graph · the builder’s readiness rule',
    render: (r) => {
      const s = r.details?.outreach?.sms
      if (!s) return null
      if (s.eligible) return 'Yes'
      // a gap in the campaign graph is not "no phone" when linked prospects carry candidates
      const c = r.details?.outreach?.contactCandidates
      if (c && c.phones > 0) return `No · ${c.phones} phone ${c.phones === 1 ? 'candidate' : 'candidates'}, not in graph${c.unresolved ? ' · unresolved' : ''}`
      return `No · ${smsBlockLabel(s.reason)}`
    },
    sortValue: (r) => { const s = r.details?.outreach?.sms; return s ? (s.eligible ? 1 : 0) : null },
  },
  {
    key: 'lastContact', group: 'outreach', label: 'Last contact', width: 150, outreach: true,
    source: 'Inbox thread + campaign graph timestamps',
    render: (r) => {
      const c = r.details?.outreach?.lastContact
      return c ? `${outreachDay(c.at)} · ${c.direction === 'inbound' ? 'In' : 'Out'} · ${String(c.channel).toUpperCase()}` : null
    },
    sortValue: (r) => { const at = r.details?.outreach?.lastContact?.at; return at ? Date.parse(at) : null },
  },
  {
    key: 'stage', group: 'outreach', label: 'Stage', width: 130, outreach: true,
    source: 'Pipeline deal, else the conversation’s seller stage',
    render: (r) => { const st = r.details?.outreach?.stage; return st ? `${humanizeCode(st.value)}${st.source === 'conversation' ? ' · convo' : ''}` : null },
  },
  {
    key: 'status', group: 'outreach', label: 'Status', width: 120, outreach: true,
    source: 'Pipeline deal, else the conversation',
    render: (r) => { const st = r.details?.outreach?.status; return st ? `${humanizeCode(st.value)}${st.source === 'conversation' ? ' · convo' : ''}` : null },
  },
  {
    key: 'campaigns', group: 'outreach', label: 'Campaigns', width: 190, outreach: true,
    source: 'campaign_targets',
    render: (r) => {
      const c = r.details?.outreach?.campaigns
      if (!c || !c.count) return c ? 'None' : null
      const name = c.latest?.name ?? 'campaign'
      return c.count > 1 ? `${name} +${c.count - 1}` : name
    },
    sortValue: (r) => r.details?.outreach?.campaigns?.count ?? null,
  },
  {
    key: 'lastMessage', group: 'outreach', label: 'Last message', width: 240, outreach: true,
    source: 'Inbox thread (latest message)',
    render: (r) => r.details?.outreach?.conversation?.preview ?? null,
  },
]

export const SCOPE_TABLE_COLUMNS: Record<EntityScope, TableColumn[]> = {
  properties: [
    ...OUTREACH_COLUMNS,
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
      width: 128,
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
      /**
       * The owner as a BUYER elsewhere. Every owner "bought" their own property
       * once, so "1 · inactive" said nothing (owner, 2026-10-08): shown only for
       * a repeat buyer (2+ observed purchases) or one still buying.
       */
      key: 'ownerBuyer',
      group: 'ownership',
      label: 'Owner is a buyer',
      width: 140,
      render: (r) => {
        const b = r.details?.records?.ownerBuyer
        if (!b || !((b.acquisitions ?? 0) >= 2 || b.status === 'active')) return null
        return `${b.acquisitions ?? '—'} purchases${b.status ? ` · ${b.status}` : ''}`
      },
    },
    { key: 'loans', group: 'signals', label: 'Loans', sortBy: 'rec_mortgage_count', align: 'right', width: 62, render: (r) => (recordsCaptured(r) ? String(r.details!.records!.mortgageCount) : null) },
    { key: 'balance', group: 'scores', label: 'Balance', sortBy: 'rec_mortgage_balance', align: 'right', width: 88, render: (r) => compactCurrency(r.details?.records?.mortgageBalance) },
    { key: 'rate', group: 'signals', label: 'Rate', align: 'right', width: 64, render: (r) => (typeof r.details?.records?.firstRate === 'number' ? `${Number(r.details.records.firstRate).toFixed(2)}%` : null) },
    { key: 'lender', group: 'signals', label: 'Lender', width: 170, render: (r) => text(r.details?.records?.firstLender) },
    {
      // which liens, not just how many: recorded document categories + amount due
      key: 'liens', group: 'signals', label: 'Liens', sortBy: 'rec_lien_count', width: 200,
      render: (r) => {
        const rec = r.details?.records
        if (!recordsCaptured(r) || !rec) return null
        if (!rec.lienCount) return 'None recorded'
        const cats = (rec.lienCategories ?? []).map((c) => humanizeEnum(c) ?? c)
        return [cats.length ? cats.slice(0, 2).join(', ') + (cats.length > 2 ? ` +${cats.length - 2}` : '') : `${rec.lienCount} recorded`, typeof rec.lienAmountDue === 'number' && rec.lienAmountDue > 0 ? `${compactCurrency(rec.lienAmountDue)} due` : null].filter(Boolean).join(' · ')
      },
      sortValue: (r) => (recordsCaptured(r) ? r.details?.records?.lienCount ?? null : null),
    },
    {
      // one last-sale column (records first, the property's own sale fields as fallback): full date + price
      key: 'lastSale', group: 'signals', label: 'Last sale', sortBy: 'rec_last_sale_date', width: 190, fields: ['sale_date', 'sale_price'],
      render: (r) => {
        const rec = r.details?.records
        const row = r.details?.row ?? {}
        const date = text(rec?.lastSaleDate) ?? text(row.sale_date)
        const price = typeof rec?.lastSalePrice === 'number' ? rec.lastSalePrice : typeof row.sale_price === 'number' ? row.sale_price : null
        if (!date && price === null) return null
        const d = date ? new Date(`${date.slice(0, 10)}T12:00:00`) : null
        const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : date
        return [when, price !== null ? compactCurrency(price) : null, rec?.lastSaleDocType ?? null].filter(Boolean).join(' · ')
      },
      sortValue: (r) => text(r.details?.records?.lastSaleDate) ?? text((r.details?.row ?? {}).sale_date),
    },
    { key: 'units', group: 'property', label: 'Units', sortBy: 'units_count', align: 'right', width: 60, render: (r) => compactCount(r.details?.units) },
    { key: 'zip', group: 'geography', label: 'ZIP', width: 72, render: (r) => text(r.details?.zip) },
    {
      // ONE signal system (property-signals.ts): vendor flags + seller tags +
      // recorded signals, deduplicated, colored by meaning; facts are not badges
      key: 'flags', group: 'overview', label: 'Signals', width: 320,
      render: (r) => propertySignals(r).map((x) => x.label).join(' · ') || null,
      signals: true,
      sortValue: (r) => propertySignals(r).filter((x) => x.tone === 'distress').length || null,
    },
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
  { key: 'acquisition_bucket', label: 'Acquisition bucket', group: 'property', width: 160 },

  { key: 'total_loan_balance', label: 'Loan balance', group: 'scores', width: 112, numeric: true },
  { key: 'assd_total_value', label: 'Assessed value', group: 'scores', width: 120, numeric: true },
  { key: 'estimated_repair_cost', label: 'Repair est. (vendor · MLS lane)', group: 'scores', width: 170, numeric: true },
  { key: 'rehab_level', label: 'Rehab level', group: 'scores', width: 106 },
  /* cash_offer / structured_motivation_score / deal_strength_score /
     tag_distress_score / ai_score removed — see the note on the Score column
     above and domain/acquisition/legacy-acquisition-fields. */

  /* Linked entities (server: ENTITY_GRAPH_LINKED_COLUMNS). A field with several
     linked records shows the primary value; its count is its own column. */
  { key: 'contact.person', label: 'Contact person (primary)', group: 'contacts', width: 170 },
  { key: 'contact.person_count', label: 'People linked', group: 'contacts', width: 104, numeric: true },
  { key: 'contact.phone_count', label: 'Phones linked', group: 'contacts', width: 104, numeric: true },
  { key: 'contact.line_type', label: 'Best line type', group: 'contacts', width: 116 },
  { key: 'contact.phone_activity', label: 'Phone activity', group: 'contacts', width: 120 },
  { key: 'contact.phone_owner', label: 'Phone owner (vendor)', group: 'contacts', width: 150 },
  { key: 'contact.identity', label: 'Owner identity', group: 'contacts', width: 112 },
  { key: 'contact.matching', label: 'Matching tags', group: 'contacts', width: 170 },
  { key: 'email.count', label: 'Emails linked', group: 'contacts', width: 104, numeric: true },
  { key: 'entity.name', label: 'Title entity', group: 'people', width: 190 },
  { key: 'entity.count', label: 'Title entities', group: 'people', width: 100, numeric: true },

  { key: 'owner.display_name', label: 'Owner (master record)', group: 'owner', width: 180 },
  { key: 'owner.owner_type_guess', label: 'Owner type', group: 'owner', width: 160 },
  { key: 'owner.priority_tier', label: 'Owner tier', group: 'owner', width: 90 },
  { key: 'owner.property_count', label: 'Owner properties', group: 'owner', width: 118, numeric: true },
  { key: 'owner.portfolio_total_units', label: 'Owner units', group: 'owner', width: 100, numeric: true },
  { key: 'owner.portfolio_total_value', label: 'Portfolio value', group: 'owner', width: 120, numeric: true },
  { key: 'owner.portfolio_total_equity', label: 'Portfolio equity', group: 'owner', width: 124, numeric: true },
  { key: 'owner.portfolio_total_loan_balance', label: 'Portfolio debt', group: 'owner', width: 116, numeric: true },
  { key: 'owner.portfolio_total_tax_amount', label: 'Portfolio tax', group: 'owner', width: 110, numeric: true },
  { key: 'owner.tax_delinquent_count', label: 'Tax-delinquent props', group: 'owner', width: 144, numeric: true },
  { key: 'owner.active_lien_count', label: 'Props with liens', group: 'owner', width: 120, numeric: true },
  { key: 'owner.max_ownership_years', label: 'Longest held (yrs)', group: 'owner', width: 128, numeric: true },
  { key: 'owner.contactability_score', label: 'Contactability', group: 'owner', width: 112, numeric: true },
  { key: 'owner.financial_pressure_score', label: 'Financial pressure', group: 'owner', width: 132, numeric: true },
  { key: 'owner.urgency_score', label: 'Urgency', group: 'owner', width: 90, numeric: true },
  { key: 'owner.priority_score', label: 'Owner priority', group: 'owner', width: 112, numeric: true },
  { key: 'owner.best_language', label: 'Owner language', group: 'owner', width: 116 },
  { key: 'owner.best_channel', label: 'Best channel', group: 'owner', width: 106 },
  { key: 'owner.best_contact_window', label: 'Best contact window', group: 'owner', width: 140 },
  { key: 'owner.routing_timezone', label: 'Owner time zone', group: 'owner', width: 130 },
  { key: 'owner.routing_market', label: 'Routing market', group: 'owner', width: 140 },
  { key: 'owner.markets_text', label: 'Owner markets', group: 'owner', width: 180 },
  { key: 'owner.follow_up_cadence', label: 'Follow-up cadence', group: 'owner', width: 130 },
  { key: 'owner.seller_tags_text', label: 'Owner tags', group: 'owner', width: 200 },
  { key: 'owner.agent_persona', label: 'Agent persona', group: 'owner', width: 130 },
  { key: 'owner.primary_owner_address', label: 'Owner primary address', group: 'owner', width: 220 },

  { key: 'scores.aos_score', label: 'AOS score', group: 'engine', width: 90, numeric: true },
  { key: 'scores.decision_tier', label: 'Decision tier', group: 'engine', width: 106 },
  { key: 'scores.confidence', label: 'Engine confidence', group: 'engine', width: 128, numeric: true },
  { key: 'scores.best_strategy', label: 'Best strategy', group: 'engine', width: 130 },
  { key: 'scores.valuation_mid', label: 'Valuation (mid)', group: 'engine', width: 120, numeric: true },
  { key: 'scores.valuation_low', label: 'Valuation (low)', group: 'engine', width: 120, numeric: true },
  { key: 'scores.valuation_high', label: 'Valuation (high)', group: 'engine', width: 124, numeric: true },
  { key: 'scores.comp_count', label: 'Comps used', group: 'engine', width: 96, numeric: true },
  { key: 'scores.recommended_cash_offer', label: 'Recommended offer', group: 'engine', width: 136, numeric: true },
  { key: 'scores.minimum_acceptable_offer', label: 'Minimum offer', group: 'engine', width: 116, numeric: true },
  { key: 'scores.expected_assignment_fee', label: 'Assignment fee', group: 'engine', width: 120, numeric: true },
  { key: 'scores.buyer_demand_score', label: 'Buyer demand', group: 'engine', width: 110, numeric: true },
  { key: 'scores.liquidity_score', label: 'Liquidity', group: 'engine', width: 90, numeric: true },
  { key: 'scores.transaction_probability_90', label: 'Sale chance (90d)', group: 'engine', width: 130, numeric: true },
  { key: 'scores.transaction_probability_365', label: 'Sale chance (1y)', group: 'engine', width: 124, numeric: true },
  { key: 'scores.seller_financial_pressure_score', label: 'Seller pressure', group: 'engine', width: 120, numeric: true },
  { key: 'scores.foreclosure_risk_score', label: 'Foreclosure risk', group: 'engine', width: 124, numeric: true },
  { key: 'scores.owner_situation_primary', label: 'Owner situation', group: 'engine', width: 150 },
  { key: 'scores.recommended_conversation_angle', label: 'Conversation angle', group: 'engine', width: 200 },
  { key: 'scores.computed_at', label: 'Engine run', group: 'engine', width: 118 },

  /* field audit 2026-10-08: every public.properties column with data (≥1% of a 2% sample) */
  { key: 'original_property_type', label: 'Vendor property type', group: 'property', width: 150 },
  { key: 'asset_class', label: 'Asset class', group: 'property', width: 120 },
  { key: 'asset_subclass', label: 'Asset subclass', group: 'property', width: 160 },
  { key: 'style', label: 'Style', group: 'property', width: 110 },
  { key: 'county_land_use_code', label: 'Land use code', group: 'property', width: 110 },
  { key: 'construction_type', label: 'Construction', group: 'property', width: 120 },
  { key: 'exterior_walls', label: 'Exterior walls', group: 'property', width: 120 },
  { key: 'interior_walls', label: 'Interior walls', group: 'property', width: 120 },
  { key: 'floor_cover', label: 'Flooring', group: 'property', width: 110 },
  { key: 'roof_type', label: 'Roof type', group: 'property', width: 100 },
  { key: 'air_conditioning', label: 'Air conditioning', group: 'property', width: 120 },
  { key: 'heating_fuel_type', label: 'Heating fuel', group: 'property', width: 110 },
  { key: 'porch', label: 'Porch', group: 'property', width: 90 },
  { key: 'deck', label: 'Deck', group: 'property', width: 90 },
  { key: 'driveway', label: 'Driveway', group: 'property', width: 100 },
  { key: 'num_of_fireplaces', label: 'Fireplaces', group: 'property', width: 90, numeric: true },
  { key: 'sum_garage_sqft', label: 'Garage sqft', group: 'property', width: 100, numeric: true },
  { key: 'sum_buildings_nbr', label: 'Buildings', group: 'property', width: 90, numeric: true },
  { key: 'sum_commercial_units', label: 'Commercial units', group: 'property', width: 124, numeric: true },
  { key: 'avg_sqft_per_unit', label: 'Sqft per unit', group: 'property', width: 104, numeric: true },
  { key: 'beds_per_unit', label: 'Beds per unit', group: 'property', width: 104, numeric: true },
  { key: 'sqft_range', label: 'Sqft range', group: 'property', width: 104 },
  { key: 'lot_nbr', label: 'Lot number', group: 'property', width: 100 },
  { key: 'lot_size_depth_feet', label: 'Lot depth (ft)', group: 'property', width: 104, numeric: true },
  { key: 'lot_size_frontage_feet', label: 'Lot frontage (ft)', group: 'property', width: 120, numeric: true },
  { key: 'topography', label: 'Topography', group: 'property', width: 110 },
  { key: 'geographic_features', label: 'Geographic features', group: 'geography', width: 150 },
  { key: 'legal_description', label: 'Legal description', group: 'geography', width: 240 },
  { key: 'situs_census_tract', label: 'Census tract', group: 'geography', width: 110 },
  { key: 'property_address2', label: 'Address line 2', group: 'geography', width: 120 },
  { key: 'property_address_range', label: 'Address range', group: 'geography', width: 120 },
  { key: 'market_region', label: 'Market region', group: 'geography', width: 140 },
  { key: 'hoa1_name', label: 'HOA', group: 'property', width: 160 },
  { key: 'hoa1_type', label: 'HOA type', group: 'property', width: 100 },
  { key: 'hoa_fee_amount', label: 'HOA fee', group: 'scores', width: 90, numeric: true },
  { key: 'owner_1_name', label: 'Owner 1 (deed)', group: 'ownership', width: 170 },
  { key: 'owner_2_name', label: 'Owner 2 (deed)', group: 'ownership', width: 170 },
  { key: 'owner_type', label: 'Owner type (vendor)', group: 'ownership', width: 140 },
  { key: 'owner_location', label: 'Owner location', group: 'ownership', width: 130 },
  { key: 'market_status_label', label: 'Market status', group: 'signals', width: 120 },
  { key: 'equity_amount', label: 'Equity amount (vendor)', group: 'scores', width: 150, numeric: true },
  { key: 'total_loan_amt', label: 'Original loan amount', group: 'scores', width: 140, numeric: true },
  { key: 'total_loan_payment', label: 'Loan payment', group: 'scores', width: 110, numeric: true },
  { key: 'tax_amt', label: 'Property tax', group: 'scores', width: 104, numeric: true },
  { key: 'tax_year', label: 'Tax year', group: 'scores', width: 84 },
  { key: 'assd_land_value', label: 'Assessed land', group: 'scores', width: 116, numeric: true },
  { key: 'assd_improvement_value', label: 'Assessed improvements', group: 'scores', width: 150, numeric: true },
  { key: 'assd_year', label: 'Assessment year', group: 'scores', width: 120 },
  { key: 'calculated_total_value', label: 'Calculated value', group: 'scores', width: 124, numeric: true },
  { key: 'calculated_land_value', label: 'Calculated land', group: 'scores', width: 120, numeric: true },
  { key: 'calculated_improvement_value', label: 'Calculated improvements', group: 'scores', width: 160, numeric: true },
  { key: 'estimated_repair_cost_per_sqft', label: 'Repair $/sqft (vendor)', group: 'scores', width: 140, numeric: true },
  { key: 'last_sale_doc_type', label: 'Last sale document', group: 'signals', width: 150 },
  { key: 'deal_list_label', label: 'Deal list', group: 'provenance', width: 140 },
  { key: 'source_list_label', label: 'Source list', group: 'provenance', width: 140 },
  { key: 'source_list_category', label: 'Source list category', group: 'provenance', width: 150 },

  /* recorded documents (rec.*: seller.* records via v_entity_graph_properties) */
  { key: 'rec.mortgage_payment', label: 'Mortgage payment (rec.)', group: 'signals', width: 150, numeric: true },
  { key: 'rec.max_rate', label: 'Highest rate', group: 'signals', width: 100, numeric: true },
  { key: 'rec.first_loan_type', label: 'First loan type', group: 'signals', width: 120 },
  { key: 'rec.first_recording_date', label: 'First loan recorded', group: 'signals', width: 140 },
  { key: 'rec.first_due_date', label: 'First loan matures', group: 'signals', width: 140 },
  { key: 'rec.has_private_lender', label: 'Private lender', group: 'signals', width: 110 },
  { key: 'rec.has_heloc', label: 'HELOC', group: 'signals', width: 80 },
  { key: 'rec.has_fha', label: 'FHA loan', group: 'signals', width: 84 },
  { key: 'rec.has_va', label: 'VA loan', group: 'signals', width: 80 },
  { key: 'rec.has_seller_financing', label: 'Seller-financed', group: 'signals', width: 120 },
  { key: 'rec.has_adjustable', label: 'Adjustable rate', group: 'signals', width: 120 },
  { key: 'rec.lien_amount_due', label: 'Lien amount due', group: 'signals', width: 124, numeric: true },
  { key: 'rec.has_probate', label: 'Probate filing', group: 'signals', width: 110 },
  { key: 'rec.has_lis_pendens', label: 'Lis pendens', group: 'signals', width: 100 },
  { key: 'rec.has_death_record', label: 'Death record', group: 'signals', width: 104 },
  { key: 'rec.has_divorce_record', label: 'Divorce record', group: 'signals', width: 110 },
  { key: 'rec.has_judgment', label: 'Judgment', group: 'signals', width: 90 },
  { key: 'rec.has_mechanics_lien', label: "Mechanic's lien", group: 'signals', width: 120 },
  { key: 'rec.has_tax_lien', label: 'Tax lien', group: 'signals', width: 84 },
  { key: 'rec.has_hoa_lien', label: 'HOA lien', group: 'signals', width: 84 },
  { key: 'rec.has_default_notice', label: 'Notice of default', group: 'signals', width: 130 },
  { key: 'rec.sale_count', label: 'Recorded sales', group: 'signals', width: 110, numeric: true },
  { key: 'rec.last_sale_distress', label: 'Bought at trustee sale', group: 'signals', width: 150 },
  { key: 'rec.last_sale_intrafamily', label: 'Intrafamily transfer', group: 'signals', width: 140 },
  { key: 'rec.years_owned', label: 'Years since last sale', group: 'signals', width: 140, numeric: true },
  { key: 'rec.foreclosure_count', label: 'Foreclosure filings', group: 'signals', width: 130, numeric: true },
  { key: 'rec.foreclosure_stage', label: 'Foreclosure stage', group: 'signals', width: 130 },
  { key: 'rec.auction_date', label: 'Auction date', group: 'signals', width: 110 },

  /* the canonical person (person.*: campaign-graph person -> prospects by individual_key) */
  { key: 'person.age', label: 'Owner age', group: 'people', width: 90, numeric: true },
  { key: 'person.language_preference', label: 'Owner language', group: 'people', width: 120 },
  { key: 'person.gender', label: 'Gender', group: 'people', width: 90 },
  { key: 'person.marital_status', label: 'Marital status', group: 'people', width: 110 },
  { key: 'person.occupation_group', label: 'Occupation', group: 'people', width: 140 },
  { key: 'person.education_model', label: 'Education', group: 'people', width: 120 },
  { key: 'person.est_household_income', label: 'Household income', group: 'people', width: 130 },
  { key: 'person.net_asset_value', label: 'Net asset value', group: 'people', width: 120 },
  { key: 'person.buying_power', label: 'Buying power', group: 'people', width: 110 },
  { key: 'person.person_flags_text', label: 'Person flags', group: 'people', width: 200 },
  { key: 'person.matching_flags', label: 'Owner matching', group: 'people', width: 150 },
  { key: 'person.timezone', label: 'Owner time zone', group: 'people', width: 130 },
  { key: 'person.contact_window', label: 'Contact window', group: 'people', width: 120 },

  /* the property's ZIP market (zip.*: MI rollup of the current build + buyer index) */
  { key: 'zip.sales_1y', label: 'ZIP sales (1y)', group: 'market', width: 110, numeric: true },
  { key: 'zip.sales_90d', label: 'ZIP sales (90d)', group: 'market', width: 116, numeric: true },
  { key: 'zip.median_price', label: 'ZIP median price', group: 'market', width: 124, numeric: true },
  { key: 'zip.median_ppsf', label: 'ZIP median $/sqft', group: 'market', width: 130, numeric: true },
  { key: 'zip.investor_share', label: 'ZIP investor share %', group: 'market', width: 140, numeric: true },
  { key: 'zip.cash_share', label: 'ZIP cash share %', group: 'market', width: 124, numeric: true },
  { key: 'zip.latest_sale', label: 'ZIP latest sale', group: 'market', width: 120 },
  { key: 'zip.active_buyers', label: 'Active buyers in ZIP', group: 'market', width: 140, numeric: true },
  { key: 'zip.buyers', label: 'Buyers in ZIP (all)', group: 'market', width: 130, numeric: true },

  { key: 'property_export_id', label: 'Export id', group: 'provenance', width: 140 },
  { key: 'canonical_market_id', label: 'Canonical market id', group: 'provenance', width: 160 },
  { key: 'master_owner_id', label: 'Master owner ID', group: 'provenance', width: 190 },
  { key: 'source_system', label: 'Source system', group: 'provenance', width: 130 },
  { key: 'created_at', label: 'Created', group: 'provenance', width: 118 },
  { key: 'updated_at', label: 'Updated', group: 'provenance', width: 118 },
  { key: 'exported_at_utc', label: 'Exported', group: 'provenance', width: 118 },
]

/** ZIPs, years and ids must not be thousands-separated. */
const LITERAL_NUMERIC = /(^zip$|_zip$|year|_id$|apn|parcel|latitude|longitude|tract|lot_nbr|\.age$|count$|rate$)/i
const CURRENCY = /(value|price|amount|balance|offer|cost|estimate|equity|valuation|fee|debt|tax_amount|ppsf)/i

function renderRawField(key: string, numeric: boolean | undefined, result: EntitySearchResult): string | null {
  // a vendor repair figure the server judged implausible (repairTruth) is withheld, said so
  if (key === 'estimated_repair_cost' && (result.details?.row ?? {}).estimated_repair_cost_status === 'unreliable') return 'Unreliable'
  if (key === 'acquisition_bucket') return humanBucket((result.details?.row ?? {})[key])
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
  'equity_amount', 'zoning', 'total_loan_balance', 'ownership_years',
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
  return [...new Set(SCOPE_TABLE_COLUMNS.properties.filter((c) => (c.field || c.fields) && set.has(c.key)).flatMap((c) => [...(c.field ? [c.field] : []), ...(c.fields ?? [])]))]
}
