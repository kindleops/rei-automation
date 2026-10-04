/**
 * PIPELINE TABLE · COLUMN CATALOG — every field a deal row can show.
 *
 * Three sources, cheapest first:
 *   card      the feed row (DeskCard) — already loaded, free
 *   ext       DeskCard.ext — columns the feed's own reads already selected
 *             (acquisition_opportunities scope columns + inbox_thread_state),
 *             returned at no extra query
 *   enrich    property / owner / engine-score fields, fetched ONLY while a
 *             column that needs them is visible, by keyed `in (...)` reads for
 *             the deals in view (/api/cockpit/pipeline/command/columns)
 * plus `offer`: the Offers read the rail already loads (one truth, no read).
 *
 * Honesty: a value the source does not have is null and renders "—" (or
 * "Unknown" for an identity fact like language or phone type). Nothing is
 * defaulted to 0. Enumerations render the canonical word, de-underscored.
 *
 * Sorting: every sortable column sorts the deals LOADED in the table (the feed
 * pages up to its cap). The table says so when not every deal is loaded.
 */
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskCard, DeskOfferRow } from './pipeline-desk-api'
import { HOLD_META, relShort, stampCT } from './pipeline-desk-model'

export type ColumnGroup = 'deal' | 'conversation' | 'automation' | 'property' | 'seller' | 'scores'
export const COLUMN_GROUPS: ReadonlyArray<{ id: ColumnGroup; label: string }> = [
  { id: 'deal', label: 'Deal' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'automation', label: 'Automation' },
  { id: 'property', label: 'Property' },
  { id: 'seller', label: 'Seller' },
  { id: 'scores', label: 'Scores & engine' },
]

export type EnrichSource = 'property' | 'owner' | 'scores'
export type RowEnrichment = Partial<Record<EnrichSource, Record<string, unknown> | null>>

/** Everything a cell can read for one deal. */
export interface RowContext {
  card: DeskCard
  x: RowEnrichment
  offer: DeskOfferRow | null
  now: number
}

export type Kind = 'text' | 'enum' | 'money' | 'int' | 'num' | 'pct' | 'score' | 'rel' | 'date' | 'bool' | 'custom'

export interface DeskColumnDef {
  id: string
  header: string
  group: ColumnGroup
  kind: Kind
  /** the raw value: sort key and the default display */
  value: (r: RowContext) => string | number | boolean | null
  /** enrichment field this column needs (`source.column`), if any */
  needs?: string
  /** the source, for the picker ("Feed", "Property record", …) */
  source: string
  hint?: string
  width?: number
  minWidth?: number
  sortable?: boolean
  /** text for an empty identity fact ("Unknown") instead of "—" */
  emptyText?: string
  /** shown by default */
  defaultOn?: boolean
  /** cannot be hidden */
  locked?: boolean
}

/* ── value helpers ─────────────────────────────────────────────────────── */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}
const bool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null)
const ext = <K extends keyof NonNullable<DeskCard['ext']>>(r: RowContext, k: K) => (r.card.ext ? r.card.ext[k] : null) ?? null
const fx = (source: EnrichSource, col: string) => (r: RowContext) => r.x[source]?.[col] ?? null

