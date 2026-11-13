/**
 * CONTEXT CHIPS — the @-context the composer carries for the current page.
 *
 * The page publishes what it is looking at (the shell already does: the
 * property locator, the campaign subject, the Entity Graph selection, the
 * focused app). This model turns ONE page context into removable chips and
 * guarantees isolation: a chip belongs to the context it was derived from
 * (its contextKey). When the page context changes, every auto chip of the
 * old context is gone and the operator's removals reset — nothing from a
 * previous page can ride into the next question. Explicit @-mentions stay
 * only while a draft is being written.
 *
 * What a chip SENDS is exactly what POST /ask accepts (property_ids ≤ 10,
 * one campaign_id). A seller thread is never sent as a phone number: its
 * property rides along, the thread itself stays on the page. A deal's
 * opportunity id is used by Act (pipeline.propose_stage_change) only.
 */
import { MAX_CONTEXT_PROPERTIES, type MentionChip } from '../../agent/ask/ask-model'

export type IcChipKind = 'property' | 'campaign' | 'thread' | 'deal' | 'eg_filter' | 'owner' | 'market' | 'hot_leads'

export interface IcChip {
  key: string
  kind: IcChipKind
  id: string
  label: string
  detail: string | null
  /** property ids this chip contributes to an Ask / Plan */
  property_ids: string[]
  /** derived from the page (true) or mentioned with @ (false) */
  auto: boolean
  /** the page context this chip came from (auto chips only) */
  contextKey: string | null
  /** what reaches the server; null = nothing (shown for the operator only) */
  sends: string | null
}

export interface PageContext {
  /** focused app id (e.g. 'inbox') */
  app: string | null
  appLabel: string | null
  /** the focused pane instance (a second Inbox pane is another context) */
  instanceId: string | null
  property: { id: string | null; address: string | null } | null
  thread: { key: string } | null
  deal: { opportunityId: string } | null
  campaign: { id: string; name: string | null } | null
  selection: { property_ids: string[]; count: number } | null
}

export const EMPTY_PAGE: PageContext = { app: null, appLabel: null, instanceId: null, property: null, thread: null, deal: null, campaign: null, selection: null }

const tail = (v: string) => v.replace(/[^a-z0-9]/gi, '').slice(-4)
export const maskThread = (key: string) => `••${tail(key)}`
const maskId = (id: string) => `••${tail(id)}`

/** A stable identity for "what this page is about". */
export function contextKeyOf(c: PageContext): string {
  return [
    c.app ?? '-', c.instanceId ?? '-',
    c.property?.id ?? c.property?.address ?? '-',
    c.thread ? `t${tail(c.thread.key)}` : '-',
    c.deal?.opportunityId ?? '-',
    c.campaign?.id ?? '-',
    c.selection ? `${c.selection.count}:${c.selection.property_ids.slice(0, 3).join(',')}` : '-',
  ].join('|')
}

/** The auto chips for ONE page context. */
export function chipsForContext(c: PageContext): IcChip[] {
  const key = contextKeyOf(c)
  const out: IcChip[] = []
  const via = c.appLabel ? ` · ${c.appLabel}` : ''
  if (c.selection && c.selection.count > 1) {
    const n = Math.min(c.selection.count, MAX_CONTEXT_PROPERTIES)
    out.push({ key: `eg_filter:${c.selection.property_ids.slice(0, 3).join(',')}:${c.selection.count}`, kind: 'eg_filter', id: 'eg-selection', label: `${c.selection.count} selected`, detail: c.selection.count > MAX_CONTEXT_PROPERTIES ? `Entity Graph selection · first ${n} sent` : 'Entity Graph selection', property_ids: c.selection.property_ids.slice(0, MAX_CONTEXT_PROPERTIES), auto: true, contextKey: key, sends: `${n} property id${n === 1 ? '' : 's'}` })
  } else if (c.property?.id) {
    out.push({ key: `property:${c.property.id}`, kind: 'property', id: c.property.id, label: c.property.address ?? `Property ${maskId(c.property.id)}`, detail: `linked${via}`, property_ids: [c.property.id], auto: true, contextKey: key, sends: 'property id' })
  }
  if (c.thread) {
    const pid = c.property?.id ?? null
    out.push({ key: `thread:${tail(c.thread.key)}`, kind: 'thread', id: `thread:${tail(c.thread.key)}`, label: `Seller thread ${maskThread(c.thread.key)}`, detail: pid ? 'its property is in context · messages stay on the page' : 'not sent: the ask API takes property and campaign context only', property_ids: [], auto: true, contextKey: key, sends: null })
  }
  if (c.deal) {
    out.push({ key: `deal:${c.deal.opportunityId}`, kind: 'deal', id: c.deal.opportunityId, label: `Deal ${maskId(c.deal.opportunityId)}`, detail: 'Act: propose a stage change for approval', property_ids: [], auto: true, contextKey: key, sends: null })
  }
  if (c.campaign) {
    out.push({ key: `campaign:${c.campaign.id}`, kind: 'campaign', id: c.campaign.id, label: c.campaign.name ?? `Campaign ${maskId(c.campaign.id)}`, detail: `open campaign${via}`, property_ids: [], auto: true, contextKey: key, sends: 'campaign id' })
  }
  return out
}

