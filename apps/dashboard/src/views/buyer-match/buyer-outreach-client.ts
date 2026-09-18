/**
 * BUYER OUTREACH — THE CLIENT SIDE OF ONE CANONICAL PATH.
 *
 * Every call here goes to `/api/cockpit/buyer-match/property/{id}/outreach`,
 * which materializes targets and hands execution to the canonical send queue.
 * There is no second path, no direct provider call, and no client-side
 * recipient: the body names buyers by `buyer_key` only, because the server
 * resolves the destination from `buyer_contacts_v2` and discards anything a
 * client sends as a phone number.
 *
 * PREFLIGHT IS NOT COSMETIC. `preflightBuyerOutreach` is the same code path as
 * the commit with `dry_run: true`, so the counts the operator approves are the
 * counts the commit will act on — not an optimistic estimate computed in the
 * browser from different data.
 */
import { callBackend } from '../../lib/api/backendClient'

export interface BuyerOutreachSelection {
  buyer_key: string
  buyer_name?: string | null
  buyer_entity_id?: string | null
  buyer_match_run_id?: string | null
  buyer_match_candidate_id?: string | null
}

export interface BuyerOutreachBlocked extends BuyerOutreachSelection {
  blocked_reason: string
}

export interface BuyerOutreachVerdict {
  ok: boolean
  dry_run: boolean
  selected: number
  eligible: number
  blocked: BuyerOutreachBlocked[]
  targets: Array<{ id?: string; buyer_key: string; send_queue_key?: string | null }>
  /** Present when the whole batch was refused (e.g. suppression unreadable). */
  reason?: string
  detail?: string | null
}

export interface BuyerOutreachTarget {
  id: string
  buyer_key: string
  buyer_name: string | null
  to_phone_number: string | null
  touch_number: number
  status: string
  blocked_reason: string | null
  scheduled_at: string | null
  provider_message_id: string | null
  delivery_status: string | null
  send_queue_key: string | null
  created_at: string
  updated_at: string
}

/** Operator-facing wording for a blocked reason. No reason is left as a raw slug. */
export const BLOCKED_REASON_COPY: Record<string, string> = {
  no_contact_on_record: 'No contact on record',
  buyer_do_not_contact: 'Marked do-not-contact',
  no_phone: 'No phone number',
  suppressed: 'Suppressed',
  duplicate_selection: 'Selected twice',
  duplicate_touch: 'Already has a live touch',
  queue_write_failed: 'Could not be queued',
  outreach_write_failed: 'Could not be recorded',
  missing_buyer_identity: 'Missing buyer identity',
}

export const describeBlockedReason = (reason: string): string =>
  BLOCKED_REASON_COPY[reason] ?? reason.replace(/_/g, ' ')

/** Operator-facing wording for a target's state. Blocked is never shown as failed. */
export const describeOutreachStatus = (target: Pick<BuyerOutreachTarget, 'status' | 'blocked_reason'>): string => {
  switch (target.status) {
    case 'planned': return 'Not yet queued'
    case 'queued': return 'Queued'
    case 'scheduled': return 'Scheduled'
    case 'sending': return 'Sending'
    case 'sent': return 'Sent'
    case 'delivered': return 'Delivered'
    case 'failed': return 'Failed at the carrier'
    case 'cancelled': return 'Cancelled'
    case 'deferred':
      return `Held — ${describeBlockedReason(target.blocked_reason ?? 'held')}`
    case 'blocked':
      return `Blocked — ${describeBlockedReason(target.blocked_reason ?? 'blocked')}`
    default: return target.status
  }
}

const outreachPath = (propertyId: string) =>
  `/api/cockpit/buyer-match/property/${encodeURIComponent(propertyId)}/outreach`

async function post(propertyId: string, body: Record<string, unknown>): Promise<BuyerOutreachVerdict> {
  const res = await callBackend<{ ok?: boolean; data?: BuyerOutreachVerdict; error?: string; detail?: string }>(
    outreachPath(propertyId),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )

  // A transport failure is a failure, never an empty verdict — the operator must
  // not read "0 blocked" when the request never reached the server.
  if (!res.ok) throw new Error(res.message || res.error || 'Buyer outreach request failed')
  if (!res.data) throw new Error('Buyer outreach returned no body')
  if (res.data.ok === false && !res.data.data) {
    throw new Error(res.data.detail || res.data.error || 'Buyer outreach was refused')
  }
  const verdict = res.data.data
  if (!verdict) throw new Error(res.data.error || 'Buyer outreach returned no verdict')
  return verdict
}

export function preflightBuyerOutreach(
  propertyId: string,
  buyers: BuyerOutreachSelection[],
): Promise<BuyerOutreachVerdict> {
  return post(propertyId, { buyers, dry_run: true })
}

export function commitBuyerOutreach(
  propertyId: string,
  buyers: BuyerOutreachSelection[],
  message_body: string,
): Promise<BuyerOutreachVerdict> {
  return post(propertyId, { buyers, message_body, dry_run: false })
}

/** The state the SYSTEM holds, re-read after a commit rather than assumed. */
export async function loadBuyerOutreachTargets(propertyId: string): Promise<BuyerOutreachTarget[]> {
  const res = await callBackend<{ ok?: boolean; data?: { targets: BuyerOutreachTarget[] } }>(
    outreachPath(propertyId),
  )
  if (!res.ok) throw new Error(res.message || res.error || 'Could not read buyer outreach state')
  if (!res.data?.data) throw new Error('Buyer outreach state was unreadable')
  return res.data.data.targets ?? []
}
