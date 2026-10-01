import type { InspectorModel, InspectorRenderer, InspectorTone } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { clip, count, enc, isoOrNull, joinParts, money, present, readInspector, text, when, words } from '../inspector-read'

/**
 * DEAL — GET /api/cockpit/pipeline/command/story/:opportunity_id (Pipeline
 * Command's deal story). Seller money (asking/counter), our offer, the
 * decision engine's recommendation and modeled value are separate rows —
 * never one number.
 */

export interface DealStory {
  card?: {
    id?: string
    stageLabel?: string | null
    daysInStage?: number | null
    status?: string | null
    lane?: { key?: string | null; label?: string | null; detail?: string | null } | null
    intent_next?: { action?: string | null; due?: string | null } | null
    stall?: { label?: string | null } | null
    seller?: string | null
    address?: string | null
    market?: string | null
    propertyType?: string | null
    units?: number | null
    propertyId?: string | null
    masterOwnerId?: string | null
    threadKey?: string | null
    intentLabel?: string | null
    temperature?: string | null
    lastInboundAt?: string | null
    lastMessage?: string | null
    lastDirection?: string | null
    money?: { asking?: number | null; offer?: number | null; counter?: number | null; value?: number | null; equity?: number | null; contractPrice?: number | null; buyerPrice?: number | null; askImplausible?: boolean; counterImplausible?: boolean } | null
    closing?: { id?: string | null } | null
  } | null
  story?: Array<{ at?: string | null; kind?: string | null; title?: string | null }> | null
  negotiation?: { recommended?: number | null } | null
  decision?: { tier?: string | null; strategy?: string | null; confidence?: number | null; computedAt?: string | null } | null
  disposition?: { matched?: number | null } | null
}

const LANE_TONE: Record<string, InspectorTone> = { operator: 'attention', blocked: 'crit', system: 'live', complete: 'ok', closed_out: 'neutral' }
const NEXT: Record<string, string> = { human_review: 'Your review', wait_for_seller: 'Wait for the seller', send_offer: 'Send the offer', follow_up: 'Follow up' }

export function shapeDeal(d: DealStory, ref: EntityRef): InspectorModel {
  const c = d.card ?? {}
  const id = text(c.id) ?? ref.id
  const address = text(c.address) ?? text(ref.label)
  const m = c.money ?? {}
  const next = c.intent_next?.action ? joinParts([NEXT[c.intent_next.action] ?? words(c.intent_next.action), c.intent_next.due ? when(c.intent_next.due) : null]) : null
  const reply = c.lastDirection === 'inbound' ? clip(text(c.lastMessage), 140) : null

  const relations: InspectorModel['relations'] = []
  if (c.propertyId) relations.push({ label: 'Property', ref: { type: 'property', id: c.propertyId, label: address, hint: { property_id: c.propertyId, thread_key: c.threadKey ?? null, opportunity_id: id } } })
  if (c.threadKey) relations.push({ label: 'Seller', ref: { type: 'seller', id: c.threadKey, label: text(c.seller), hint: { thread_key: c.threadKey, property_id: c.propertyId ?? null } } })
  if (c.closing?.id) relations.push({ label: 'Closing', ref: { type: 'closing', id: c.closing.id, label: address } })

  const open = [{ label: 'Pipeline', path: `/pipeline?opp=${enc(id)}` }]
  if (c.propertyId) open.push({ label: 'Deal Intelligence', path: `/deal-intelligence?property_id=${enc(c.propertyId)}` })
  if (c.threadKey) open.push({ label: 'Inbox', path: `/inbox?thread=${enc(c.threadKey)}` })

  return {
    title: address ?? 'Deal',
    subtitle: text(c.seller),
    eyebrow: joinParts([text(c.market), text(c.stageLabel)]),
    status: c.lane?.label ? { label: c.lane.label, tone: LANE_TONE[c.lane.key ?? ''] ?? 'neutral' } : null,
    facts: present([
      { label: 'Why', value: text(c.lane?.detail) },
      { label: 'Next', value: next },
      { label: 'In stage', value: c.daysInStage != null ? joinParts([count(c.daysInStage, 'day'), text(c.stall?.label)]) : null },
      { label: 'Seller intent', value: text(c.intentLabel) },
      { label: 'Latest reply', value: joinParts([when(c.lastInboundAt), reply ? `“${reply}”` : null]) },
      { label: 'Property', value: joinParts([text(c.propertyType), c.units && c.units > 1 ? count(c.units, 'unit') : null]) },
      { label: 'Strategy', value: d.decision?.tier ? joinParts([words(d.decision.tier), words(d.decision.strategy)]) : null },
      { label: 'Buyers matched', value: d.disposition?.matched ? count(d.disposition.matched) : null },
    ]),
    value: present([
      { label: 'Seller asking', value: money(m.asking), hint: m.askImplausible ? 'Looks implausible — check the conversation' : 'Stated by seller' },
      { label: 'Seller counter', value: money(m.counter), hint: m.counterImplausible ? 'Looks implausible — check the conversation' : 'Stated by seller' },
      { label: 'Our offer', value: money(m.offer), hint: 'Sent' },
      { label: 'Recommended offer', value: money(d.negotiation?.recommended), hint: d.decision?.computedAt ? `Decision engine · ${when(d.decision.computedAt)}` : 'Decision engine' },
      { label: 'Estimated value', value: money(m.value), hint: 'Modeled' },
      { label: 'Equity', value: money(m.equity), hint: 'Modeled' },
      { label: 'Contract price', value: money(m.contractPrice), hint: 'Contract' },
      { label: 'Buyer price', value: money(m.buyerPrice), hint: 'Buyer offer' },
    ]),
    relations,
    activity: (d.story ?? []).filter((e) => e.kind !== 'now' && isoOrNull(e.at) && e.title).reverse().slice(0, 6).map((e) => ({ at: e.at as string, text: e.title as string })),
    open,
    mission: { label: address ?? 'Deal', opportunityId: id, propertyId: c.propertyId ?? null, threadKey: c.threadKey ?? null, masterOwnerId: c.masterOwnerId ?? null, closingId: c.closing?.id ?? null, address },
    // the envelope replays a deal through its seller conversation
    replay: c.threadKey ? { type: 'seller', id: c.threadKey, label: text(c.seller) ?? address } : c.propertyId ? { type: 'property', id: c.propertyId, label: address } : null,
    freshness: null,
  }
}

export const dealInspector: InspectorRenderer = {
  type: 'deal',
  noun: 'Deal',
  glyph: 'trending-up',
  load: async (ref, signal) => {
    const body = await readInspector<{ data: DealStory }>(`/api/cockpit/pipeline/command/story/${enc(ref.id)}`, signal)
    return shapeDeal(body.data ?? {}, ref)
  },
}
