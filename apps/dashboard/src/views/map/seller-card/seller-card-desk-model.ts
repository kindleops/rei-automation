/**
 * DESKTOP SELLER CARD — the model behind PREVIEW → HALF → FULL.
 *
 * Pure derivations over what the card already holds: the record (pin payload,
 * peek/dossier hydration, inbox_thread_state), its view model, and — when the
 * conversation has been hydrated — the thread's messages and context. Nothing
 * here fetches, and nothing here invents: a value the record does not carry is
 * `null`, and the UI states that plainly instead of guessing.
 *
 * Three traps this file exists to respect:
 *  - `tax_delinquent`, `active_lien` and `out_of_state_owner` are coerced to
 *    `false` by the peek hydration (the columns are not selected there), so
 *    their ABSENCE is only a fact once the dossier has loaded.
 *  - lifecycle stage and contactability fall back to S1 / contactable when the
 *    record is silent, so "contactable" is never claimed without a phone.
 *  - zero loan balance is indistinguishable from "unknown" after the shared
 *    formatters' zero-as-missing rule, so it is never shown as free-and-clear.
 */
import {
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  type LifecycleStageCode,
} from '../../../domain/lead-state/universal-lead-state-registry'
import type { ThreadContext, ThreadMessage } from '../../../lib/data/inboxData'
import { isEntityName, safeHumanName } from '../../../lib/identity/entityDetection'
import { buildAssetInput } from './seller-asset-presentation-registry'
import { buildCanonicalLeadStatePresentation } from './seller-lead-state-presentation'
import {
  asNumber,
  firstDefined,
  formatDate,
  formatDecimal,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  nullIfZeroish,
  text,
  titleize,
} from './seller-map-card-formatters'
import type { SellerMapCardViewModel } from './seller-map-card.types'

export type DeskState = 'preview' | 'half' | 'full'
export type DeskTab = 'overview' | 'seller' | 'property' | 'activity' | 'deal' | 'comps' | 'buyers' | 'campaigns' | 'graph'

export const HALF_TABS: DeskTab[] = ['overview', 'seller', 'deal', 'comps', 'buyers', 'activity']
export const FULL_TABS: DeskTab[] = ['overview', 'seller', 'property', 'activity', 'deal', 'comps', 'buyers', 'campaigns', 'graph']
export const TAB_LABEL: Record<DeskTab, string> = {
  overview: 'Overview',
  seller: 'Seller',
  property: 'Property',
  activity: 'Activity',
  deal: 'Deal',
  comps: 'Comps',
  buyers: 'Buyers',
  campaigns: 'Campaigns',
  graph: 'Graph',
}

/**
 * Colour is spent sparingly and always means the same thing:
 * value = gold (acquisition value / attention), active = cobalt-cyan (live
 * intelligence), verified = green, blocker = red (suppression / DNC only),
 * system = violet (automation / graph), attention = amber (distress, due).
 */
export type DeskTone = 'neutral' | 'value' | 'active' | 'verified' | 'blocker' | 'system' | 'attention'

export type DeskFact = {
  key: string
  label: string
  /** null = not on the record; the UI says so rather than inventing a value. */
  value: string | null
  sub?: string | null
  tone?: DeskTone
  /** Shown instead of a dash when the value is missing. */
  missing?: string
  /** The value arrives with the property dossier (skeleton while it loads). */
  dossier?: boolean
}

export type DeskBadge = { key: string; label: string; tone: DeskTone }

export type DeskEventKind =
  | 'sms_in' | 'sms_out' | 'sms_failed' | 'scheduled' | 'follow_up'
  | 'sale' | 'deed' | 'lien' | 'mls' | 'auction' | 'tax'

export type DeskEvent = {
  key: string
  kind: DeskEventKind
  at: string
  atMs: number
  title: string
  detail?: string | null
  source: string
  status?: string | null
  upcoming?: boolean
}

export type DeskRailStep = { code: LifecycleStageCode; n: number; label: string; reached: boolean; current: boolean }

export type SellerDeskModel = {
  identity: {
    line1: string
    locality: string | null
    market: string | null
    zip: string | null
    full: string
    ownerName: string
    ownerKnown: boolean
    ownerKind: string | null
    ownerIsEntity: boolean
    contactName: string | null
    mailingAddress: string | null
  }
  factLine: string | null
  assetLabel: string
  value: { estimated: string | null; equityPct: string | null; equityAmt: string | null; perSqft: string | null }
  stage: {
    code: LifecycleStageCode
    n: number
    label: string
    color: string
    statusCode: string
    statusLabel: string
    temperature: string
    temperatureLabel: string
    contactabilityLabel: string
    blocked: boolean
    blockReason: string | null
  }
  rail: DeskRailStep[]
  badges: DeskBadge[]
  tiles: DeskFact[]
  kpis: DeskFact[]
  acquisition: DeskFact[]
  nextAction: { label: string; detail: string | null; tone: DeskTone }
  summary: string
  phones: Array<{ value: string; display: string }>
  email: string | null
  seller: { owner: DeskFact[]; contact: DeskFact[]; occupancy: DeskFact[]; automation: DeskFact[]; compliance: DeskFact[] }
  deal: { valuation: DeskFact[]; scores: DeskFact[] }
  subject: DeskFact[]
  market: DeskFact[]
  outreach: DeskFact[]
  graph: {
    owner: { id: string | null; label: string; sub: string | null }
    property: { id: string; label: string; sub: string | null }
    contact: { id: string | null; label: string | null; sub: string | null }
    phones: string[]
    thread: string | null
    portfolio: string | null
  }
  events: DeskEvent[]
  aiBrief: string | null
  links: { propertyId: string; threadKey: string | null; masterOwnerId: string | null; prospectId: string | null }
  dossierReady: boolean
  hasRealThread: boolean
}