/** Enum words: `NEEDS_REPLY` / `needs_reply` → "Needs reply". */
export function words(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const t = s.replace(/_/g, ' ').toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const PHONE_TYPE: Record<string, string> = { W: 'Wireless', L: 'Landline', V: 'VoIP', M: 'Wireless' }

/** Display text for a value of a kind; null when there is nothing honest to show. */
export function formatValue(kind: Kind, v: unknown, now: number): string | null {
  if (v === null || v === undefined || v === '') return null
  switch (kind) {
    case 'money': return compactMoney(num(v))
    case 'int': { const n = num(v); return n === null ? null : Math.round(n).toLocaleString('en-US') }
    case 'num': { const n = num(v); return n === null ? null : (Math.round(n * 10) / 10).toLocaleString('en-US') }
    case 'pct': { const n = num(v); return n === null ? null : `${Math.round(n)}%` }
    case 'score': { const n = num(v); return n === null ? null : String(Math.round(n)) }
    case 'rel': return typeof v === 'string' ? relShort(v, now) : null
    case 'date': return typeof v === 'string' ? stampCT(v) : null
    case 'bool': { const b = bool(v); return b === null ? null : b ? 'Yes' : 'No' }
    case 'enum': return words(v)
    default: return str(v)
  }
}

/** Sort key: numbers and dates compare as numbers; empty always sorts last. */
export function sortKey(kind: Kind, v: unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null
  if (kind === 'rel' || kind === 'date') { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null }
  if (kind === 'bool') { const b = bool(v); return b === null ? null : b ? 1 : 0 }
  if (kind === 'money' || kind === 'int' || kind === 'num' || kind === 'pct' || kind === 'score') return num(v)
  return String(v).toLowerCase()
}

/* ── the catalog ───────────────────────────────────────────────────────── */

const FEED = 'Pipeline feed'
const THREAD = 'Conversation state'
const PROP = 'Property record'
const OWNER = 'Master owner'
const ENGINE = 'Acquisition engine (property_acquisition_scores)'
const OFFERS = 'Offer picture'

const col = (d: Omit<DeskColumnDef, 'sortable'> & { sortable?: boolean }): DeskColumnDef => ({ sortable: true, ...d })
const prop = (id: string, header: string, kind: Kind, column: string, extra: Partial<DeskColumnDef> = {}) =>
  col({ id: `p_${id}`, header, group: 'property', kind, source: PROP, needs: `property.${column}`, value: fx('property', column) as DeskColumnDef['value'], width: 112, ...extra })
const owner = (id: string, header: string, kind: Kind, column: string, extra: Partial<DeskColumnDef> = {}) =>
  col({ id: `o_${id}`, header, group: 'seller', kind, source: OWNER, needs: `owner.${column}`, value: fx('owner', column) as DeskColumnDef['value'], width: 120, ...extra })
const score = (id: string, header: string, kind: Kind, column: string, extra: Partial<DeskColumnDef> = {}) =>
  col({ id: `s_${id}`, header, group: 'scores', kind, source: ENGINE, needs: `scores.${column}`, value: fx('scores', column) as DeskColumnDef['value'], width: 112, ...extra })

const liveOffer = (o: DeskOfferRow | null) => (o?.offer?.price && o.offer.status ? o.offer : null)

export const DESK_COLUMNS: ReadonlyArray<DeskColumnDef> = [
  /* Deal */
  col({ id: 'deal', header: 'Deal', group: 'deal', kind: 'custom', source: FEED, locked: true, defaultOn: true, minWidth: 210, value: (r) => (r.card.address || r.card.seller || '').toLowerCase() || null }),
  col({ id: 'stage', header: 'Stage', group: 'deal', kind: 'custom', source: FEED, defaultOn: true, width: 124, value: (r) => r.card.stageIndex ?? null }),
  col({ id: 'owner', header: 'Whose move', group: 'deal', kind: 'custom', source: FEED, defaultOn: true, width: 150, value: (r) => OWNER_RANK[r.card.owner] ?? 9 }),
  col({ id: 'why', header: 'Why', group: 'deal', kind: 'custom', source: FEED, defaultOn: true, minWidth: 210, sortable: false, hint: 'The evidence behind whose move it is', value: (r) => r.card.lane.label }),
  col({ id: 'age', header: 'In stage', group: 'deal', kind: 'custom', source: FEED, defaultOn: true, width: 108, hint: 'Days in stage, against the stage’s own clock', value: (r) => r.card.daysInStage }),
  col({ id: 'value', header: 'Est. value', group: 'deal', kind: 'money', source: FEED, defaultOn: true, width: 120, hint: 'Estimated value — the property record or the engine, never a price', value: (r) => r.card.money.value }),
  col({ id: 'ask', header: 'Seller ask', group: 'deal', kind: 'custom', source: FEED, defaultOn: true, width: 124, hint: 'Stated by the seller', value: (r) => (r.card.money.askImplausible ? null : r.card.money.asking) }),
  col({ id: 'status', header: 'Deal status', group: 'deal', kind: 'enum', source: FEED, width: 116, value: (r) => r.card.status }),
  col({ id: 'heat', header: 'Seller heat', group: 'deal', kind: 'enum', source: FEED, width: 104, value: (r) => r.card.temperature }),
  col({ id: 'counter', header: 'Seller counter', group: 'deal', kind: 'money', source: FEED, width: 124, hint: 'Stated by the seller', value: (r) => (r.card.money.counterImplausible ? null : r.card.money.counter) }),
  col({ id: 'cur_offer', header: 'Current offer', group: 'deal', kind: 'money', source: FEED, width: 120, hint: 'The deal’s current offer field', value: (r) => r.card.money.offer }),
  col({ id: 'offer_record', header: 'Offer on record', group: 'deal', kind: 'custom', source: OFFERS, width: 150, hint: 'Latest seller_offers row (actual), from the Offers read — priced deals only', value: (r) => liveOffer(r.offer)?.price ?? null }),
  col({ id: 'offer_sent', header: 'Offer sent', group: 'deal', kind: 'rel', source: OFFERS, width: 104, value: (r) => r.offer?.offer?.sentAt ?? null }),
  col({ id: 'rec_offer', header: 'Recommended offer', group: 'deal', kind: 'money', source: FEED, width: 136, hint: 'Modeled — the deal’s recommended offer', value: (r) => ext(r, 'recommendedOffer') }),
  col({ id: 'arv', header: 'ARV', group: 'deal', kind: 'money', source: FEED, width: 104, hint: 'After-repair value · estimated', value: (r) => ext(r, 'arv') }),
  col({ id: 'gap', header: 'Offer ↔ ask gap', group: 'deal', kind: 'money', source: FEED, width: 128, value: (r) => ext(r, 'offerToAskGap') }),
  col({ id: 'spread', header: 'Favorable spread', group: 'deal', kind: 'money', source: FEED, width: 128, value: (r) => ext(r, 'favorableSpread') }),
  col({ id: 'contract', header: 'Contract price', group: 'deal', kind: 'money', source: FEED, width: 120, hint: 'Closing case · actual', value: (r) => r.card.money.contractPrice }),
  col({ id: 'buyer_price', header: 'Buyer price', group: 'deal', kind: 'money', source: FEED, width: 112, hint: 'Closing case · actual', value: (r) => r.card.money.buyerPrice }),
  col({ id: 'closing', header: 'Closing status', group: 'deal', kind: 'enum', source: FEED, width: 128, value: (r) => r.card.closing?.status ?? null }),
  col({ id: 'closing_date', header: 'Closing date', group: 'deal', kind: 'date', source: FEED, width: 128, value: (r) => r.card.closing?.date ?? null }),
  col({ id: 'strategy', header: 'Strategy', group: 'deal', kind: 'enum', source: FEED, width: 128, value: (r) => ext(r, 'strategy') }),
  col({ id: 'strategy_status', header: 'Strategy status', group: 'deal', kind: 'enum', source: FEED, width: 128, value: (r) => ext(r, 'strategyStatus') }),
  col({ id: 'priority', header: 'Priority', group: 'deal', kind: 'enum', source: FEED, width: 96, value: (r) => ext(r, 'priority') }),
  col({ id: 'assignee', header: 'Assigned to', group: 'deal', kind: 'text', source: FEED, width: 128, value: (r) => ext(r, 'assignedOperator') }),
  col({ id: 'channel', header: 'Source channel', group: 'deal', kind: 'enum', source: FEED, width: 120, value: (r) => ext(r, 'sourceChannel') }),
  col({ id: 'portfolio', header: 'Portfolio size', group: 'deal', kind: 'int', source: FEED, width: 108, hint: 'Properties in this deal’s portfolio', value: (r) => ext(r, 'portfolioCount') }),
  col({ id: 'created', header: 'Created', group: 'deal', kind: 'rel', source: FEED, width: 96, value: (r) => r.card.createdAt }),
  col({ id: 'updated', header: 'Updated', group: 'deal', kind: 'rel', source: FEED, width: 96, value: (r) => ext(r, 'updatedAt') }),
  col({ id: 'n_days', header: 'Days in nurture', group: 'deal', kind: 'int', source: FEED, width: 120, hint: 'Since the seller’s “not interested” turn / the deal went to nurture', value: (r) => r.card.nurture?.days ?? null }),
  col({ id: 'archived', header: 'Archived', group: 'deal', kind: 'custom', source: 'Lead visibility', width: 210, hint: 'Archived by the shared archive (lead visibility). A scheduled follow-up keeps running.', value: (r) => r.card.archived?.at ?? null }),
  col({ id: 'entered', header: 'Entered stage', group: 'deal', kind: 'date', source: FEED, width: 128, value: (r) => ext(r, 'stageEnteredAt') }),

  /* Conversation */
  col({ id: 'last_msg', header: 'Last message', group: 'conversation', kind: 'custom', source: THREAD, minWidth: 240, sortable: false, value: (r) => r.card.lastMessage }),
  col({ id: 'last_msg_at', header: 'Last message at', group: 'conversation', kind: 'rel', source: THREAD, width: 112, hint: 'When the latest message (either direction) was sent', value: (r) => r.card.lastMessageAt }),
  col({ id: 'direction', header: 'Last direction', group: 'conversation', kind: 'custom', source: THREAD, width: 112, value: (r) => r.card.lastDirection }),
  col({ id: 'intent', header: 'Last seller intent', group: 'conversation', kind: 'custom', source: FEED, width: 160, hint: 'The classified intent of the seller’s latest turn', value: (r) => r.card.intentLabel || r.card.intent }),
  col({ id: 'last_reply', header: 'Seller replied', group: 'conversation', kind: 'rel', source: THREAD, width: 112, value: (r) => r.card.lastInboundAt }),
  col({ id: 'last_out', header: 'We last sent', group: 'conversation', kind: 'rel', source: THREAD, width: 112, value: (r) => ext(r, 'lastOutboundAt') }),
  col({ id: 'unread', header: 'Unread', group: 'conversation', kind: 'bool', source: THREAD, width: 84, value: (r) => (r.card.conversation ? r.card.conversation.unread : ext(r, 'unread')) }),
  col({ id: 'conv_state', header: 'Conversation', group: 'conversation', kind: 'custom', source: THREAD, width: 168, sortable: false, hint: 'The conversation’s own state: archived, snoozed, unread (inbox_thread_state)', value: (r) => conversationWords(r.card) }),
  col({ id: 'bucket', header: 'Inbox bucket', group: 'conversation', kind: 'enum', source: THREAD, width: 132, value: (r) => ext(r, 'inboxBucket') }),
  col({ id: 'snooze', header: 'Snoozed until', group: 'conversation', kind: 'date', source: THREAD, width: 132, value: (r) => (r.card.conversation ? r.card.conversation.snoozedUntil : ext(r, 'snoozedUntil')) }),
  col({ id: 'messages', header: 'Messages', group: 'conversation', kind: 'int', source: THREAD, width: 92, value: (r) => ext(r, 'messageCount') }),
  col({ id: 'replies', header: 'Seller replies', group: 'conversation', kind: 'int', source: THREAD, width: 108, value: (r) => ext(r, 'inboundCount') }),
  col({ id: 'delivery', header: 'Last delivery', group: 'conversation', kind: 'enum', source: THREAD, width: 112, value: (r) => ext(r, 'deliveryStatus') }),
  col({ id: 'activity', header: 'Last activity', group: 'conversation', kind: 'rel', source: FEED, width: 112, value: (r) => r.card.lastActivityAt }),
  col({ id: 'last_contact', header: 'Last contact', group: 'conversation', kind: 'rel', source: FEED, width: 112, value: (r) => ext(r, 'lastContactAt') }),

  /* Automation */
  col({ id: 'next_send', header: 'Next scheduled', group: 'automation', kind: 'custom', source: 'Send queue', width: 168, hint: 'The next queued reply or follow-up for this thread (what the queue holds, not what was intended)', value: (r) => r.card.queue?.next?.at ?? ext(r, 'nextScheduledFor') }),
  col({ id: 'n_next', header: 'Next follow-up', group: 'automation', kind: 'custom', source: 'Send queue · deal', width: 168, hint: 'The queued follow-up when the queue holds one, else the deal’s stated follow-up date', value: (r) => nextFollowUp(r.card)?.at ?? null }),
  col({ id: 'follow_up', header: 'Follow-up date', group: 'automation', kind: 'date', source: THREAD, width: 132, value: (r) => ext(r, 'followUpAt') }),
  col({ id: 'next_action', header: 'Next action (stated)', group: 'automation', kind: 'custom', source: FEED, width: 180, hint: 'What the last turn said should happen next — the queue shows what actually happened', value: (r) => r.card.intent_next?.due ?? r.card.intent_next?.action ?? null }),
  col({ id: 'lane', header: 'Automation lane', group: 'automation', kind: 'enum', source: THREAD, width: 136, value: (r) => ext(r, 'automationLane') }),
  col({ id: 'auto_state', header: 'Automation state', group: 'automation', kind: 'enum', source: FEED, width: 136, value: (r) => ext(r, 'automationState') }),
  col({ id: 'ops_status', header: 'Operational status', group: 'automation', kind: 'enum', source: THREAD, width: 144, value: (r) => ext(r, 'operationalStatus') }),
  col({ id: 'approval', header: 'Approval', group: 'automation', kind: 'enum', source: FEED, width: 112, value: (r) => ext(r, 'approvalState') }),
  col({ id: 'blocker', header: 'Blocker', group: 'automation', kind: 'enum', source: FEED, width: 136, value: (r) => ext(r, 'blocker') }),
  col({ id: 'hold', header: 'Hold', group: 'automation', kind: 'custom', source: FEED, width: 136, value: (r) => (r.card.hold ? HOLD_META[r.card.hold].label : null) }),
  col({ id: 'stall', header: 'Stalled', group: 'automation', kind: 'custom', source: FEED, width: 136, value: (r) => r.card.stall?.label ?? null }),
  col({ id: 'pending', header: 'Queued sends', group: 'automation', kind: 'int', source: THREAD, width: 108, value: (r) => ext(r, 'pendingQueue') }),
  col({ id: 'suppressed', header: 'Suppressed', group: 'automation', kind: 'bool', source: THREAD, width: 100, value: (r) => ext(r, 'suppressed') }),

  /* Property */
  col({ id: 'address', header: 'Address', group: 'property', kind: 'text', source: FEED, minWidth: 180, value: (r) => r.card.address }),
  col({ id: 'market', header: 'Market', group: 'property', kind: 'text', source: FEED, width: 150, value: (r) => r.card.market }),
  col({ id: 'ptype', header: 'Property type', group: 'property', kind: 'text', source: FEED, width: 140, value: (r) => r.card.propertyType }),
  col({ id: 'asset_class', header: 'Asset class', group: 'property', kind: 'enum', source: FEED, width: 120, value: (r) => ext(r, 'assetClass') }),
  prop('city', 'City', 'text', 'property_address_city', { width: 128 }),
  prop('zip', 'ZIP', 'text', 'property_address_zip', { width: 84 }),
  prop('county', 'County', 'text', 'property_address_county_name', { width: 128 }),
  prop('class', 'Property class', 'enum', 'property_class', { width: 128 }),
  prop('subtype', 'Subtype', 'enum', 'asset_subtype', { width: 128 }),
  prop('units', 'Units', 'int', 'units_count', { width: 76 }),
  prop('beds', 'Beds', 'num', 'total_bedrooms', { width: 72 }),
  prop('baths', 'Baths', 'num', 'total_baths', { width: 72 }),
  prop('sqft', 'Sq ft', 'int', 'building_square_feet', { width: 88 }),
  prop('lot', 'Lot sq ft', 'int', 'lot_square_feet', { width: 96 }),
  prop('acres', 'Lot acres', 'num', 'lot_acreage', { width: 88 }),
  prop('year', 'Year built', 'custom', 'year_built', { width: 92 }),
  prop('stories', 'Stories', 'num', 'stories', { width: 80 }),
  prop('condition', 'Condition', 'enum', 'building_condition', { width: 108 }),
  prop('rehab', 'Rehab level', 'enum', 'rehab_level', { width: 108 }),
  prop('value', 'Record value', 'money', 'estimated_value', { width: 112, hint: 'The property record’s estimated value' }),
  prop('equity', 'Equity', 'money', 'equity_amount', { width: 100 }),
  prop('equity_pct', 'Equity %', 'pct', 'equity_percent', { width: 88 }),
  prop('loans', 'Loan balance', 'money', 'total_loan_balance', { width: 112 }),
  prop('tax_delinquent', 'Tax delinquent', 'bool', 'tax_delinquent', { width: 112 }),
  prop('lien', 'Active lien', 'bool', 'active_lien', { width: 96 }),
  prop('owned', 'Years owned', 'num', 'ownership_years', { width: 100 }),
  prop('sale_date', 'Last sale', 'date', 'sale_date', { width: 120 }),
  prop('sale_price', 'Last sale price', 'money', 'sale_price', { width: 120 }),
  prop('listing', 'Listing status', 'enum', 'market_status_label', { width: 120, hint: 'Market status of the property (on / off market)' }),
  prop('mls', 'MLS status', 'enum', 'mls_market_status', { width: 108 }),
  prop('foreclosure', 'Foreclosure', 'enum', 'foreclosure_status', { width: 120 }),
  prop('bucket', 'Acquisition bucket', 'enum', 'acquisition_bucket', { width: 148 }),
  prop('strategy', 'Property strategy', 'enum', 'property_strategy', { width: 140 }),
  prop('zoning', 'Zoning', 'text', 'zoning', { width: 96 }),
  prop('rent', 'Rent estimate', 'money', 'rent_estimate', { width: 112 }),
  prop('repairs', 'Repair estimate', 'money', 'estimated_repair_cost', { width: 120 }),
  prop('flags', 'Property flags', 'text', 'property_flags_text', { minWidth: 180, width: undefined, sortable: false }),

  /* Seller */
  col({ id: 'seller', header: 'Seller', group: 'seller', kind: 'text', source: FEED, minWidth: 160, value: (r) => r.card.seller }),
  owner('entity', 'Owner entity', 'enum', 'owner_type_guess', { hint: 'The owner’s entity type (individual, LLC, trust…), as the owner graph guesses it', emptyText: 'Unknown' }),
  prop('owner_type', 'Owner type (record)', 'enum', 'owner_type', { group: 'seller', width: 132, emptyText: 'Unknown' }),
  prop('corporate', 'Corporate owner', 'bool', 'is_corporate_owner', { group: 'seller', width: 120 }),
  prop('absentee', 'Out-of-state owner', 'bool', 'out_of_state_owner', { group: 'seller', width: 132 }),
  owner('language', 'Language', 'enum', 'best_language', { width: 104, emptyText: 'Unknown' }),
  col({ id: 'p_phone_type', header: 'Phone type', group: 'seller', kind: 'custom', source: PROP, needs: 'property.phone_type', width: 104, emptyText: 'Unknown', value: (r) => { const v = str(r.x.property?.phone_type); return v ? PHONE_TYPE[v.toUpperCase()] ?? v : null } }),
  prop('sms', 'SMS eligible', 'bool', 'sms_eligible', { group: 'seller', width: 104, emptyText: 'Unknown' }),
  owner('tier', 'Owner priority tier', 'enum', 'priority_tier', { width: 140 }),
  owner('count', 'Properties owned', 'int', 'property_count', { width: 124 }),
  owner('portfolio_value', 'Portfolio value', 'money', 'portfolio_total_value', { width: 124 }),
  owner('portfolio_equity', 'Portfolio equity', 'money', 'portfolio_total_equity', { width: 124 }),
  owner('contactability', 'Contactability', 'score', 'contactability_score', { width: 112 }),
  owner('pressure', 'Financial pressure', 'score', 'financial_pressure_score', { width: 132 }),
  owner('urgency', 'Owner urgency', 'score', 'urgency_score', { width: 116 }),
  owner('tz', 'Time zone', 'text', 'routing_timezone', { width: 128, emptyText: 'Unknown' }),
  owner('channel', 'Best channel', 'enum', 'best_channel', { width: 108 }),

  /* Scores & engine */
  score('aos', 'AOS', 'score', 'aos_score', { width: 76, hint: 'Acquisition opportunity score — the engine’s canonical row' }),
  score('tier', 'Decision tier', 'enum', 'decision_tier', { width: 148 }),
  score('confidence', 'Engine confidence', 'score', 'confidence', { width: 132 }),
  score('strategy', 'Best strategy', 'enum', 'best_strategy', { width: 132 }),
  score('val_low', 'Valuation low', 'money', 'valuation_low', { hint: 'Estimated' }),
  score('val_mid', 'Valuation mid', 'money', 'valuation_mid', { hint: 'Estimated' }),
  score('val_high', 'Valuation high', 'money', 'valuation_high', { hint: 'Estimated' }),
  score('val_conf', 'Valuation confidence', 'score', 'valuation_confidence', { width: 148 }),
  score('comps', 'Comps', 'int', 'comp_count', { width: 76, hint: 'Qualified comps behind the valuation' }),
  score('cash_offer', 'Engine cash offer', 'money', 'recommended_cash_offer', { width: 128, hint: 'Modeled — not an authorized or sent offer' }),
  score('min_offer', 'Min. acceptable', 'money', 'minimum_acceptable_offer', { width: 124, hint: 'Modeled floor' }),
  score('fee', 'Assignment fee', 'money', 'expected_assignment_fee', { width: 120, hint: 'Expected · modeled' }),
  score('p90', 'Sale prob. 90d', 'pct', 'transaction_probability_90', { width: 116 }),
  score('demand', 'Buyer demand', 'score', 'buyer_demand_score', { width: 112 }),
  score('liquidity', 'Liquidity', 'score', 'liquidity_score', { width: 92 }),
  score('repairs', 'Engine repairs', 'money', 'estimated_repairs', { width: 116, hint: 'Estimated' }),
  score('priced', 'Priced', 'rel', 'computed_at', { width: 92, hint: 'When the engine last computed this property' }),
  col({ id: 'deal_aos', header: 'Deal AOS', group: 'scores', kind: 'score', source: FEED, width: 92, hint: 'The deal row’s own AOS field', value: (r) => ext(r, 'aos') }),
  col({ id: 'motivation', header: 'Motivation', group: 'scores', kind: 'score', source: FEED, width: 100, value: (r) => ext(r, 'motivation') }),
  col({ id: 'cooperation', header: 'Cooperation', group: 'scores', kind: 'score', source: FEED, width: 104, value: (r) => ext(r, 'cooperation') }),
  prop('final_score', 'Acquisition score (record)', 'score', 'final_acquisition_score', { group: 'scores', width: 168 }),
  prop('motivation_rec', 'Motivation (record)', 'score', 'structured_motivation_score', { group: 'scores', width: 140 }),
  prop('strength', 'Deal strength (record)', 'score', 'deal_strength_score', { group: 'scores', width: 156 }),
]

/** The next follow-up: the queue's own row first (what will actually send), else the deal's stated due date. */
export function nextFollowUp(c: DeskCard): { at: string; queued: boolean } | null {
  const q = c.queue?.next
  if (q && q.kind === 'follow_up' && q.at) return { at: q.at, queued: true }
  const due = c.nurture?.followUpDue ?? c.intent_next?.due ?? null
  return due ? { at: due, queued: false } : null
}

/** "Archived · Snoozed until … · Unread" — only what the conversation row says. */
export function conversationWords(c: DeskCard): string | null {
  const v = c.conversation
  if (!v) return null
  const parts = [v.archived ? 'Archived' : null, v.snoozedUntil ? `Snoozed until ${stampCT(v.snoozedUntil) ?? v.snoozedUntil}` : null, v.unread ? 'Unread' : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Open'
}

/** An archived deal whose follow-up is still queued says so (the archive does not cancel it while lead visibility is on). */
export function archivedNote(c: DeskCard): string | null {
  if (!c.archived) return null
  const q = c.queue?.next
  const still = q && q.kind === 'follow_up' && q.future ? ` · follow-up still scheduled (${stampCT(q.at) ?? 'queued'})` : ''
  return `Archived${still}`
}

export const OWNER_RANK: Record<string, number> = { blocked: 0, needs_you: 1, autopilot: 2, scheduled: 3, external: 4, seller: 5, dormant: 6, closed_out: 7, complete: 8 }

export const COLUMN_BY_ID: ReadonlyMap<string, DeskColumnDef> = new Map(DESK_COLUMNS.map((c) => [c.id, c]))
export const DEFAULT_COLUMNS: readonly string[] = DESK_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id)

/** The table's lenses: Working (the main view), Nurture, Archived (lead visibility on). Each has its own layout. */
export type TableLens = 'working' | 'nurture' | 'archived'
export const LENS_DEFAULTS: Record<TableLens, readonly string[]> = {
  working: DEFAULT_COLUMNS,
  nurture: ['deal', 'stage', 'n_next', 'last_reply', 'n_days', 'intent', 'heat', 'conv_state'],
  archived: ['deal', 'stage', 'archived', 'n_next', 'last_reply', 'conv_state', 'value'],
}

/* ── layout (visible columns, in order) ────────────────────────────────── */

export interface ColumnLayout { visible: string[] }

/** A stored layout made safe: known ids only, no duplicates, the locked Deal column first. */
export function normalizeLayout(raw: unknown, defaults: readonly string[] = DEFAULT_COLUMNS): ColumnLayout {
  const ids = raw && typeof raw === 'object' && Array.isArray((raw as ColumnLayout).visible) ? (raw as ColumnLayout).visible : null
  if (!ids) return { visible: [...defaults] }
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) if (typeof id === 'string' && COLUMN_BY_ID.has(id) && !seen.has(id)) { seen.add(id); out.push(id) }
  for (const c of DESK_COLUMNS) if (c.locked && !seen.has(c.id)) out.unshift(c.id)
  return { visible: out }
}

