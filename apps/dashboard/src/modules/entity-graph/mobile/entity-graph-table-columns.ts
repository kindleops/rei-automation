import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { humanBucket, propertySignals } from './property-signals'
import { equityDisplay, signedMoney } from '../equity-display'
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
/** The equity cell under equity_known_v1 — the ONE rendering (equity-display.ts), same as the hover card + inspector. */
export function equityLabel(r: EntitySearchResult): string {
  const d = r.details
  return equityDisplay({ percent: d?.equity ?? null, amount: d?.equityAmount ?? null, rule: d?.equityRule ?? null }).text
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

/**
 * EVERY column declares its unit (owner, 2026-10-08: "BUILDING SQFT and LOT
 * SQFT render as DOLLAR amounts"). Root cause: the generic renderer guessed
 * currency from the column NAME with /…|fee|…/, and "square_FEEt" matched.
 * Formatting is now by declared unit only (formatUnit) — never by name.
 */
export type ColumnUnit =
  | 'currency' | 'currency_per_sqft' | 'count' | 'decimal' | 'sqft' | 'acres' | 'feet' | 'percent' | 'rate'
  | 'date' | 'year' | 'years' | 'score' | 'coordinate' | 'code' | 'id' | 'text' | 'list' | 'boolean'
  /** a hand-built cell (several facts in one, e.g. "$111M · 100%", "Mar 4, 2021 · $240K · Warranty deed") */
  | 'composite'
  | 'signals'

export const NUMERIC_UNITS: ReadonlySet<ColumnUnit> = new Set(['currency', 'currency_per_sqft', 'count', 'decimal', 'sqft', 'acres', 'feet', 'percent', 'rate', 'year', 'years', 'score', 'coordinate'])
const RIGHT_ALIGNED_UNITS: ReadonlySet<ColumnUnit> = new Set(['currency', 'currency_per_sqft', 'count', 'decimal', 'sqft', 'acres', 'feet', 'percent', 'rate', 'years', 'score'])

const finiteNum = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
const grouped = (n: number, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })

/** Format a raw source value by its declared unit. Absent → null ("—"), never 0. */
export function formatUnit(unit: ColumnUnit, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No'
  if (Array.isArray(raw)) { const items = raw.map((x) => text(x)).filter(Boolean); return items.length ? items.join(', ') : null }
  const s = String(raw).trim()
  if (!s || s === 'null') return null
  const n = finiteNum(raw)
  switch (unit) {
    case 'currency': return n === null ? s : signedMoney(n)
    case 'currency_per_sqft': return n === null ? s : `$${grouped(n)}/sqft`
    case 'count': return n === null ? s : grouped(Math.round(n))
    case 'decimal': return n === null ? s : grouped(n, 2)
    case 'sqft': return n === null ? s : `${grouped(Math.round(n))} sqft`
    case 'acres': return n === null ? s : `${grouped(n, n < 10 ? 2 : 1)} ac`
    case 'feet': return n === null ? s : `${grouped(n)} ft`
    case 'percent': return n === null ? s : `${grouped(n, Math.abs(n) < 10 && !Number.isInteger(n) ? 1 : 0)}%`
    // an interest rate of 0 is "not recorded", not a 0% loan
    case 'rate': return n === null ? s : n <= 0 ? null : `${n.toFixed(2)}%`
    case 'year': return /^\d{4}/.test(s) ? s.slice(0, 4) : s
    case 'years': return n === null ? s : `${grouped(n, 1)} yrs`
    case 'score': return n === null ? s : String(Math.round(n))
    case 'coordinate': return n === null ? s : n.toFixed(5)
    case 'date': {
      const t = Date.parse(s.length === 10 ? `${s}T12:00:00` : s)
      return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : s
    }
    case 'boolean': return ['true', 't', '1', 'yes', 'y'].includes(s.toLowerCase()) ? 'Yes' : ['false', 'f', '0', 'no', 'n'].includes(s.toLowerCase()) ? 'No' : s
    case 'list': return s.split(/\s*[;,|]\s*/).filter(Boolean).join(', ') || null
    default: return s
  }
}

export type TableColumn = {
  key: string
  label: string
  group: ColumnGroup
  /** What the value IS — drives formatting, alignment and the picker (required). */
  unit: ColumnUnit
  /** The source column exists but carries no data: listed in the picker as "no data", not offered. */
  noData?: boolean
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
    key: 'smsEligible', group: 'outreach', label: 'SMS eligible', width: 230, outreach: true, unit: 'composite',
    source: 'Campaign target graph · the builder’s readiness rule',
    render: (r) => {
      const s = r.details?.outreach?.sms
      if (!s) return null
      if (s.eligible) return 'Yes'
      // an entity contact whose role needs review is a CANDIDATE, never "no phone" (owner P0, 2026-10-09)
      const ec = r.details?.outreach?.entityContact
      if (ec && ec.requiresReview && (s.reason === 'entity_contact_requires_review' || ec.phoneMasked)) {
        return `No · entity contact needs review${ec.person ? ` · ${ec.person}` : ''}${ec.phoneMasked ? ` ${ec.phoneMasked}${ec.phoneCallable ? '' : ' (not callable)'}` : ''}`
      }
      // a gap in the campaign graph is not "no phone" when linked prospects carry candidates
      const c = r.details?.outreach?.contactCandidates
      if (c && c.phones > 0) return `No · ${c.phones} phone ${c.phones === 1 ? 'candidate' : 'candidates'}, not in graph${c.unresolved ? ' · unresolved' : ''}`
      return `No · ${smsBlockLabel(s.reason)}`
    },
    sortValue: (r) => { const s = r.details?.outreach?.sms; return s ? (s.eligible ? 1 : 0) : null },
  },
  {
    key: 'lastContact', group: 'outreach', label: 'Last contact', width: 150, outreach: true, unit: 'composite',
    source: 'Inbox thread + campaign graph timestamps',
    render: (r) => {
      const c = r.details?.outreach?.lastContact
      return c ? `${outreachDay(c.at)} · ${c.direction === 'inbound' ? 'In' : 'Out'} · ${String(c.channel).toUpperCase()}` : null
    },
    sortValue: (r) => { const at = r.details?.outreach?.lastContact?.at; return at ? Date.parse(at) : null },
  },
  /*
   * Pipeline vs conversation, apart (owner, 2026-10-08: "Status/Stage columns
   * mixing pipeline vs conversation values"). One column used to show the
   * deal's stage OR the conversation's seller stage with a " · convo" suffix.
   */
  {
    key: 'stage', group: 'outreach', label: 'Pipeline stage', width: 140, outreach: true, unit: 'text',
    source: 'Pipeline deal (acquisition_opportunities.acquisition_stage) — blank when there is no deal',
    render: (r) => { const o = r.details?.outreach; const v = o?.pipeline !== undefined ? o.pipeline?.stage : o?.stage?.source === 'pipeline' ? o.stage.value : null; return humanizeCode(v ?? null) },
  },
  {
    key: 'status', group: 'outreach', label: 'Pipeline status', width: 130, outreach: true, unit: 'text',
    source: 'Pipeline deal status — blank when there is no deal',
    render: (r) => { const o = r.details?.outreach; const v = o?.pipeline !== undefined ? o.pipeline?.status : o?.status?.source === 'pipeline' ? o.status.value : null; return humanizeCode(v ?? null) },
  },
  {
    key: 'convoStage', group: 'outreach', label: 'Conversation stage', width: 150, outreach: true, unit: 'text',
    source: 'Inbox thread seller stage',
    render: (r) => { const o = r.details?.outreach; const v = o?.conversationState !== undefined ? o.conversationState?.stage : o?.stage?.source === 'conversation' ? o.stage.value : null; return humanizeCode(v ?? null) },
  },
  {
    key: 'convoStatus', group: 'outreach', label: 'Conversation status', width: 150, outreach: true, unit: 'text',
    source: 'Inbox thread status',
    render: (r) => { const o = r.details?.outreach; const v = o?.conversationState !== undefined ? o.conversationState?.status : o?.status?.source === 'conversation' ? o.status.value : null; return humanizeCode(v ?? null) },
  },
  {
    key: 'campaigns', group: 'outreach', label: 'Campaigns', width: 190, outreach: true, unit: 'composite',
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
    key: 'lastMessage', group: 'outreach', label: 'Last message', width: 240, outreach: true, unit: 'text',
    source: 'Inbox thread (latest message)',
    render: (r) => r.details?.outreach?.conversation?.preview ?? null,
  },
]