const nOrNull = (value: unknown): number | null => nullIfZeroish(asNumber(value))
const str = (record: Record<string, unknown>, keys: string[]): string | null => text(firstDefined(record, keys)) || null
const money = (value: number | null) => (value == null ? null : formatMoney(value))
const isTrue = (value: unknown) => value === true || String(value ?? '').trim().toLowerCase() === 'true'

const parseMs = (value: string | null | undefined): number => {
  if (!value) return Number.NaN
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : Number.NaN
}

/** "+16125550100" → "(612) 555-0100"; anything else is shown as stored. */
export const formatPhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
  return raw
}

/** Short absolute time for the feed: "Sep 12, 4:05 PM". */
export const formatWhen = (iso: string): string => {
  const ms = parseMs(iso)
  if (!Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
}

const splitAddress = (record: Record<string, unknown>, full: string) => {
  const head = full.split(',')[0]?.trim() || full
  const city = str(record, ['property_address_city'])
  const state = str(record, ['property_address_state'])
  const zipField = str(record, ['property_address_zip'])
  const zipParsed = full.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null
  const zip = zipField ? zipField.slice(0, 5) : zipParsed
  const rest = full.includes(',') ? full.slice(full.indexOf(',') + 1).trim() : ''
  const locality = city && state
    ? `${titleize(city.toLowerCase())}, ${state.toUpperCase()}${zip ? ` ${zip}` : ''}`
    : rest || null
  return { line1: head, locality, zip }
}

const collectPhones = (record: Record<string, unknown>): Array<{ value: string; display: string }> => {
  const seen = new Set<string>()
  const out: Array<{ value: string; display: string }> = []
  for (const key of ['canonical_e164', 'seller_phone', 'prospect_best_phone', 'display_phone', 'best_phone', 'phone']) {
    const raw = text(record[key])
    if (!raw || raw.toLowerCase() === 'no phone') continue
    const digits = raw.replace(/\D/g, '')
    if (digits.length < 10) continue
    const norm = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({ value: raw, display: formatPhone(raw) })
  }
  return out
}

const stageRail = (code: LifecycleStageCode): DeskRailStep[] => {
  const index = LIFECYCLE_STAGE_ORDER.indexOf(code)
  return LIFECYCLE_STAGE_ORDER.map((step, i) => ({
    code: step,
    n: LIFECYCLE_STAGE_META[step].number,
    label: LIFECYCLE_STAGE_META[step].label,
    reached: i <= index,
    current: i === index,
  }))
}

const messageEvents = (messages: ThreadMessage[]): DeskEvent[] => messages
  .filter((m) => (m.body ?? '').trim() || m.templateName)
  .map((m, i) => {
    const at = m.timelineAt || m.createdAt || m.sentAt || ''
    const status = (m.deliveryStatusDisplay || m.deliveryStatus || '').toLowerCase() || null
    const failed = status === 'failed' || Boolean(m.error)
    const kind: DeskEventKind = m.direction === 'inbound' ? 'sms_in' : failed ? 'sms_failed' : 'sms_out'
    const title = m.direction === 'inbound'
      ? 'Seller replied'
      : failed
        ? 'Message failed'
        : m.templateName ? `Sent · ${m.templateName}` : 'Message sent'
    return {
      key: `m-${m.id || i}`,
      kind,
      at,
      atMs: parseMs(at),
      title,
      detail: (m.body ?? '').trim().slice(0, 220) || null,
      source: m.direction === 'inbound' ? 'SMS · Inbox' : 'SMS · Outbound',
      status: m.direction === 'inbound' ? null : failed ? 'Failed' : status === 'delivered' ? 'Delivered' : status === 'queued' ? 'Queued' : status === 'sent' ? 'Sent' : null,
    }
  })

const recordEvents = (record: Record<string, unknown>, dossierReady: boolean, hasMessages: boolean): DeskEvent[] => {
  const events: DeskEvent[] = []
  const now = Date.now()
  const push = (e: Omit<DeskEvent, 'atMs' | 'upcoming'>) => {
    const atMs = parseMs(e.at)
    if (!Number.isFinite(atMs)) return
    events.push({ ...e, atMs, upcoming: atMs > now })
  }

  // The thread summary stands in for the transcript until it has been hydrated.
  if (!hasMessages) {
    const latestAt = str(record, ['latest_message_at'])
    const direction = text(firstDefined(record, ['latest_direction', 'latest_message_direction'])).toLowerCase()
    if (latestAt) {
      const inbound = direction === 'inbound'
      push({
        key: 'latest',
        kind: inbound ? 'sms_in' : 'sms_out',
        at: latestAt,
        title: inbound ? 'Seller replied' : 'Last message sent',
        detail: str(record, inbound ? ['last_inbound_text'] : ['last_outbound_text']),
        source: 'Inbox thread',
        status: inbound ? null : titleize(text(record.delivery_status)) || null,
      })
    }
  }

  const nextSend = str(record, ['next_scheduled_for'])
  if (nextSend) push({ key: 'next-send', kind: 'scheduled', at: nextSend, title: 'Scheduled send', detail: null, source: 'Outreach queue' })
  const followUp = str(record, ['follow_up_due_at'])
  if (followUp && followUp !== nextSend) push({ key: 'follow-up', kind: 'follow_up', at: followUp, title: 'Follow-up due', detail: null, source: 'Automation' })

  if (dossierReady) {
    const saleAt = str(record, ['sale_date', 'last_sale_date'])
    if (saleAt) {
      const price = money(nOrNull(firstDefined(record, ['saleprice', 'last_sale_amount'])))
      push({ key: 'sale', kind: 'sale', at: saleAt, title: price ? `Sold for ${price}` : 'Last sale', detail: null, source: 'County record' })
    }
    const recAt = str(record, ['recording_date'])
    if (recAt && recAt !== saleAt) {
      const doc = str(record, ['document_type'])
      push({ key: 'deed', kind: 'deed', at: recAt, title: doc ? `${titleize(doc)} recorded` : 'Document recorded', detail: null, source: 'County record' })
    }
    const lienAt = str(record, ['lien_recording_date'])
    if (lienAt) {
      push({
        key: 'lien',
        kind: 'lien',
        at: lienAt,
        title: str(record, ['lien_type']) ? `${titleize(text(record.lien_type))} lien recorded` : 'Lien recorded',
        detail: str(record, ['lienholder_name']) ? titleize(text(record.lienholder_name)) : null,
        source: 'County record',
      })
    }
    const mlsAt = str(record, ['mls_sold_date'])
    if (mlsAt) {
      const price = money(nOrNull(record.mls_sold_price))
      push({ key: 'mls', kind: 'mls', at: mlsAt, title: price ? `MLS sale · ${price}` : 'MLS sale', detail: null, source: 'MLS' })
    }
    const auctionAt = str(record, ['auction_date'])
    if (auctionAt) {
      push({
        key: 'auction',
        kind: 'auction',
        at: auctionAt,
        title: 'Auction date',
        detail: [str(record, ['auction_status']), str(record, ['auction_location'])].filter(Boolean).map((v) => titleize(String(v))).join(' · ') || null,
        source: 'Public notice',
      })
    }
    const delinquentYear = nOrNull(record.tax_delinquent_year)
    if (isTrue(record.tax_delinquent) && delinquentYear) {
      push({
        key: 'tax',
        kind: 'tax',
        at: `${Math.round(delinquentYear)}-01-01T12:00:00Z`,
        title: `Tax delinquent since ${Math.round(delinquentYear)}`,
        detail: money(nOrNull(record.past_due_amount)) ? `${money(nOrNull(record.past_due_amount))} past due` : null,
        source: 'Tax roll',
      })
    }
  }
  return events
}

const DISTRESS_KEYS = new Set(['pre_foreclosure', 'foreclosure', 'auction', 'tax_delinquent', 'active_lien', 'probate', 'code_violation'])

export const buildSellerDeskModel = (
  viewModel: SellerMapCardViewModel,
  record: Record<string, unknown>,
  thread: { messages: ThreadMessage[]; context: ThreadContext | null },
): SellerDeskModel => {
  const canonical = buildCanonicalLeadStatePresentation(record)
  const input = buildAssetInput(record)
  const dossierReady = viewModel.dossierReady
  const meta = LIFECYCLE_STAGE_META[canonical.stage as LifecycleStageCode] ?? LIFECYCLE_STAGE_META.ownership_confirmation
  const stageCode = (LIFECYCLE_STAGE_META[canonical.stage as LifecycleStageCode] ? canonical.stage : 'ownership_confirmation') as LifecycleStageCode

  const full = viewModel.property.address
  const { line1, locality, zip } = splitAddress(record, full)
  const market = str(record, ['market', 'filter_market'])
  const ownerName = viewModel.masterOwner.displayName
  const ownerKnown = ownerName !== 'Unknown Owner'
  const ownerType = str(record, ['owner_type'])
  const ownerIsEntity = (ownerKnown && isEntityName(ownerName)) || /llc|inc|corp|company|trust|lp\b|ltd|partners|holdings/i.test(ownerType ?? '')
  const ownerKind = ownerType ? titleize(ownerType.toLowerCase()) : ownerIsEntity ? 'Entity' : null
  const smsEligible = record.sms_eligible
  const prospect = safeHumanName(text(firstDefined(record, ['prospect_full_name', 'prospect_name', 'prospect_first_name'])))
  const contactName = prospect && prospect.toLowerCase() !== ownerName.toLowerCase() ? prospect : prospect || null

  const estimated = input.estimatedValue
  const equityPct = input.equityPercent
  const equityAmt = input.equityAmount
  const loan = input.mortgageBalance
  const repairs = input.repairs
  const yearsOwned = nOrNull(firstDefined(record, ['ownership_years', 'years_owned']))
  const saleAmount = nOrNull(firstDefined(record, ['saleprice', 'last_sale_amount']))
  const saleDate = str(record, ['sale_date', 'last_sale_date'])
  const outOfState = isTrue(record.out_of_state_owner)
  const absentee = isTrue(record.absentee_owner)
  const activeLien = isTrue(record.active_lien)
  const phones = collectPhones(record)
  const emailEntry = thread.context?.contactStack?.find((c) => /mail/i.test(c.type) && c.value)
  const email = emailEntry?.value ?? null

  const blocked = canonical.messagingBlocked
  const blockReason = viewModel.messagingBlockReason
  const stageN = meta.number
  const confirmed = stageN >= 2

  const inbound = nOrNull(record.inbound_count)
  const outbound = nOrNull(firstDefined(record, ['outbound_count', 'sent_count']))
  const latestAt = str(record, ['latest_message_at'])
  const latestDirection = text(firstDefined(record, ['latest_direction', 'latest_message_direction'])).toLowerCase()
  const queued = (nOrNull(record.queued_count) ?? 0) + (nOrNull(record.ready_count) ?? 0)
  const scheduled = nOrNull(record.scheduled_count) ?? 0
  const nextSend = str(record, ['next_scheduled_for', 'next_action_at'])
  const nextSendMs = parseMs(nextSend)
  const automation = str(record, ['automation_state', 'execution_state'])
  const hasRealThread = Boolean(viewModel.threadKey && !viewModel.threadKey.startsWith('property:'))
  const activeConversation = Boolean(latestAt) && ((inbound ?? 0) > 0
    || ['new_reply', 'active_communication', 'waiting_on_seller'].includes(canonical.status))
  const inOutreach = queued > 0 || scheduled > 0 || (Number.isFinite(nextSendMs) && nextSendMs > Date.now())
  const onHold = canonical.status === 'paused' || canonical.status === 'snoozed' || /pause/i.test(automation ?? '')

  // ── badges (FULL) — each one a fact on the record, never an inference ──
  const badges: DeskBadge[] = []
  if (blocked) badges.push({ key: 'dnc', label: blockReason || 'Outreach suppressed', tone: 'blocker' })
  if (canonical.temperature === 'hot') badges.push({ key: 'hot', label: 'Hot', tone: 'attention' })
  if (confirmed) badges.push({ key: 'verified', label: 'Ownership confirmed', tone: 'verified' })
  if (activeConversation) badges.push({ key: 'conversation', label: 'Active conversation', tone: 'active' })
  if (inOutreach) badges.push({ key: 'outreach', label: 'In outreach queue', tone: 'system' })
  if (onHold) badges.push({ key: 'hold', label: 'On hold', tone: 'neutral' })
  if (outOfState) badges.push({ key: 'oos', label: 'Out-of-state owner', tone: 'value' })
  else if (absentee) badges.push({ key: 'absentee', label: 'Absentee owner', tone: 'value' })
  for (const signal of viewModel.weightedSignals) {
    if (signal.key === 'free_and_clear' || signal.key === 'high_equity') badges.push({ key: signal.key, label: signal.label, tone: 'value' })
    else if (DISTRESS_KEYS.has(signal.key)) badges.push({ key: signal.key, label: signal.label, tone: 'attention' })
  }

  // ── contactability, stated only as far as the record supports it ──
  const contactFact: DeskFact = blocked
    ? { key: 'contact', label: 'Contactability', value: blockReason || canonical.contactabilityLabel, sub: 'Outreach suppressed', tone: 'blocker' }
    : phones.length === 0
      ? { key: 'contact', label: 'Contactability', value: null, missing: 'No phone on record', sub: smsEligible === false ? 'Not SMS-eligible' : null }
      : {
        key: 'contact',
        label: 'Contactability',
        value: smsEligible === false ? 'SMS ineligible' : 'SMS ready',
        sub: `${phones.length} phone${phones.length === 1 ? '' : 's'} · ${phones[0].display}`,
        tone: smsEligible === false ? 'attention' : 'verified',
      }

  // A dated sale with no recorded price is still a sale: never say "none on record" above its date.
  const saleMissing = dossierReady ? (saleDate ? 'Price not recorded' : 'No sale on record') : 'Loads with the record'
  const lienSub = dossierReady ? (activeLien ? 'Active lien on record' : 'No lien flag on record') : null
  const tiles: DeskFact[] = [
    { key: 'value', label: 'Est. value', value: money(estimated), sub: input.pricePerSqft ? `${formatMoney(input.pricePerSqft)} / sqft` : null, tone: 'value', missing: 'No valuation on record' },
    { key: 'equity', label: 'Equity', value: equityPct == null ? null : formatPercent(equityPct), sub: money(equityAmt), tone: 'value', missing: 'Not on record' },
    { key: 'sale', label: 'Last sale', value: money(saleAmount), sub: saleDate ? formatDate(saleDate) : null, dossier: true, missing: saleMissing },
    { key: 'debt', label: 'Loans · liens', value: money(loan), sub: lienSub, tone: activeLien && dossierReady ? 'attention' : undefined, dossier: true, missing: dossierReady ? (activeLien ? 'Lien on record' : 'No balance on record') : 'Loads with the record' },
    {
      key: 'ownership',
      label: 'Ownership',
      value: yearsOwned ? `${formatInteger(yearsOwned)} yrs` : null,
      sub: [ownerKind, outOfState ? 'Out-of-state' : absentee ? 'Absentee' : null].filter(Boolean).join(' · ') || null,
      missing: 'Tenure not on record',
    },
    contactFact,
  ]

  const acquisitionScore = nOrNull(record.final_acquisition_score)
  const motivation = nOrNull(record.motivation_score)
  const priority = viewModel.masterOwner.priorityScore
  const kpis: DeskFact[] = [
    { key: 'value', label: 'Est. value', value: money(estimated), sub: input.pricePerSqft ? `${formatMoney(input.pricePerSqft)} / sqft` : null, tone: 'value', missing: 'Not on record' },
    { key: 'equity', label: 'Equity', value: equityPct == null ? null : formatPercent(equityPct), sub: money(equityAmt), tone: 'value', missing: 'Not on record' },
    { key: 'loan', label: 'Loan balance', value: money(loan), sub: lienSub, dossier: true, missing: dossierReady ? 'None on record' : 'Loads with the record' },
    { key: 'sale', label: 'Last sale', value: money(saleAmount), sub: saleDate ? formatDate(saleDate) : null, dossier: true, missing: saleMissing },
    { key: 'repairs', label: 'Repairs est.', value: money(repairs), missing: 'Not on record' },
    acquisitionScore != null
      ? { key: 'score', label: 'Acquisition score', value: formatInteger(acquisitionScore), sub: motivation != null ? `Motivation ${formatInteger(motivation)}` : null, tone: 'active' }
      : { key: 'score', label: 'Owner priority', value: priority != null ? formatInteger(priority) : null, sub: str(record, ['owner_priority_tier']) ? titleize(text(record.owner_priority_tier).toLowerCase()) : null, missing: 'Unscored' },
  ]

  // ── next recommended action: the canonical action bar, phrased ──
  const primary = viewModel.actionBar.primary
  let nextAction: SellerDeskModel['nextAction']
  if (blocked) {
    nextAction = { label: 'Outreach suppressed', detail: blockReason, tone: 'blocker' }
  } else if (primary.action === 'reply') {
    nextAction = { label: 'Reply to the seller', detail: str(record, ['last_inbound_text'])?.slice(0, 120) ?? null, tone: 'active' }
  } else if (primary.action === 'ownership_check' && primary.enabled) {
    nextAction = { label: 'Send the ownership check', detail: 'First touch — confirms who owns it', tone: 'value' }
  } else if (primary.action === 'follow_up' && primary.enabled) {
    nextAction = { label: 'Send the follow-up', detail: 'Follow-up is due', tone: 'attention' }
  } else if (Number.isFinite(nextSendMs) && nextSendMs > Date.now() && nextSend) {
    nextAction = { label: 'Next touch is scheduled', detail: formatWhen(nextSend), tone: 'system' }
  } else {
    nextAction = { label: 'Nothing due', detail: primary.disabledReason, tone: 'neutral' }
  }

  const conversationFact: DeskFact = latestAt
    ? {
      key: 'conversation',
      label: 'Conversation',
      value: `${latestDirection === 'inbound' ? 'Seller replied' : 'Last sent'} ${formatRelativeTime(latestAt)}`,
      sub: [inbound != null ? `${formatInteger(inbound)} in` : null, outbound != null ? `${formatInteger(outbound)} out` : null].filter(Boolean).join(' · ') || null,
      tone: activeConversation ? 'active' : undefined,
    }
    : { key: 'conversation', label: 'Conversation', value: null, missing: 'No messages yet' }

  const outreachFact: DeskFact = inOutreach
    ? {
      key: 'outreach',
      label: 'Outreach queue',
      value: [scheduled ? `${scheduled} scheduled` : null, queued ? `${queued} queued` : null].filter(Boolean).join(' · ') || 'Scheduled',
      sub: nextSend && Number.isFinite(nextSendMs) && nextSendMs > Date.now() ? `Next send ${formatWhen(nextSend)}` : null,
      tone: 'system',
    }
    : { key: 'outreach', label: 'Outreach queue', value: null, missing: 'Not in an outreach queue' }

  const acquisition: DeskFact[] = [
    confirmed
      ? { key: 'owner', label: 'Ownership', value: 'Confirmed in conversation', sub: `Stage ${stageN} · ${meta.label}`, tone: 'verified' }
      : { key: 'owner', label: 'Ownership', value: 'Not yet confirmed', sub: 'Stage 1 · Ownership check' },
    contactName
      ? { key: 'person', label: 'Contact', value: contactName, sub: smsEligible === true ? 'SMS-eligible' : smsEligible === false ? 'Not SMS-eligible' : null, tone: smsEligible === false ? 'attention' : undefined }
      : { key: 'person', label: 'Contact', value: null, missing: 'Contact person unresolved' },
    { key: 'phones', label: 'Phones', value: phones[0]?.display ?? null, sub: phones.length > 1 ? `+${phones.length - 1} more` : null, missing: 'No phone on record' },
    { key: 'email', label: 'Email', value: email, missing: thread.context ? 'No email on file' : 'Not on the map record' },
    conversationFact,
    outreachFact,
  ]

  // ── executive summary: a sentence of facts, nothing else ──
  const assetLabel = viewModel.property.assetType
  const place = market || locality
  const ownerBit = ownerKnown
    ? `${yearsOwned ? `Owned ${formatInteger(yearsOwned)} yrs by` : 'Owned by'} ${ownerName}${ownerKind ? ` (${ownerKind.toLowerCase()})` : ''}.`
    : 'Owner not on record.'
  const valueBit = estimated
    ? `Est. ${formatMoney(estimated)}${equityPct != null ? ` with ${formatPercent(equityPct)} equity` : ''}.`
    : null
  const statusBit = blocked
    ? `Outreach suppressed${blockReason ? ` (${blockReason})` : ''}.`
    : `${canonical.statusLabel} — next: ${nextAction.label.charAt(0).toLowerCase()}${nextAction.label.slice(1)}.`
  const summary = [
    `${assetLabel}${input.beds ? ` · ${formatInteger(input.beds)} bd` : ''}${place ? ` in ${place}` : ''}.`,
    ownerBit,
    valueBit,
    statusBit,
  ].filter(Boolean).join(' ')

  const mailing = str(record, ['mailing_address_full'])
  const portfolioCount = nOrNull(firstDefined(record, ['property_count', 'portfolio_count', 'owner_property_count']))
  const language = str(record, ['best_language', 'prospect_language_preference'])
  const agent = safeHumanName(text(firstDefined(record, ['agent_persona', 'agent_family']))) || null

  const seller = {
    owner: [
      { key: 'name', label: 'Owner of record', value: ownerKnown ? ownerName : null, sub: ownerKind, missing: 'Not on record' },
      { key: 'mailing', label: 'Mailing address', value: mailing, missing: 'Not on record' },
      { key: 'portfolio', label: 'Portfolio', value: portfolioCount ? `${formatInteger(portfolioCount)} ${portfolioCount === 1 ? 'property' : 'properties'}` : null, sub: money(nOrNull(record.portfolio_total_value)) ? `${money(nOrNull(record.portfolio_total_value))} total value` : null, missing: 'Not on record' },
      { key: 'priority', label: 'Owner priority', value: priority != null ? formatInteger(priority) : null, sub: str(record, ['owner_priority_tier']) ? titleize(text(record.owner_priority_tier).toLowerCase()) : null, missing: 'Unscored' },
      { key: 'language', label: 'Language', value: language ? titleize(language.toLowerCase()) : null, missing: 'Not on record' },
    ] as DeskFact[],
    contact: [
      acquisition[1],
      { key: 'sms', label: 'SMS eligibility', value: smsEligible === true ? 'Eligible' : smsEligible === false ? 'Not eligible' : null, tone: smsEligible === true ? 'verified' : smsEligible === false ? 'attention' : undefined, missing: 'Not on record' },
      ...phones.map((p, i) => ({ key: `phone-${i}`, label: i === 0 ? 'Best phone' : 'Phone', value: p.display })),
      ...(phones.length === 0 ? [{ key: 'phone', label: 'Phone', value: null, missing: 'No phone on record' } as DeskFact] : []),
      acquisition[3],
    ] as DeskFact[],
    occupancy: [
      { key: 'oos', label: 'Owner location', value: outOfState ? 'Out-of-state owner' : absentee ? 'Absentee owner' : null, tone: outOfState || absentee ? 'value' : undefined, dossier: true, missing: dossierReady ? 'No absentee flag on record' : 'Loads with the record' },
      { key: 'tenure', label: 'Tenure', value: yearsOwned ? `${formatInteger(yearsOwned)} yrs owned` : null, missing: 'Not on record' },
      { key: 'use', label: 'Occupancy', value: null, missing: 'Occupancy is not on the record' },
    ] as DeskFact[],
    automation: [
      { key: 'state', label: 'Automation', value: automation ? titleize(automation.toLowerCase()) : null, tone: automation ? 'system' : undefined, missing: 'Not in automation' },
      { key: 'status', label: 'Status', value: canonical.statusLabel },
      { key: 'next', label: 'Next touch', value: nextSend && Number.isFinite(nextSendMs) ? formatWhen(nextSend) : null, missing: 'Nothing scheduled' },
      { key: 'agent', label: 'Sending persona', value: agent, missing: 'Not assigned' },
    ] as DeskFact[],
    compliance: [
      blocked
        ? { key: 'dnc', label: 'Suppression', value: blockReason || 'Suppressed', tone: 'blocker', sub: 'No outreach will be sent' }
        : { key: 'dnc', label: 'Suppression', value: 'None on record', tone: 'verified' },
      { key: 'contactability', label: 'Contactability', value: canonical.contactabilityLabel, tone: blocked ? 'blocker' : undefined },
    ] as DeskFact[],
  }

  const deal = {
    valuation: [
      { key: 'value', label: 'Est. value', value: money(estimated), tone: 'value', missing: 'Not on record' },
      { key: 'equity-amt', label: 'Equity', value: money(equityAmt), sub: equityPct != null ? formatPercent(equityPct) : null, tone: 'value', missing: 'Not on record' },
      { key: 'repairs', label: 'Repairs est.', value: money(repairs), missing: 'Not on record' },
      { key: 'loan', label: 'Loan balance', value: money(loan), dossier: true, missing: dossierReady ? 'None on record' : 'Loads with the record' },
      { key: 'ppsf', label: 'Value / sqft', value: input.pricePerSqft ? formatMoney(input.pricePerSqft) : null, missing: 'Not derivable' },
    ] as DeskFact[],
    scores: [
      { key: 'acq', label: 'Acquisition score', value: acquisitionScore != null ? formatInteger(acquisitionScore) : null, tone: acquisitionScore != null ? 'active' : undefined, missing: 'Unscored' },
      { key: 'motivation', label: 'Motivation', value: motivation != null ? formatInteger(motivation) : null, missing: 'Unscored' },
      { key: 'priority', label: 'Owner priority', value: priority != null ? formatInteger(priority) : null, missing: 'Unscored' },
    ] as DeskFact[],
  }

  const lot = input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : input.lotSqft != null ? `${formatInteger(input.lotSqft)} sqft` : null
  const subject: DeskFact[] = [
    { key: 'asset', label: 'Asset', value: assetLabel },
    { key: 'beds', label: 'Beds · baths', value: input.beds || input.baths ? `${input.beds != null ? formatInteger(input.beds) : '—'} bd · ${input.baths != null ? formatDecimal(input.baths, 1) : '—'} ba` : null, missing: 'Not on record' },
    { key: 'sqft', label: 'Building', value: input.sqft ? `${formatInteger(input.sqft)} sqft` : null, missing: 'Not on record' },
    { key: 'year', label: 'Year built', value: input.yearBuilt ? String(input.yearBuilt) : null, missing: 'Not on record' },
    { key: 'lot', label: 'Lot', value: lot, missing: 'Not on record' },
    { key: 'units', label: 'Units', value: input.units && input.units > 1 ? formatInteger(input.units) : null, missing: 'Single unit' },
  ]
  const marketFacts: DeskFact[] = [
    { key: 'mls', label: 'MLS status', value: str(record, ['mls_market_status']) ? titleize(text(record.mls_market_status).toLowerCase()) : null, dossier: true, missing: dossierReady ? 'Not listed' : 'Loads with the record' },
    { key: 'list', label: 'List price', value: money(nOrNull(record.mls_current_listing_price)), dossier: true, missing: dossierReady ? 'Not listed' : 'Loads with the record' },
    { key: 'mls-sold', label: 'MLS sold', value: money(nOrNull(record.mls_sold_price)), sub: str(record, ['mls_sold_date']) ? formatDate(text(record.mls_sold_date)) : null, dossier: true, missing: dossierReady ? (str(record, ['mls_sold_date']) ? 'Price not recorded' : 'None on record') : 'Loads with the record' },
    { key: 'last-sale', label: 'Last sale', value: money(saleAmount), sub: saleDate ? formatDate(saleDate) : null, dossier: true, missing: saleMissing },
  ]

  const queueItems = thread.context?.queueContext?.items ?? []
  const outreach: DeskFact[] = [
    outreachFact,
    { key: 'automation', label: 'Automation', value: automation ? titleize(automation.toLowerCase()) : null, tone: automation ? 'system' : undefined, missing: 'Not in automation' },
    { key: 'sent', label: 'Sent · delivered', value: nOrNull(record.sent_count) != null || nOrNull(record.delivered_count) != null ? `${formatInteger(nOrNull(record.sent_count) ?? 0)} sent · ${formatInteger(nOrNull(record.delivered_count) ?? 0)} delivered` : null, missing: 'Nothing sent yet' },
    ...queueItems.slice(0, 4).map((item, i) => ({
      key: `queue-${item.id || i}`,
      label: 'Queue item',
      value: titleize(String(item.status || 'queued').toLowerCase()),
      sub: item.scheduleAt ? formatWhen(item.scheduleAt) : null,
      tone: 'system' as DeskTone,
    })),
  ]

  const messages = thread.messages ?? []
  const events = [...messageEvents(messages), ...recordEvents(record, dossierReady, messages.length > 0)]
    .sort((a, b) => b.atMs - a.atMs)

  const ai = thread.context?.aiContext
  const aiBrief = ai && text(ai.summary) ? text(ai.summary) : null

  const threadKey = hasRealThread ? viewModel.threadKey : null
  const prospectId = str(record, ['prospect_id'])

  return {
    identity: {
      line1,
      locality,
      market,
      zip,
      full,
      ownerName,
      ownerKnown,
      ownerKind,
      ownerIsEntity,
      contactName,
      mailingAddress: mailing,
    },
    factLine: viewModel.assetSummaryLine && viewModel.assetSummaryLine !== '—' ? viewModel.assetSummaryLine : null,
    assetLabel,
    value: {
      estimated: money(estimated),
      equityPct: equityPct == null ? null : formatPercent(equityPct),
      equityAmt: money(equityAmt),
      perSqft: input.pricePerSqft ? formatMoney(input.pricePerSqft) : null,
    },
    stage: {
      code: stageCode,
      n: stageN,
      label: meta.label,
      color: meta.color,
      statusCode: canonical.status,
      statusLabel: canonical.statusLabel,
      temperature: canonical.temperature,
      temperatureLabel: canonical.temperatureLabel,
      contactabilityLabel: canonical.contactabilityLabel,
      blocked,
      blockReason,
    },
    rail: stageRail(stageCode),
    badges,
    tiles,
    kpis,
    acquisition,
    nextAction,
    summary,
    phones,
    email,
    seller,
    deal,
    subject,
    market: marketFacts,
    outreach,
    graph: {
      owner: { id: viewModel.masterOwner.id, label: ownerKnown ? ownerName : 'Owner not on record', sub: [ownerKind, portfolioCount ? `${formatInteger(portfolioCount)} properties` : null].filter(Boolean).join(' · ') || null },
      property: { id: viewModel.propertyId, label: line1, sub: [assetLabel, zip].filter(Boolean).join(' · ') || null },
      contact: { id: prospectId, label: contactName, sub: smsEligible === true ? 'SMS-eligible' : smsEligible === false ? 'Not SMS-eligible' : null },
      phones: phones.map((p) => p.display),
      thread: threadKey,
      portfolio: portfolioCount && portfolioCount > 1 ? `${formatInteger(portfolioCount)} properties` : null,
    },
    events,
    aiBrief,
    links: { propertyId: viewModel.propertyId, threadKey, masterOwnerId: viewModel.masterOwner.id, prospectId },
    dossierReady,
    hasRealThread,
  }
}

/* ── PREVIEW placement: beside the pin, inside the pane ─────────────────── */

export type PreviewPlacement = {
  x: number
  y: number
  width: number
  side: 'right' | 'left' | 'below' | 'above'
  /** The pin has left the visible pane; the capsule is clamped to the edge. */
  detached: boolean
  /** Where the tether meets the capsule, in pane coordinates. */
  tether: { x: number; y: number } | null
}

export const PREVIEW_WIDTH = 376

/**
 * Right of the pin, else left, else below/above — clamped inside the pane
 * with room left for the Map's right-hand instrument capsules.
 */
export const placePreview = (
  anchor: { x: number; y: number } | null,
  pane: { width: number; height: number },
  height: number,
): PreviewPlacement => {
  const GAP = 20
  const safe = { top: 14, left: 14, right: pane.width - 70, bottom: pane.height - 26 }
  const width = Math.max(260, Math.min(PREVIEW_WIDTH, safe.right - safe.left))
  const h = Math.min(height, safe.bottom - safe.top)
  if (!anchor) {
    return { x: safe.left, y: safe.top + 96, width, side: 'right', detached: true, tether: null }
  }
  const { x: ax, y: ay } = anchor
  const detached = ax < 0 || ay < 0 || ax > pane.width || ay > pane.height
  const clampX = (x: number) => Math.min(Math.max(x, safe.left), Math.max(safe.left, safe.right - width))
  const clampY = (y: number) => Math.min(Math.max(y, safe.top), Math.max(safe.top, safe.bottom - h))

  let side: PreviewPlacement['side']
  let x: number
  let y: number
  if (ax + GAP + width <= safe.right) {
    side = 'right'; x = ax + GAP; y = clampY(ay - h * 0.42)
  } else if (ax - GAP - width >= safe.left) {
    side = 'left'; x = ax - GAP - width; y = clampY(ay - h * 0.42)
  } else if (ay + GAP + h <= safe.bottom) {
    side = 'below'; x = clampX(ax - width / 2); y = ay + GAP
  } else {
    side = 'above'; x = clampX(ax - width / 2); y = clampY(ay - GAP - h)
  }
  x = clampX(x)
  const inset = 22
  const tether = detached ? null : side === 'right'
    ? { x, y: Math.min(Math.max(ay, y + inset), y + h - inset) }
    : side === 'left'
      ? { x: x + width, y: Math.min(Math.max(ay, y + inset), y + h - inset) }
      : side === 'below'
        ? { x: Math.min(Math.max(ax, x + inset), x + width - inset), y }
        : { x: Math.min(Math.max(ax, x + inset), x + width - inset), y: y + h }
  return { x, y, width, side, detached, tether }
}

/* ── the remembered tab (survives collapse, expand and the next property) ─ */

const TAB_KEY = 'nexus.smc.desk-tab'
let rememberedTab: DeskTab | null = null

export const readRememberedTab = (): DeskTab => {
  if (rememberedTab) return rememberedTab
  try {
    const stored = typeof window !== 'undefined' ? window.sessionStorage.getItem(TAB_KEY) : null
    if (stored && (FULL_TABS as string[]).includes(stored)) rememberedTab = stored as DeskTab
  } catch { /* storage blocked */ }
  return rememberedTab ?? 'overview'
}

export const rememberTab = (tab: DeskTab) => {
  rememberedTab = tab
  try { window.sessionStorage.setItem(TAB_KEY, tab) } catch { /* storage blocked */ }
}

/** HALF shows the remembered tab when it has one, Overview otherwise. */
export const tabForState = (tab: DeskTab, state: DeskState): DeskTab => (
  state === 'full' ? tab : HALF_TABS.includes(tab) ? tab : 'overview'
)
