import type { InspectorModel, InspectorRenderer, InspectorTone } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { clip, enc, isoOrNull, joinParts, money, present, readInspector, text, when, words } from '../inspector-read'

/**
 * CLOSING — GET /api/cockpit/closing-desk/execution/:id (`closing:<uuid>` or
 * an opportunity uuid). The Closing Desk's transaction room, condensed: state,
 * whose move it is, readiness, the date, and money kept as expected vs actual
 * (never collapsed). S10 stays with finalize_closing_case — nothing here acts.
 */

interface Money { value?: number | null; basis?: string | null }
export interface ClosingRoom {
  id?: string
  opportunityId?: string | null
  propertyId?: string | null
  masterOwnerId?: string | null
  threadKey?: string | null
  property?: { address?: string | null } | null
  market?: string | null
  seller?: { name?: string | null } | null
  stage?: { code?: string | null; label?: string | null } | null
  state?: { key?: string | null; label?: string | null; tone?: string | null } | null
  closing?: { at?: string | null; date?: string | null; confirmed?: boolean | null; daysOut?: number | null; past?: boolean | null } | null
  readiness?: { met?: number | null; total?: number | null } | null
  ball?: { owner?: string | null; ownerLabel?: string | null; what?: string | null; why?: string | null } | null
  blockers?: Array<{ what?: string | null }> | null
  cancellation?: { label?: string | null; at?: string | null; reason?: string | null } | null
  buyer?: { name?: string | null; committed?: boolean | null; selected?: boolean | null } | null
  title?: { company?: string | null } | null
  contract?: { status?: string | null; executedAt?: string | null } | null
  money?: { estimated?: { contractPrice?: Money | null; buyerPrice?: Money | null; assignmentFee?: Money | null } | null; comparison?: Array<{ key?: string; label?: string; expected?: number | null; actual?: number | null }> | null } | null
  timeline?: Array<{ at?: string | null; label?: string | null }> | null
  updatedAt?: string | null
}

const TONE: Record<string, InspectorTone> = { terminated: 'neutral', closed: 'ok', blocked: 'crit', ready: 'ok', attention: 'attention', active: 'live', external: 'neutral' }
const OWNER: Record<string, string> = { you: 'You', system: 'System', seller: 'Seller', buyer: 'Buyer', title: 'Title' }

export function shapeClosing(c: ClosingRoom, ref: EntityRef): InspectorModel {
  const id = text(c.id) ?? ref.id
  const address = text(c.property?.address) ?? text(ref.label)
  const est = c.money?.estimated ?? {}
  const closeAt = c.closing ? joinParts([when(c.closing.date ?? c.closing.at), c.closing.confirmed ? 'confirmed' : 'not confirmed', c.closing.past ? 'date passed' : null]) : null
  const owner = c.ball?.owner ? c.ball.ownerLabel ?? OWNER[c.ball.owner] ?? words(c.ball.owner) : null

  const relations: InspectorModel['relations'] = []
  if (c.propertyId) relations.push({ label: 'Property', ref: { type: 'property', id: c.propertyId, label: address, hint: { property_id: c.propertyId, thread_key: c.threadKey ?? null } } })
  if (c.threadKey) relations.push({ label: 'Seller', ref: { type: 'seller', id: c.threadKey, label: text(c.seller?.name), hint: { thread_key: c.threadKey, property_id: c.propertyId ?? null } } })
  if (c.opportunityId) relations.push({ label: 'Deal', ref: { type: 'deal', id: c.opportunityId, label: address } })

  const actual = (c.money?.comparison ?? []).filter((r) => r.actual != null)

  return {
    title: address ?? 'Closing',
    eyebrow: joinParts([text(c.market), joinParts([text(c.stage?.code), text(c.stage?.label)], ' ')]),
    status: c.state?.label ? { label: c.state.label, tone: TONE[c.state.tone ?? ''] ?? 'neutral' } : null,
    facts: present([
      { label: 'Next move', value: joinParts([owner, text(c.ball?.what)], ' — ') },
      { label: 'Why', value: clip(text(c.ball?.why), 160) },
      { label: 'Blocked by', value: c.blockers?.length ? c.blockers.map((b) => text(b.what)).filter(Boolean).join('; ') : null },
      { label: 'Closing date', value: closeAt },
      { label: 'Ready', value: c.readiness?.total ? `${c.readiness.met ?? 0} of ${c.readiness.total} requirements met` : null },
      { label: 'Contract', value: joinParts([words(c.contract?.status), c.contract?.executedAt ? `executed ${when(c.contract.executedAt)}` : null]) },
      { label: 'Buyer', value: c.buyer?.name ? joinParts([c.buyer.name, c.buyer.committed ? 'committed' : c.buyer.selected ? 'selected' : null]) : null },
      { label: 'Title', value: text(c.title?.company) },
      { label: 'Cancelled', value: c.cancellation ? joinParts([text(c.cancellation.label), when(c.cancellation.at), clip(text(c.cancellation.reason), 120)]) : null },
    ]),
    value: present([
      { label: 'Contract price · expected', value: money(est.contractPrice?.value), hint: text(est.contractPrice?.basis) ?? undefined },
      { label: 'Buyer price · expected', value: money(est.buyerPrice?.value), hint: text(est.buyerPrice?.basis) ?? undefined },
      { label: 'Assignment fee · expected', value: money(est.assignmentFee?.value), hint: text(est.assignmentFee?.basis) ?? undefined },
      ...actual.map((r) => ({ label: `${r.label ?? words(r.key)} · actual`, value: money(r.actual), hint: 'Settlement record' })),
    ]),
    relations,
    activity: [...(c.timeline ?? [])].filter((e) => isoOrNull(e.at) && e.label).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6).map((e) => ({ at: e.at as string, text: clip(text(e.label), 140) as string })),
    open: [{ label: 'Closing Desk', path: `/closing-desk?case=${enc(id)}` }],
    mission: { label: address ?? 'Closing', closingId: id, propertyId: c.propertyId ?? null, threadKey: c.threadKey ?? null, opportunityId: c.opportunityId ?? null, masterOwnerId: c.masterOwnerId ?? null, address },
    replay: { type: 'closing', id, label: address },
    freshness: c.updatedAt ? `Closing record updated ${when(c.updatedAt)}` : null,
  }
}

export const closingInspector: InspectorRenderer = {
  type: 'closing',
  noun: 'Closing',
  glyph: 'key',
  load: async (ref, signal) => {
    const body = await readInspector<{ data: { closing: ClosingRoom } }>(`/api/cockpit/closing-desk/execution/${enc(ref.id)}`, signal)
    return shapeClosing(body.data?.closing ?? {}, ref)
  },
}