const lienText = (r: EntitySearchResult): string | null => {
  const rec = r.details?.records
  if (!recordsCaptured(r) || !rec) return null
  // only lien / judgment classes are liens (entity-graph-recorded-docs.js); older APIs sent every category
  const labels = rec.liens ?? (rec.filings ? [] : null)
  if (labels === null) return rec.lienCount ? `${rec.lienCount} recorded documents` : 'None recorded'
  if (!labels.length) return 'None recorded'
  return [labels.join(', '), typeof rec.lienAmountDue === 'number' && rec.lienAmountDue > 0 ? `${signedMoney(rec.lienAmountDue)} due` : null].filter(Boolean).join(' · ')
}

export const SCOPE_TABLE_COLUMNS: Record<EntityScope, TableColumn[]> = {
  properties: [
    ...OUTREACH_COLUMNS,
    { key: 'market', group: 'geography', label: 'Market', sortBy: 'market', width: 132, unit: 'text', render: (r) => resolveMarket(r).label },
    { key: 'assetType', group: 'property', label: 'Type', width: 120, unit: 'text', render: (r) => text(r.details?.assetType) },
    { key: 'value', group: 'scores', label: 'Est. value', sortBy: 'estimated_value', align: 'right', width: 92, unit: 'currency', render: (r) => (typeof r.details?.value === 'number' ? signedMoney(r.details.value) : null) },
    {
      /**
       * equity_known_v1 (owner, 2026-10-07): the vendor equity_percent reads
       * 100% whenever no loan is on file. The server sends the evidence-based
       * value + amount + rule; ONE rendering (equity-display.ts) for grid,
       * hover card and inspector: "$X · Y%" (signed, so underwater reads
       * "−$42K · −11%"), "High (vendor flag)", or "Unknown". No server sort:
       * equity_percent orders the unknowns first, so the loaded rows are
       * sorted (known % first, unknown last).
       */
      key: 'equity', group: 'scores', label: 'Equity', align: 'right', width: 150, unit: 'composite',
      source: 'equityTruth: value − loan / recorded mortgage; vendor flag = class only',
      render: (r) => equityLabel(r),
      sortValue: (r) => (typeof r.details?.equity === 'number' ? r.details.equity : null),
    },
    /* §9 — no "Score" column: final_acquisition_score is a Podio-era output the Decision Engine never reads. */
    { key: 'owner', group: 'ownership', label: 'Owner (deed)', width: 170, unit: 'text', render: (r) => text(r.details?.ownerName), source: 'properties.owner_name' },
    {
      /**
       * The owner as a BUYER elsewhere. Every owner "bought" their own property
       * once, so "1 · inactive" said nothing (owner, 2026-10-08): shown only for
       * a repeat buyer (2+ observed purchases) or one still buying.
       */
      key: 'ownerBuyer', group: 'ownership', label: 'Owner is a buyer', width: 140, unit: 'composite',
      render: (r) => {
        const b = r.details?.records?.ownerBuyer
        if (!b || !((b.acquisitions ?? 0) >= 2 || b.status === 'active')) return null
        return `${b.acquisitions ?? '—'} purchases${b.status ? ` · ${b.status}` : ''}`
      },
    },
    { key: 'loans', group: 'signals', label: 'Open loans', sortBy: 'rec_mortgage_count', align: 'right', width: 84, unit: 'count', source: 'Recorded open mortgages (seller.property_mortgage)', render: (r) => (recordsCaptured(r) ? String(r.details!.records!.mortgageCount) : null) },
    { key: 'balance', group: 'scores', label: 'Loan balance (recorded)', sortBy: 'rec_mortgage_balance', align: 'right', width: 150, unit: 'currency', render: (r) => (typeof r.details?.records?.mortgageBalance === 'number' ? signedMoney(r.details.records.mortgageBalance) : null) },
    { key: 'rate', group: 'signals', label: 'First loan rate', align: 'right', width: 104, unit: 'rate', render: (r) => formatUnit('rate', r.details?.records?.firstRate) },
    { key: 'lender', group: 'signals', label: 'Lender', width: 170, unit: 'text', render: (r) => text(r.details?.records?.firstLender) },
    {
      // liens only (lien + judgment classes) — a UCC financing statement is not a lien (owner, 2026-10-08)
      key: 'liens', group: 'signals', label: 'Liens', width: 200, unit: 'composite',
      source: 'Recorded liens + judgments only; other recorded documents are “Recorded filings”',
      render: lienText,
      sortValue: (r) => (recordsCaptured(r) ? r.details?.records?.lienCount ?? null : null),
    },
    {
      key: 'filings', group: 'signals', label: 'Recorded filings', width: 220, unit: 'list',
      source: 'Every other recorded non-mortgage document: UCC financing statement, lis pendens, probate, affidavit of death, court order…',
      render: (r) => {
        const rec = r.details?.records
        if (!recordsCaptured(r) || !rec || !rec.filings) return null
        return rec.filings.length ? rec.filings.map((f) => f.label).join(', ') : 'None recorded'
      },
      sortValue: (r) => r.details?.records?.filings?.length ?? null,
    },
    {
      // one last-sale column (records first, the property's own sale fields as fallback): full date + price
      key: 'lastSale', group: 'signals', label: 'Last sale', sortBy: 'rec_last_sale_date', width: 190, unit: 'composite', fields: ['sale_date', 'sale_price'],
      render: (r) => {
        const rec = r.details?.records
        const row = r.details?.row ?? {}
        const date = text(rec?.lastSaleDate) ?? text(row.sale_date)
        const price = typeof rec?.lastSalePrice === 'number' ? rec.lastSalePrice : finiteNum(row.sale_price)
        if (!date && price === null) return null
        return [formatUnit('date', date), price !== null ? signedMoney(price) : null, rec?.lastSaleDocType ?? null].filter(Boolean).join(' · ')
      },
      sortValue: (r) => text(r.details?.records?.lastSaleDate) ?? text((r.details?.row ?? {}).sale_date),
    },
    { key: 'units', group: 'property', label: 'Units', sortBy: 'units_count', align: 'right', width: 60, unit: 'count', render: (r) => compactCount(r.details?.units) },
    { key: 'zip', group: 'geography', label: 'ZIP', width: 72, unit: 'code', render: (r) => text(r.details?.zip) },
    {
      // ONE signal system (property-signals.ts): vendor flags + seller tags +
      // recorded signals, deduplicated, colored by meaning, ALL of them listed
      key: 'flags', group: 'overview', label: 'Signals', width: 320, unit: 'signals',
      render: (r) => propertySignals(r).map((x) => x.label).join(' · ') || null,
      signals: true,
      sortValue: (r) => propertySignals(r).filter((x) => x.tone === 'distress').length || null,
    },
  ],
  master_owners: [
    { key: 'ownerType', group: 'ownership', label: 'Owner type', width: 150, unit: 'text', render: (r) => humanizeEnum(r.details?.ownerType) },
    { key: 'tier', group: 'ownership', label: 'Tier', width: 74, unit: 'code', render: (r) => humanizeEnum(r.details?.priorityTier) },
    { key: 'portfolio', group: 'ownership', label: 'Properties', sortBy: 'property_count', align: 'right', width: 90, unit: 'count', render: (r) => compactCount(r.linkedCounts.properties) },
    { key: 'portfolioValue', group: 'scores', label: 'Portfolio value', sortBy: 'portfolio_total_value', align: 'right', width: 120, unit: 'currency', render: (r) => compactCurrency(r.details?.portfolioValue) },
    {
      key: 'coverage', group: 'contacts', label: 'Contact coverage', align: 'right', width: 120, unit: 'percent',
      render: (r) => { const c = r.linkedCounts.contactCoverage; return typeof c === 'number' ? `${Math.min(100, Math.round(c))}%` : null },
    },
    { key: 'people', group: 'people', label: 'People', align: 'right', width: 70, unit: 'count', render: (r) => compactCount(r.linkedCounts.prospects) },
    { key: 'contacts', group: 'contacts', label: 'Contacts', align: 'right', width: 80, unit: 'count', render: (r) => compactCount(r.linkedCounts.contacts) },
    { key: 'priority', group: 'scores', label: 'Priority', sortBy: 'priority_score', align: 'right', width: 76, unit: 'score', render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null) },
  ],
  people: [
    { key: 'occupation', group: 'people', label: 'Occupation', width: 190, unit: 'text', render: (r) => text(r.details?.occupation) },
    { key: 'language', group: 'people', label: 'Language', width: 92, unit: 'text', render: (r) => text(r.details?.language) },
    { key: 'owner', group: 'ownership', label: 'Linked owner', width: 168, unit: 'text', render: (r) => text(r.details?.ownerName) },
    { key: 'properties', group: 'ownership', label: 'Properties', align: 'right', width: 90, unit: 'count', render: (r) => compactCount(r.linkedCounts.properties) },
    { key: 'contacts', group: 'contacts', label: 'Contacts', align: 'right', width: 84, unit: 'count', render: (r) => compactCount(r.linkedCounts.contacts) },
    { key: 'contactScore', group: 'contacts', label: 'Contact score', sortBy: 'contact_score_final', align: 'right', width: 108, unit: 'score', render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null) },
  ],
  buyers: [
    { key: 'purchases', group: 'overview', label: 'Purchases', sortBy: 'acquisition_count', align: 'right', width: 88, unit: 'count', render: (r) => compactCount(r.details?.acquisitions) },
    { key: 'status', group: 'overview', label: 'Activity', width: 88, unit: 'text', render: (r) => humanizeEnum(r.details?.activityStatus) },
    { key: 'market', group: 'geography', label: 'Primary market', width: 150, unit: 'text', render: (r) => text(r.details?.primaryMarket) },
    { key: 'archetype', group: 'signals', label: 'Archetype', width: 150, unit: 'text', render: (r) => text(r.details?.archetypeLabel) },
    { key: 'last', group: 'overview', label: 'Last buy', sortBy: 'last_acquisition', width: 96, unit: 'date', render: (r) => { const d = text(r.details?.lastAcquisition); return d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null } },
    { key: 'year', group: 'overview', label: 'Purchases (12 mo)', sortBy: 'trailing_365d', align: 'right', width: 120, unit: 'count', render: (r) => compactCount(r.details?.trailing365) },
    { key: 'median', group: 'scores', label: 'Median price', align: 'right', width: 100, unit: 'currency', render: (r) => compactCurrency(r.details?.priceP50) },
    { key: 'cash', group: 'scores', label: 'Cash share', align: 'right', width: 84, unit: 'percent', render: (r) => (typeof r.details?.cashShare === 'number' ? `${Math.round(r.details.cashShare * 100)}%` : null) },
    { key: 'owns', group: 'ownership', label: 'Owns here', sortBy: 'owned_count', align: 'right', width: 84, unit: 'count', render: (r) => compactCount(r.details?.ownedCount) },
    { key: 'sold', group: 'ownership', label: 'Sold', align: 'right', width: 64, unit: 'count', render: (r) => compactCount(r.details?.soldCount) },
    { key: 'kind', group: 'people', label: 'Kind', width: 90, unit: 'text', render: (r) => (r.details?.entityKind === 'person' ? 'Individual' : 'Company') },
  ],
  organizations: [
    { key: 'entityType', group: 'ownership', label: 'Entity type', width: 140, unit: 'text', render: (r) => text(r.details?.entityType) ?? text(r.subtitle) },
    { key: 'mailing', group: 'geography', label: 'Mailing address', width: 250, unit: 'text', render: (r) => text(r.details?.mailingAddress) },
  ],
  contact_methods: [
    { key: 'type', group: 'contacts', label: 'Line type', width: 96, unit: 'text', render: (r) => text(r.details?.phoneType) ?? text(r.details?.contactType) },
    { key: 'linked', group: 'people', label: 'Linked to', width: 190, unit: 'text', render: (r) => text(r.subtitle) },
    { key: 'eligibility', group: 'contacts', label: 'Status', width: 100, unit: 'text', render: (r) => text(r.details?.eligibility) },
    { key: 'reachability', group: 'contacts', label: 'Reachability', width: 110, unit: 'text', render: (r) => text(r.details?.reachability) },
    { key: 'score', group: 'scores', label: 'Score', sortBy: 'contact_score_final', align: 'right', width: 70, unit: 'score', render: (r) => (typeof r.score === 'number' ? String(Math.round(r.score)) : null) },
  ],
}

