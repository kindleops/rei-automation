/**
 * NAVIGATION NEVER MARKS A CONVERSATION READ.
 *
 * InboxPage backs /inbox and also the Map, Pipeline, Calendar, Comps and
 * Analytics hosts (and every desktop pane of them). Each of those selects a
 * thread for their own reasons. A Map pin, a linked property arriving in a Map
 * pane, "Show on Map", a Pipeline card or a Calendar entry all go through the
 * thread selection. That selection used to PATCH `is_read: true` every time,
 * so a property focus anywhere in the workspace marked the seller's
 * conversation read without the operator ever seeing it.
 *
 * The read is a business fact ("someone has looked at this seller's last
 * message"). The rule is that it is written only when:
 *   - the operator opens the Conversation surface as the primary action (an
 *     Inbox row, a deep link / Open conversation, Open from Notification
 *     Center, the conversation's own search result); or
 *   - the operator chooses Mark Read explicitly (handled by the canonical
 *     thread action, not here).
 *
 * Every selection names its intent. Anything that is not an open is
 * `navigate`, which never writes.
 */
import { resolveDealDeskWritableThreadKey } from '../../domain/inbox/deal-desk-thread-reference'
import type { WritableThreadKeyResult } from '../../domain/inbox/deal-desk-thread-reference'

export type ThreadSelectIntent =
  /** The operator opened this conversation (Inbox row, Open conversation, Notification Open). */
  | 'open_conversation'
  /** Selection, focus, preview, arrival, linked context: never a read. */
  | 'navigate'

export const marksReadOnSelect = (intent: ThreadSelectIntent): boolean => intent === 'open_conversation'

type ThreadLike = Parameters<typeof resolveDealDeskWritableThreadKey>[0]

export interface ThreadReadWriteDeps {
  /** The canonical thread-state write: PATCH /api/cockpit/inbox/thread-state { is_read: true }. */
  patchRead: (threadKey: string) => Promise<{ ok?: boolean } | null | undefined>
  /** The write landed: refresh the read-based counts. */
  onWritten?: () => void
  /** The operator opened it, but it has no writable canonical phone route. */
  onUnwritable?: (result: WritableThreadKeyResult | null) => void
}

export type ThreadReadOutcome = 'skipped' | 'requested' | 'unwritable'

/**
 * Apply the read rule for one selection. Returns synchronously what it did;
 * the write itself is fire-and-forget (counts refresh when it lands).
 */
export function applyThreadReadOnSelect(
  intent: ThreadSelectIntent,
  thread: ThreadLike,
  deps: ThreadReadWriteDeps,
): ThreadReadOutcome {
  if (!marksReadOnSelect(intent)) return 'skipped'
  const writeKey = resolveDealDeskWritableThreadKey(thread)
  if (!writeKey?.ok) {
    deps.onUnwritable?.(writeKey)
    return 'unwritable'
  }
  void deps.patchRead(writeKey.threadKey).then((res) => {
    if (res?.ok) deps.onWritten?.()
  }, () => undefined)
  return 'requested'
}
