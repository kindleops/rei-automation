/**
 * A QUEUE ROW IS NOT ALWAYS A SELLER (§10, §11).
 *
 * `send_queue` now carries two kinds of traffic. Seller outreach is a
 * conversation with a homeowner; buyer disposition outreach is a message to an
 * investor about a property. They share transport and nothing else.
 *
 * Every Queue surface resolves the row's person through `resolveSellerIdentity`,
 * which walks seller name sources and lands on "Unknown owner" when none
 * resolve. On a buyer row that is not a degraded read — there IS no owner —
 * and showing it would tell an operator the system lost a seller's identity
 * when it never had one. It would also invite the wrong action: seller stages,
 * seller follow-up, seller suppression.
 *
 * This is the one place that answers "whose row is this", so the Queue list,
 * sheet and inspector agree without three copies of the check.
 */
import type { QueueItem } from '../../domain/queue/queue.types'

export type OutreachDomain = 'seller' | 'buyer'

export interface QueueOutreachIdentity {
  domain: OutreachDomain
  /** The party the message goes to, in the terms of that party's world. */
  name: string
  /** What kind of party it is, for a badge. */
  label: string
  /** The property the message is ABOUT — the subject for a buyer, the asset for a seller. */
  subjectPropertyId: string | null
}

const clean = (value: unknown): string => String(value ?? '').trim()

const metadataOf = (item: QueueItem): Record<string, unknown> =>
  item.metadata && typeof item.metadata === 'object' ? (item.metadata as Record<string, unknown>) : {}

/**
 * Mirrors the server-side `isBuyerDispositionSend` exactly — send kind on the
 * row, send kind in metadata, or an explicit buyer outreach domain. Kept in
 * step with it deliberately: if the two ever disagree, a live buyer row renders
 * as a seller, which is the failure this whole module exists to prevent.
 */
export function isBuyerQueueRow(item: QueueItem): boolean {
  const md = metadataOf(item)
  const kinds = [
    clean((item as unknown as { sendKind?: unknown }).sendKind).toLowerCase(),
    clean(md.send_kind).toLowerCase(),
  ]
  return kinds.includes('buyer_disposition') || clean(md.outreach_domain).toLowerCase() === 'buyer'
}

export function resolveQueueOutreachIdentity(item: QueueItem): QueueOutreachIdentity | null {
  if (!isBuyerQueueRow(item)) return null
  const md = metadataOf(item)
  const name = clean(md.buyer_name) || clean(md.buyer_key) || 'Unidentified buyer'
  return {
    domain: 'buyer',
    name,
    label: 'Buyer',
    subjectPropertyId: clean(md.subject_property_id) || clean(item.linkedPropertyId) || null,
  }
}

/**
 * What this row is FOR, in one line. A seller row's purpose is its touch in an
 * acquisition conversation; a buyer row's purpose is dispositioning a specific
 * property, so the property is the headline rather than an attribute.
 */
export function describeBuyerQueueRow(item: QueueItem): string | null {
  const identity = resolveQueueOutreachIdentity(item)
  if (!identity) return null
  const md = metadataOf(item)
  const touch = Number(md.touch_number ?? item.touchNumber ?? 0)
  const about = identity.subjectPropertyId ? `about ${identity.subjectPropertyId}` : 'about an unnamed property'
  return touch > 1 ? `Buyer outreach ${about} · touch ${touch}` : `Buyer outreach ${about}`
}