export function defaultVisibleColumns(scope: EntityScope): string[] {
  // A sensible first screen, not everything — the rest is one tap away in the
  // column picker, and the choice persists per scope.
  const all = SCOPE_TABLE_COLUMNS[scope].map((c) => c.key)
  const preferred: Partial<Record<EntityScope, string[]>> = {
    // no coordinates, ids or vendor repair figures on the first screen (owner, 2026-10-08)
    properties: ['assetType', 'value', 'equity', 'loans', 'balance', 'liens', 'filings', 'lastSale', 'owner', 'market'],
    buyers: ['purchases', 'status', 'market', 'last', 'year', 'median', 'owns'],
    master_owners: ['ownerType', 'tier', 'portfolio', 'portfolioValue', 'coverage'],
    people: ['owner', 'occupation', 'language', 'properties', 'contacts'],
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
type Extra = { key: string; label: string; group: ColumnGroup; width?: number; unit: ColumnUnit; source?: string; noData?: boolean; vendorEquity?: boolean }
const NO_DATA = 'No data in the source — 0% of properties carry it (field audit 2026-10-09); offered so its absence is visible, not hidden'
const SPARSE = (pct: string) => `Sparse in the source — about ${pct} of properties carry it (field audit 2026-10-08)`
const EXTRA_PROPERTY_COLUMNS: Extra[] = [
  { key: 'property_address_county_name', label: 'County', group: 'geography', width: 130, unit: 'text' },
  { key: 'subdivision_name', label: 'Subdivision', group: 'geography', width: 150, unit: 'text' },
  { key: 'school_district_name', label: 'School district', group: 'geography', width: 170, unit: 'text' },
  { key: 'flood_zone', label: 'Flood zone', group: 'geography', width: 100, unit: 'code' },
  { key: 'zoning', label: 'Zoning', group: 'geography', width: 96, unit: 'code' },
  { key: 'apn_parcel_id', label: 'APN / parcel', group: 'provenance', width: 140, unit: 'code' },
  // map coordinates: plumbing for the Map, not a reading column (owner: "LATITUDE shown as a column")
  { key: 'latitude', label: 'Latitude (map)', group: 'provenance', width: 104, unit: 'coordinate' },
  { key: 'longitude', label: 'Longitude (map)', group: 'provenance', width: 110, unit: 'coordinate' },

  { key: 'year_built', label: 'Year built', group: 'property', width: 92, unit: 'year' },
  { key: 'effective_year_built', label: 'Eff. year built', group: 'property', width: 110, unit: 'year' },
  { key: 'total_bedrooms', label: 'Beds', group: 'property', width: 64, unit: 'count' },
  { key: 'total_baths', label: 'Baths', group: 'property', width: 64, unit: 'decimal' },
  { key: 'building_square_feet', label: 'Building sqft', group: 'property', width: 120, unit: 'sqft' },
  { key: 'lot_acreage', label: 'Lot acres', group: 'property', width: 92, unit: 'acres' },
  { key: 'lot_square_feet', label: 'Lot sqft', group: 'property', width: 110, unit: 'sqft' },
  { key: 'building_condition', label: 'Condition', group: 'property', width: 110, unit: 'text' },
  { key: 'building_quality', label: 'Quality', group: 'property', width: 100, unit: 'text' },
  { key: 'garage', label: 'Garage', group: 'property', width: 96, unit: 'text' },
  { key: 'pool', label: 'Pool', group: 'property', width: 80, unit: 'text' },
  { key: 'basement', label: 'Basement', group: 'property', width: 96, unit: 'text' },
  { key: 'heating_type', label: 'Heating', group: 'property', width: 110, unit: 'text' },
  { key: 'roof_cover', label: 'Roof', group: 'property', width: 100, unit: 'text' },
  { key: 'sewer', label: 'Sewer', group: 'property', width: 90, unit: 'text' },
  { key: 'water', label: 'Water', group: 'property', width: 90, unit: 'text' },
  { key: 'property_class', label: 'Property class', group: 'property', width: 120, unit: 'text' },
  // the property's use type (owner: "PROPERTY USE TYPE is missing"): property_type is the populated
  // column (100%); property_use / property_use_code / land_use exist but are empty (0%)
  { key: 'property_type', label: 'Property use type', group: 'property', width: 140, unit: 'text', source: 'properties.property_type (Single Family, Multi-Family, Apartment, Vacant Land, Other) — the enriched label is the Type column' },
  { key: 'property_use', label: 'Property use (county)', group: 'property', width: 150, unit: 'text', noData: true, source: NO_DATA },
  { key: 'land_use', label: 'Land use', group: 'property', width: 110, unit: 'text', noData: true, source: NO_DATA },
  { key: 'patio', label: 'Patio', group: 'property', width: 120, unit: 'text', source: SPARSE('1%') },
  { key: 'stories', label: 'Stories', group: 'property', width: 80, unit: 'count', noData: true, source: NO_DATA },
  { key: 'other_rooms', label: 'Other rooms', group: 'property', width: 120, unit: 'text', noData: true, source: NO_DATA },

  { key: 'owner_name', label: 'Owner name (deed, raw)', group: 'ownership', width: 170, unit: 'text' },
  { key: 'owner_address_full', label: 'Owner mailing address', group: 'ownership', width: 210, unit: 'text' },
  { key: 'ownership_years', label: 'Years owned', group: 'ownership', width: 100, unit: 'years' },
  { key: 'is_corporate_owner', label: 'Corporate owner', group: 'ownership', width: 120, unit: 'boolean' },
  { key: 'out_of_state_owner', label: 'Out-of-state owner', group: 'ownership', width: 130, unit: 'boolean' },
  /* removed (field audit 2026-10-08): properties.best_phone / best_email /
     sms_eligible / contact_status / best_language / timezone / priority_tier —
     Podio-era copies on 4% of properties (contact_status only ever 'No
     Contact'), duplicating the live SMS eligible column and the person.* /
     owner.* / contact.* columns that read the real sources. */

  { key: 'tax_delinquent', label: 'Tax delinquent', group: 'signals', width: 116, unit: 'boolean' },
  { key: 'tax_delinquent_year', label: 'Tax delinquent since', group: 'signals', width: 140, unit: 'year' },
  { key: 'active_lien', label: 'Active lien (vendor flag)', group: 'signals', width: 160, unit: 'boolean', source: 'Vendor flag — the recorded documents are the Liens column' },
  { key: 'is_hot_preforeclosure', label: 'Hot pre-foreclosure', group: 'signals', width: 140, unit: 'boolean', source: SPARSE('4%') },
  { key: 'acquisition_bucket', label: 'Acquisition bucket', group: 'property', width: 160, unit: 'text', source: SPARSE('2%') },

  { key: 'total_loan_balance', label: 'Loan balance (vendor)', group: 'scores', width: 140, unit: 'currency' },
  { key: 'assd_total_value', label: 'Assessed value', group: 'scores', width: 120, unit: 'currency' },
  { key: 'rehab_level', label: 'Rehab level (vendor)', group: 'scores', width: 140, unit: 'text' },
  /* the vendor repair estimate and its $/sqft are NOT grid fields (valuation
     lanes, owner 2026-10-08): a flat $15/$35/$75 tier × sqft. A plausible
     SFR / 2–4 figure appears only in the inspector's MLS ARV lane reference. */

  /* Linked entities (server: ENTITY_GRAPH_LINKED_COLUMNS). A field with several
     linked records shows the primary value; its count is its own column. */
  { key: 'contact.person', label: 'Contact person (primary)', group: 'contacts', width: 170, unit: 'text', source: 'Campaign target graph, best phone row' },
  { key: 'contact.person_count', label: 'People linked', group: 'contacts', width: 104, unit: 'count' },
  { key: 'contact.phone_count', label: 'Phones linked', group: 'contacts', width: 104, unit: 'count' },
  { key: 'contact.line_type', label: 'Best line type', group: 'contacts', width: 116, unit: 'text' },
  { key: 'contact.phone_activity', label: 'Phone activity', group: 'contacts', width: 120, unit: 'text', source: SPARSE('28% of campaign-graph rows') },
  { key: 'contact.phone_owner', label: 'Phone owner (vendor)', group: 'contacts', width: 150, unit: 'text' },
  { key: 'contact.identity', label: 'Owner identity', group: 'contacts', width: 112, unit: 'text' },
  { key: 'contact.matching', label: 'Matching tags', group: 'contacts', width: 170, unit: 'list' },
  { key: 'email.count', label: 'Emails linked', group: 'contacts', width: 104, unit: 'count' },
  { key: 'entity.name', label: 'Title entity', group: 'people', width: 190, unit: 'text' },
  { key: 'entity.count', label: 'Title entities', group: 'people', width: 100, unit: 'count' },

  { key: 'owner.display_name', label: 'Owner (master record)', group: 'owner', width: 180, unit: 'text', source: 'Master owner — by properties.master_owner_id, else through the prospects linked to the property' },
  { key: 'owner.owner_type_guess', label: 'Owner type', group: 'owner', width: 160, unit: 'text' },
  { key: 'owner.priority_tier', label: 'Owner tier', group: 'owner', width: 90, unit: 'code' },
  { key: 'owner.property_count', label: 'Owner properties', group: 'owner', width: 118, unit: 'count' },
  { key: 'owner.portfolio_total_units', label: 'Owner units', group: 'owner', width: 100, unit: 'count' },
  { key: 'owner.portfolio_total_value', label: 'Portfolio value', group: 'owner', width: 120, unit: 'currency' },
  /* owner.portfolio_total_equity removed: it sums the vendor equity, which is
     the whole value for every property with no loan on file (equity_known_v1). */
  { key: 'owner.portfolio_total_loan_balance', label: 'Portfolio debt', group: 'owner', width: 116, unit: 'currency' },
  { key: 'owner.portfolio_total_tax_amount', label: 'Portfolio tax (annual)', group: 'owner', width: 150, unit: 'currency' },
  { key: 'owner.tax_delinquent_count', label: 'Tax-delinquent props', group: 'owner', width: 144, unit: 'count' },
  { key: 'owner.active_lien_count', label: 'Props with a vendor lien flag', group: 'owner', width: 180, unit: 'count' },
  { key: 'owner.max_ownership_years', label: 'Longest held', group: 'owner', width: 110, unit: 'years' },
  { key: 'owner.contactability_score', label: 'Contactability', group: 'owner', width: 112, unit: 'score' },
  { key: 'owner.financial_pressure_score', label: 'Financial pressure', group: 'owner', width: 132, unit: 'score' },
  { key: 'owner.urgency_score', label: 'Urgency', group: 'owner', width: 90, unit: 'score' },
  { key: 'owner.priority_score', label: 'Owner priority', group: 'owner', width: 112, unit: 'score' },
  { key: 'owner.best_language', label: 'Owner language', group: 'owner', width: 116, unit: 'text' },
  { key: 'owner.best_channel', label: 'Best channel', group: 'owner', width: 106, unit: 'text' },
  { key: 'owner.best_contact_window', label: 'Best contact window', group: 'owner', width: 140, unit: 'text' },
  { key: 'owner.routing_timezone', label: 'Owner time zone', group: 'owner', width: 130, unit: 'text' },
  { key: 'owner.routing_market', label: 'Routing market', group: 'owner', width: 140, unit: 'text' },
  { key: 'owner.markets_text', label: 'Owner markets', group: 'owner', width: 180, unit: 'list' },
  { key: 'owner.follow_up_cadence', label: 'Follow-up cadence', group: 'owner', width: 130, unit: 'text' },
  { key: 'owner.seller_tags_text', label: 'Owner tags', group: 'owner', width: 200, unit: 'list' },
  { key: 'owner.agent_persona', label: 'Agent persona', group: 'owner', width: 130, unit: 'text' },
  { key: 'owner.primary_owner_address', label: 'Owner primary address', group: 'owner', width: 220, unit: 'text' },

  { key: 'scores.aos_score', label: 'AOS score', group: 'engine', width: 90, unit: 'score' },
  { key: 'scores.decision_tier', label: 'Decision tier', group: 'engine', width: 106, unit: 'code' },
  { key: 'scores.confidence', label: 'Engine confidence', group: 'engine', width: 128, unit: 'percent' },
  { key: 'scores.best_strategy', label: 'Best strategy', group: 'engine', width: 130, unit: 'text' },
  { key: 'scores.valuation_mid', label: 'Valuation (mid)', group: 'engine', width: 120, unit: 'currency' },
  { key: 'scores.valuation_low', label: 'Valuation (low)', group: 'engine', width: 120, unit: 'currency' },
  { key: 'scores.valuation_high', label: 'Valuation (high)', group: 'engine', width: 124, unit: 'currency' },
  { key: 'scores.comp_count', label: 'Comps used', group: 'engine', width: 96, unit: 'count' },
  { key: 'scores.recommended_cash_offer', label: 'Recommended offer (engine)', group: 'engine', width: 170, unit: 'currency', source: 'Decision Engine V2 — its ceiling subtracts the vendor repair estimate (owner decision pending)' },
  { key: 'scores.minimum_acceptable_offer', label: 'Minimum offer (engine)', group: 'engine', width: 150, unit: 'currency', source: 'Decision Engine V2 — its ceiling subtracts the vendor repair estimate (owner decision pending)' },
  { key: 'scores.expected_assignment_fee', label: 'Assignment fee', group: 'engine', width: 120, unit: 'currency' },
  { key: 'scores.buyer_demand_score', label: 'Buyer demand', group: 'engine', width: 110, unit: 'score' },
  { key: 'scores.liquidity_score', label: 'Liquidity', group: 'engine', width: 90, unit: 'score' },
  { key: 'scores.transaction_probability_90', label: 'Sale chance (90d)', group: 'engine', width: 130, unit: 'percent' },
  { key: 'scores.transaction_probability_365', label: 'Sale chance (1y)', group: 'engine', width: 124, unit: 'percent' },
  { key: 'scores.seller_financial_pressure_score', label: 'Seller pressure', group: 'engine', width: 120, unit: 'score' },
  { key: 'scores.foreclosure_risk_score', label: 'Foreclosure risk', group: 'engine', width: 124, unit: 'score' },
  { key: 'scores.owner_situation_primary', label: 'Owner situation', group: 'engine', width: 150, unit: 'text' },
  { key: 'scores.recommended_conversation_angle', label: 'Conversation angle', group: 'engine', width: 200, unit: 'text' },
  { key: 'scores.computed_at', label: 'Engine run', group: 'engine', width: 118, unit: 'date' },

  /* field audit 2026-10-08: every public.properties column with data (≥1% of a 2% sample) */
  { key: 'asset_class', label: 'Asset class', group: 'property', width: 120, unit: 'text', source: SPARSE('4%') },
  { key: 'asset_subclass', label: 'Asset subclass', group: 'property', width: 160, unit: 'text', source: SPARSE('4%') },
  { key: 'style', label: 'Style', group: 'property', width: 110, unit: 'text' },
  { key: 'county_land_use_code', label: 'Land use code', group: 'property', width: 110, unit: 'code' },
  { key: 'construction_type', label: 'Construction', group: 'property', width: 120, unit: 'text' },
  { key: 'exterior_walls', label: 'Exterior walls', group: 'property', width: 120, unit: 'text' },
  { key: 'interior_walls', label: 'Interior walls', group: 'property', width: 120, unit: 'text' },
  { key: 'floor_cover', label: 'Flooring', group: 'property', width: 110, unit: 'text' },
  { key: 'roof_type', label: 'Roof type', group: 'property', width: 100, unit: 'text' },
  { key: 'air_conditioning', label: 'Air conditioning', group: 'property', width: 120, unit: 'text' },
  { key: 'heating_fuel_type', label: 'Heating fuel', group: 'property', width: 110, unit: 'text' },
  { key: 'porch', label: 'Porch', group: 'property', width: 90, unit: 'text', source: SPARSE('3.5%') },
  { key: 'deck', label: 'Deck', group: 'property', width: 90, unit: 'text' },
  { key: 'driveway', label: 'Driveway', group: 'property', width: 100, unit: 'text', source: SPARSE('2%') },
  { key: 'num_of_fireplaces', label: 'Fireplaces', group: 'property', width: 90, unit: 'count' },
  { key: 'sum_garage_sqft', label: 'Garage sqft', group: 'property', width: 110, unit: 'sqft' },
  { key: 'sum_buildings_nbr', label: 'Buildings', group: 'property', width: 90, unit: 'count' },
  { key: 'sum_commercial_units', label: 'Commercial units', group: 'property', width: 124, unit: 'count', source: SPARSE('2%') },
  { key: 'lot_nbr', label: 'Lot number', group: 'property', width: 100, unit: 'code' },
  { key: 'lot_size_depth_feet', label: 'Lot depth', group: 'property', width: 96, unit: 'feet' },
  { key: 'lot_size_frontage_feet', label: 'Lot frontage', group: 'property', width: 104, unit: 'feet' },
  { key: 'topography', label: 'Topography', group: 'property', width: 110, unit: 'text' },
  { key: 'geographic_features', label: 'Geographic features', group: 'geography', width: 150, unit: 'text' },
  { key: 'legal_description', label: 'Legal description', group: 'geography', width: 240, unit: 'text' },
  { key: 'situs_census_tract', label: 'Census tract', group: 'geography', width: 110, unit: 'code' },
  { key: 'property_address2', label: 'Address line 2', group: 'geography', width: 120, unit: 'text', source: SPARSE('3.6%') },
  { key: 'property_address_range', label: 'Address range', group: 'geography', width: 120, unit: 'text' },
  { key: 'market_region', label: 'Market region', group: 'geography', width: 140, unit: 'text', source: SPARSE('4%') },
  { key: 'hoa1_name', label: 'HOA', group: 'property', width: 160, unit: 'text' },
  { key: 'hoa1_type', label: 'HOA type', group: 'property', width: 100, unit: 'text' },
  { key: 'hoa_fee_amount', label: 'HOA fee', group: 'scores', width: 90, unit: 'currency' },
  { key: 'owner_1_name', label: 'Owner 1 (deed)', group: 'ownership', width: 170, unit: 'text' },
  { key: 'owner_2_name', label: 'Owner 2 (deed)', group: 'ownership', width: 170, unit: 'text' },
  { key: 'owner_type', label: 'Owner type (vendor)', group: 'ownership', width: 140, unit: 'text' },
  { key: 'owner_location', label: 'Owner location', group: 'ownership', width: 130, unit: 'text' },
  { key: 'market_status_label', label: 'Market status', group: 'signals', width: 120, unit: 'text' },
  /* equity_amount (vendor) removed: it is the whole value whenever no loan is
     on file — the Equity column is the evidence-based figure (equity_known_v1). */
  { key: 'sale_date', label: 'Sale date (vendor)', group: 'signals', width: 120, unit: 'date', source: 'properties.sale_date — the Last sale column reads the recorded sale first' },
  { key: 'sale_price', label: 'Sale price (vendor)', group: 'signals', width: 120, unit: 'currency', source: 'properties.sale_price — the Last sale column reads the recorded sale first' },
  // vendor equity: shown only where the evidence (equityTruth) makes equity known — it is value − loan
  // (100% consistent on a 5,207-row slice) but reads 100% whenever no loan is on file
  { key: 'equity_amount', label: 'Equity $ (vendor)', group: 'scores', width: 120, unit: 'currency', vendorEquity: true, source: 'properties.equity_amount = value − vendor loan; shown only when loan or recorded-mortgage evidence exists' },
  { key: 'equity_percent', label: 'Equity % (vendor)', group: 'scores', width: 120, unit: 'percent', vendorEquity: true, source: 'properties.equity_percent; shown only when loan or recorded-mortgage evidence exists' },
  { key: 'total_loan_amt', label: 'Original loan amount', group: 'scores', width: 140, unit: 'currency' },
  { key: 'total_loan_payment', label: 'Loan payment (monthly)', group: 'scores', width: 150, unit: 'currency' },
  { key: 'tax_amt', label: 'Property tax (annual)', group: 'scores', width: 140, unit: 'currency' },
  { key: 'tax_year', label: 'Tax year', group: 'scores', width: 84, unit: 'year' },
  { key: 'assd_land_value', label: 'Assessed land', group: 'scores', width: 116, unit: 'currency' },
  { key: 'assd_improvement_value', label: 'Assessed improvements', group: 'scores', width: 150, unit: 'currency' },
  { key: 'assd_year', label: 'Assessment year', group: 'scores', width: 120, unit: 'year' },
  { key: 'calculated_total_value', label: 'Calculated value', group: 'scores', width: 124, unit: 'currency' },
  { key: 'calculated_land_value', label: 'Calculated land', group: 'scores', width: 120, unit: 'currency' },
  { key: 'calculated_improvement_value', label: 'Calculated improvements', group: 'scores', width: 160, unit: 'currency' },
  { key: 'last_sale_doc_type', label: 'Last sale document', group: 'signals', width: 150, unit: 'text' },
  { key: 'deal_list_label', label: 'Deal list', group: 'provenance', width: 140, unit: 'text', source: SPARSE('2%') },
  { key: 'source_list_label', label: 'Source list', group: 'provenance', width: 140, unit: 'text', source: SPARSE('2%') },
  { key: 'source_list_category', label: 'Source list category', group: 'provenance', width: 150, unit: 'text', source: SPARSE('2%') },

  /* recorded documents (rec.*: seller.* records via v_entity_graph_properties) */
  { key: 'rec.mortgage_payment', label: 'Mortgage payment (recorded)', group: 'signals', width: 180, unit: 'currency' },
  { key: 'rec.max_rate', label: 'Highest loan rate', group: 'signals', width: 120, unit: 'rate' },
  { key: 'rec.first_loan_type', label: 'First loan type', group: 'signals', width: 120, unit: 'text' },
  { key: 'rec.first_recording_date', label: 'First loan recorded', group: 'signals', width: 140, unit: 'date' },
  { key: 'rec.first_due_date', label: 'First loan matures', group: 'signals', width: 140, unit: 'date' },
  { key: 'rec.has_private_lender', label: 'Private lender', group: 'signals', width: 110, unit: 'boolean' },
  { key: 'rec.has_heloc', label: 'HELOC', group: 'signals', width: 80, unit: 'boolean' },
  { key: 'rec.has_fha', label: 'FHA loan', group: 'signals', width: 84, unit: 'boolean' },
  { key: 'rec.has_va', label: 'VA loan', group: 'signals', width: 80, unit: 'boolean' },
  { key: 'rec.has_seller_financing', label: 'Seller-financed', group: 'signals', width: 120, unit: 'boolean' },
  { key: 'rec.has_adjustable', label: 'Adjustable rate', group: 'signals', width: 120, unit: 'boolean' },
  { key: 'rec.lien_amount_due', label: 'Amount due · all recorded documents', group: 'signals', width: 220, unit: 'currency', source: 'Sums every recorded non-mortgage document (liens, but also agreements, orders…) — not a lien total' },
  { key: 'rec.has_probate', label: 'Probate filing', group: 'signals', width: 110, unit: 'boolean' },
  { key: 'rec.has_lis_pendens', label: 'Lis pendens', group: 'signals', width: 100, unit: 'boolean' },
  { key: 'rec.has_death_record', label: 'Death record', group: 'signals', width: 104, unit: 'boolean' },
  { key: 'rec.has_divorce_record', label: 'Divorce record', group: 'signals', width: 110, unit: 'boolean' },
  { key: 'rec.has_judgment', label: 'Judgment', group: 'signals', width: 90, unit: 'boolean' },
  { key: 'rec.has_mechanics_lien', label: "Mechanic's lien", group: 'signals', width: 120, unit: 'boolean' },
  { key: 'rec.has_tax_lien', label: 'Tax lien', group: 'signals', width: 84, unit: 'boolean' },
  { key: 'rec.has_hoa_lien', label: 'HOA lien', group: 'signals', width: 84, unit: 'boolean' },
  { key: 'rec.has_default_notice', label: 'Notice of default', group: 'signals', width: 130, unit: 'boolean' },
  { key: 'rec.sale_count', label: 'Recorded sales', group: 'signals', width: 110, unit: 'count' },
  { key: 'rec.last_sale_distress', label: 'Bought at trustee sale', group: 'signals', width: 150, unit: 'boolean' },
  { key: 'rec.last_sale_intrafamily', label: 'Intrafamily transfer', group: 'signals', width: 140, unit: 'boolean' },
  { key: 'rec.years_owned', label: 'Years since last sale', group: 'signals', width: 140, unit: 'years' },
  { key: 'rec.foreclosure_count', label: 'Foreclosure filings', group: 'signals', width: 130, unit: 'count' },
  { key: 'rec.foreclosure_stage', label: 'Foreclosure stage', group: 'signals', width: 130, unit: 'text' },
  { key: 'rec.auction_date', label: 'Auction date', group: 'signals', width: 110, unit: 'date' },

  /* the person (person.*: campaign-graph person, else the property's own linked prospect) */
  { key: 'person.age', label: 'Owner age', group: 'people', width: 90, unit: 'count' },
  { key: 'person.language_preference', label: 'Person language', group: 'people', width: 120, unit: 'text' },
  { key: 'person.gender', label: 'Gender', group: 'people', width: 90, unit: 'text' },
  { key: 'person.marital_status', label: 'Marital status', group: 'people', width: 110, unit: 'text' },
  { key: 'person.occupation_group', label: 'Occupation', group: 'people', width: 140, unit: 'text' },
  { key: 'person.education_model', label: 'Education', group: 'people', width: 140, unit: 'text' },
  { key: 'person.est_household_income', label: 'Household income (range)', group: 'people', width: 160, unit: 'text' },
  { key: 'person.net_asset_value', label: 'Net asset value (range)', group: 'people', width: 150, unit: 'text' },
  { key: 'person.buying_power', label: 'Buying power', group: 'people', width: 150, unit: 'text' },
  { key: 'person.person_flags_text', label: 'Person flags', group: 'people', width: 200, unit: 'list' },
  { key: 'person.matching_flags', label: 'Owner matching', group: 'people', width: 150, unit: 'list' },
  { key: 'person.timezone', label: 'Person time zone', group: 'people', width: 130, unit: 'text' },
  { key: 'person.contact_window', label: 'Contact window', group: 'people', width: 120, unit: 'text' },

  /* the property's ZIP market (zip.*: MI rollup of the current build + buyer index) */
  { key: 'zip.sales_1y', label: 'ZIP sales (1y)', group: 'market', width: 110, unit: 'count' },
  { key: 'zip.sales_90d', label: 'ZIP sales (90d)', group: 'market', width: 116, unit: 'count' },
  { key: 'zip.median_price', label: 'ZIP median price', group: 'market', width: 124, unit: 'currency' },
  { key: 'zip.median_ppsf', label: 'ZIP median $/sqft', group: 'market', width: 130, unit: 'currency_per_sqft' },
  { key: 'zip.investor_share', label: 'ZIP investor share', group: 'market', width: 130, unit: 'percent' },
  { key: 'zip.cash_share', label: 'ZIP cash share', group: 'market', width: 116, unit: 'percent' },
  { key: 'zip.latest_sale', label: 'ZIP latest sale', group: 'market', width: 120, unit: 'date' },
  { key: 'zip.active_buyers', label: 'Active buyers in ZIP', group: 'market', width: 140, unit: 'count' },
  { key: 'zip.buyers', label: 'Buyers in ZIP (all)', group: 'market', width: 130, unit: 'count' },

  { key: 'property_export_id', label: 'Export id', group: 'provenance', width: 140, unit: 'id' },
  { key: 'canonical_market_id', label: 'Canonical market id', group: 'provenance', width: 160, unit: 'id' },
  { key: 'master_owner_id', label: 'Master owner ID', group: 'provenance', width: 190, unit: 'id' },
  { key: 'source_system', label: 'Source system', group: 'provenance', width: 130, unit: 'code' },
  { key: 'created_at', label: 'Created', group: 'provenance', width: 118, unit: 'date' },
  { key: 'updated_at', label: 'Updated', group: 'provenance', width: 118, unit: 'date' },
  { key: 'exported_at_utc', label: 'Exported', group: 'provenance', width: 118, unit: 'date' },
]

// recorded_mortgage_balance is excluded: there the vendor loan is 0 and its equity reads the whole value
const KNOWN_EQUITY_RULES = new Set(['loan_and_value', 'free_and_clear', 'no_recorded_mortgage'])

function renderRawField(key: string, unit: ColumnUnit, result: EntitySearchResult, extra?: Extra): string | null {
  if (key === 'acquisition_bucket') return humanBucket((result.details?.row ?? {})[key])
  // never a fabricated vendor 100%: the vendor figure only where evidence makes equity known
  if (extra?.vendorEquity && !KNOWN_EQUITY_RULES.has(String(result.details?.equityRule ?? ''))) return (result.details?.row ?? {})[key] === undefined ? null : 'Unverified · no loan data'
  return formatUnit(unit, (result.details?.row ?? {})[key])
}

/** Mirrors KEYSET_SORT_COLUMNS (entity-graph-property-sort.js): picker fields the server may sort. */
const SERVER_SORTABLE_FIELDS = new Set([
  'year_built', 'effective_year_built', 'total_bedrooms', 'total_baths', 'building_square_feet', 'lot_square_feet',
  'zoning', 'total_loan_balance', 'ownership_years', 'sale_date', 'sale_price',
])

function rawSortValue(key: string, unit: ColumnUnit, result: EntitySearchResult): string | number | null {
  const raw = (result.details?.row ?? {})[key]
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (NUMERIC_UNITS.has(unit)) {
    const num = Number(raw)
    return Number.isFinite(num) ? num : null
  }
  if (unit === 'date') { const t = Date.parse(String(raw)); return Number.isFinite(t) ? t : null }
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
      unit: extra.unit,
      width: extra.width ?? 120,
      align: RIGHT_ALIGNED_UNITS.has(extra.unit) ? 'right' : undefined,
      field: extra.key,
      source: extra.source,
      // Asks the server for a whole-cohort sort; the server answers with
      // sort.sortApplied=false when no (column, property_id) index exists and
      // the table falls back to "sorted within loaded rows".
      sortBy: SERVER_SORTABLE_FIELDS.has(extra.key) ? extra.key : undefined,
      noData: extra.noData,
      render: (r) => renderRawField(extra.key, extra.unit, r, extra),
      sortValue: (r) => rawSortValue(extra.key, extra.unit, r),
    })
  }
  SCOPE_TABLE_COLUMNS.properties.push({
    key: 'property_id',
    label: 'Property ID',
    group: 'provenance',
    unit: 'id',
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