export function toggleColumn(layout: ColumnLayout, id: string): ColumnLayout {
  const c = COLUMN_BY_ID.get(id)
  if (!c || c.locked) return layout
  return layout.visible.includes(id) ? { visible: layout.visible.filter((x) => x !== id) } : { visible: [...layout.visible, id] }
}

/** Move a visible column one place (the locked Deal column never moves). */
export function moveColumn(layout: ColumnLayout, id: string, delta: -1 | 1): ColumnLayout {
  const i = layout.visible.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= layout.visible.length) return layout
  if (COLUMN_BY_ID.get(id)?.locked || COLUMN_BY_ID.get(layout.visible[j])?.locked) return layout
  const next = [...layout.visible]
  ;[next[i], next[j]] = [next[j], next[i]]
  return { visible: next }
}

/** The enrichment fields the visible columns need, grouped by source. */
export function neededFields(visible: readonly string[]): Record<EnrichSource, string[]> {
  const out: Record<EnrichSource, string[]> = { property: [], owner: [], scores: [] }
  for (const id of visible) {
    const need = COLUMN_BY_ID.get(id)?.needs
    if (!need) continue
    const [src, colName] = need.split('.') as [EnrichSource, string]
    if (out[src] && !out[src].includes(colName)) out[src].push(colName)
  }
  return out
}

/** Picker search: header, group or source words. */
export function matchesColumn(c: DeskColumnDef, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const group = COLUMN_GROUPS.find((g) => g.id === c.group)?.label ?? ''
  return `${c.header} ${group} ${c.source} ${c.hint ?? ''}`.toLowerCase().includes(s)
}

