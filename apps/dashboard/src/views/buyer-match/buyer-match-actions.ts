/**
 * BUYER MATCH DISPOSITION — ONE WRITE AUTHORITY.
 *
 * BUYER-MATCH-MOBILE-LOCK-1 §13. The disposition writes lived inline in
 * BuyerMatchWorkspace, so exposing them on mobile would have meant a second
 * copy of the same update — a forked authority over buyer disposition. They are
 * extracted here unchanged instead, and both surfaces call these.
 *
 * WHAT IS DELIBERATELY ABSENT: `sendPackage`.
 *
 * The workspace's "📤 Send Package" button transmits NOTHING. It writes
 * `package_sent_at` and `buyer_response_status: 'package_sent'` to
 * `buyer_match_candidates` and stops — no email, no SMS, no messaging
 * infrastructure, and therefore no DNC or suppression check. The label claims
 * an outreach that never happens.
 *
 * On a desktop surface that behaviour is pre-existing and left untouched. It is
 * NOT carried onto mobile: putting a button under the operator's thumb that
 * reports a package was sent to a buyer, when nothing left the building, would
 * manufacture evidence of outreach. Real buyer outreach has to go through the
 * existing messaging/email path with suppression applied, which is a send
 * authority this phase does not build.
 *
 * Every function here reports its error rather than swallowing it — the inline
 * version discarded the error and left the row looking unchanged, which reads
 * to the operator as "nothing happened" whether the write failed or not.
 */

import { getSupabaseClient } from '../../lib/supabaseClient'

export type BuyerDisposition = 'interested' | 'passed'

export interface BuyerActionResult {
  ok: boolean
  /** The fields that were actually written, for optimistic local merge. */
  updates: Record<string, unknown>
  message?: string
}

const TABLE = 'buyer_match_candidates'
const ID = 'buyer_match_candidate_id'

async function writeCandidate(
  candidateId: string | undefined | null,
  updates: Record<string, unknown>,
): Promise<BuyerActionResult> {
  if (!candidateId) return { ok: false, updates: {}, message: 'No buyer candidate selected' }
  const supabase = getSupabaseClient()
  const { error } = await supabase.from(TABLE).update(updates).eq(ID, candidateId)
  if (error) return { ok: false, updates: {}, message: error.message || 'Buyer update failed' }
  return { ok: true, updates }
}

/** Records the operator's read on a buyer. A status mark, not an outreach. */
export function setBuyerDisposition(
  candidateId: string | undefined | null,
  disposition: BuyerDisposition,
): Promise<BuyerActionResult> {
  return writeCandidate(candidateId, { buyer_response_status: disposition })
}

/** Marks the buyer the operator intends to transact with. */
export function selectBuyerCandidate(candidateId: string | undefined | null): Promise<BuyerActionResult> {
  return writeCandidate(candidateId, { selected: true })
}
