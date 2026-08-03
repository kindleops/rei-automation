/**
 * Projection from Deal Desk thread rows into the pure selection model.
 *
 * Keeps `deal-desk-selection.ts` free of application types so its transition table stays
 * testable under `node --test`, while giving the React layer one place that knows how a
 * live inbox row maps onto `DealDeskSelectionCandidate`.
 *
 * Identity rules (mirrors `canonical-thread-reference.ts`):
 *   - `propertyId`, `prospectId` and `ownerId` are read only from their own fields.
 *     A phone is never promoted to a property id; an owner display name is never
 *     promoted to a prospect id.
 *   - A missing identity stays an explicit `null`.
 */

import { resolveDealDeskThreadReference } from './deal-desk-thread-reference'
import type { DealDeskSelectionCandidate } from './deal-desk-selection'

/** Accepts declared interfaces (`InboxWorkflowThread`) as well as loose records. */
type ThreadLike = object | null | undefined

const readId = (thread: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = String(thread[key] ?? '').trim()
    if (value) return value
  }
  return null
}

const PROPERTY_ID_FIELDS = ['propertyId', 'property_id'] as const
const PROSPECT_ID_FIELDS = ['prospectId', 'prospect_id', 'canonical_prospect_id'] as const
const OWNER_ID_FIELDS = ['ownerId', 'owner_id', 'masterOwnerId', 'master_owner_id'] as const
const BUCKET_FIELDS = ['inboxBucket', 'inbox_bucket'] as const

/**
 * Project a thread row into a selection candidate.
 * Returns null when the row carries no usable identity — callers must treat that as
 * "not selectable", never as a selection with an empty key.
 */
export const toSelectionCandidate = (
  thread: ThreadLike,
  bucketOverride?: string | null,
): DealDeskSelectionCandidate | null => {
  if (!thread) return null
  const reference = resolveDealDeskThreadReference(thread)
  if (!reference) return null
  const record = thread as unknown as Record<string, unknown>
  return {
    reference,
    propertyId: readId(record, PROPERTY_ID_FIELDS),
    prospectId: readId(record, PROSPECT_ID_FIELDS),
    ownerId: readId(record, OWNER_ID_FIELDS),
    inboxBucket: bucketOverride ?? readId(record, BUCKET_FIELDS),
  }
}

/** Project a list of rows, dropping any that carry no usable identity. */
export const toSelectionCandidates = (
  threads: readonly ThreadLike[],
  bucketOverride?: string | null,
): DealDeskSelectionCandidate[] => {
  const out: DealDeskSelectionCandidate[] = []
  for (const thread of threads) {
    const candidate = toSelectionCandidate(thread, bucketOverride)
    if (candidate) out.push(candidate)
  }
  return out
}