export interface ChipState {
  /** the context the auto chips and removals belong to */
  contextKey: string | null
  /** auto chip keys the operator removed (for this context only) */
  removed: string[]
  /** @-mentioned chips (explicit; they stay with the draft) */
  manual: IcChip[]
}

export const EMPTY_CHIPS: ChipState = { contextKey: null, removed: [], manual: [] }

/**
 * Move the chip state to a page context. A different context resets the
 * removals; auto chips are never stored, they are re-derived from the
 * CURRENT context only — so an old page's chips cannot survive.
 */
export function reconcile(state: ChipState, page: PageContext, draftInProgress = false): ChipState {
  const key = contextKeyOf(page)
  if (state.contextKey === key) return state
  // explicit @-mentions belong to a draft being written; with no draft they go too
  return { contextKey: key, removed: [], manual: draftInProgress ? state.manual : [] }
}

export function visibleChips(state: ChipState, page: PageContext): IcChip[] {
  const key = contextKeyOf(page)
  const removed = state.contextKey === key ? new Set(state.removed) : new Set<string>()
  const auto = chipsForContext(page).filter((c) => !removed.has(c.key))
  const manual = state.manual.filter((m) => !auto.some((a) => a.key === m.key))
  return [...auto, ...manual]
}

export function removeChip(state: ChipState, page: PageContext, chip: IcChip): ChipState {
  const s = reconcile(state, page)
  if (chip.auto) return { ...s, removed: [...new Set([...s.removed, chip.key])] }
  return { ...s, manual: s.manual.filter((m) => m.key !== chip.key) }
}

export function addManual(state: ChipState, chip: IcChip): ChipState {
  if (state.manual.some((m) => m.key === chip.key)) return state
  return { ...state, manual: [...state.manual, { ...chip, auto: false, contextKey: null }] }
}

/** After a send the draft's explicit mentions are consumed. */
export const clearManual = (state: ChipState): ChipState => ({ ...state, manual: [] })

/** The chips the ask composer understands (composeAsk), from what is visible. */
export function toMentionChips(chips: IcChip[]): MentionChip[] {
  const out: MentionChip[] = []
  for (const c of chips) {
    if (c.kind === 'campaign') out.push({ key: c.key, kind: 'campaign', id: c.id, label: c.label, detail: c.detail, property_ids: [] })
    else if (c.kind === 'eg_filter') out.push({ key: c.key, kind: 'selection', id: c.id, label: c.label, detail: c.detail, property_ids: c.property_ids })
    else if (c.kind === 'property' || c.kind === 'owner' || c.kind === 'market' || c.kind === 'hot_leads') out.push({ key: c.key, kind: c.kind, id: c.id, label: c.label, detail: c.detail, property_ids: c.property_ids })
    // thread + deal chips contribute nothing to the ask body (see header)
  }
  return out
}

export function fromMention(m: MentionChip): IcChip {
  const kind: IcChipKind = m.kind === 'selection' ? 'eg_filter' : m.kind
  return { key: m.key, kind, id: m.id, label: m.label, detail: m.detail, property_ids: m.property_ids, auto: false, contextKey: null, sends: m.kind === 'campaign' ? 'campaign id' : m.property_ids.length ? `${m.property_ids.length} property id${m.property_ids.length === 1 ? '' : 's'}` : null }
}
