/**
 * The canonical "new reply" contract.
 *
 * ONE definition of what it means for a lead to be waiting on us, shared by the
 * desktop KPI and the mobile Pipeline board.
 *
 * Before this existed the two surfaces answered different questions and reported
 * different numbers for the same book:
 *
 *   desktop KPI   2   `conversation_state === 'needs_reply'`, OR `seller_replied`
 *                     within a rolling 7-day window — a RECENCY measure
 *   mobile board  63  `canonical_operational_status === 'new_reply'`
 *                     — a STATE measure
 *
 * The state measure is the product contract: a lead that replied nine days ago
 * is still owed a reply, and dropping it out of the count at the seven-day mark
 * hides work rather than completing it. The recency window is preserved as
 * `new_replies_recent` for anyone who genuinely wants "what came in this week".
 *
 * `conversation_state` is NOT usable as the primary signal — it reads
 * `seller_replied` on 254 of the live 258 active rows, so it selects the whole
 * book. It is consulted only for rows that carry no status at all.
 *
 * Mirrored in `apps/dashboard/src/views/pipeline/components/pipeline-mobile-filters.ts`
 * (`needsResponse`). The two are pinned together by
 * `tests/fixtures/new-reply-parity.json`, which both test suites assert against —
 * change one predicate and the other side's test fails.
 */

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Canonical operational status for an opportunity row, preferring the workflow
 * state the Inbox and Seller Detail write over the opportunity's own column.
 */
export function resolveCanonicalStatus(row = {}) {
  return lower(row.canonical_operational_status) || lower(row.opportunity_status);
}

/**
 * @returns true when the seller is waiting on us.
 */
export function isNewReplyLead(row = {}) {
  const status = resolveCanonicalStatus(row);
  if (status) return status === 'new_reply';

  // Only reached when a row has no status on either side.
  const conversationState = lower(row.conversation_state);
  return conversationState === 'needs_reply'
    || conversationState === 'new_inbound'
    || conversationState === 'unread';
}

export default { isNewReplyLead, resolveCanonicalStatus };
