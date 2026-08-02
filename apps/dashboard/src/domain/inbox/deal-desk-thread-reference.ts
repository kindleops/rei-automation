/**
 * Application-level binding for the canonical thread-reference contract.
 *
 * `canonical-thread-reference.ts` is deliberately dependency-free so it can be unit
 * tested under `node --test`. This module is the single place that injects the
 * repository's existing composite conversation-id builder into it.
 *
 * **Every Deal Desk read path, write path and cache key must go through this module.**
 * Importing `resolveCanonicalThreadReference` directly from the pure module inside
 * application code will silently drop the composite conversation identity and produce a
 * selection key that does not match the message cache.
 */

import { getConversationThreadIdForThread } from '../../lib/data/inboxData'
import {
  resolveCanonicalThreadReference,
  resolveWritableThreadKey,
  rowMatchesThreadReference,
  threadSelectionKey,
  type CanonicalThreadReference,
  type ThreadIdentityInput,
  type WritableThreadKeyResult,
} from './canonical-thread-reference'

const conversationIdFor = (thread: ThreadIdentityInput): string | null =>
  thread ? getConversationThreadIdForThread(thread) || null : null

/** Canonical reference for a Deal Desk thread-shaped record. */
export const resolveDealDeskThreadReference = (
  thread: ThreadIdentityInput,
): CanonicalThreadReference | null =>
  resolveCanonicalThreadReference(thread, { conversationId: conversationIdFor(thread) })

/** Stable Deal Desk selection / cache key for a thread-shaped record. */
export const resolveDealDeskSelectionKey = (thread: ThreadIdentityInput): string | null =>
  threadSelectionKey(thread, { conversationId: conversationIdFor(thread) })

/**
 * Server-writable thread-state key for a Deal Desk mutation.
 * Returns a typed failure rather than an identifier the server's `/^\+1\d{10}$/` guard
 * will reject (DD-003).
 */
export const resolveDealDeskWritableThreadKey = (
  thread: ThreadIdentityInput,
): WritableThreadKeyResult | null =>
  resolveWritableThreadKey(thread, { conversationId: conversationIdFor(thread) })

/** Does a refreshed list row still name the conversation this reference points at? */
export const dealDeskRowMatchesReference = (
  row: ThreadIdentityInput,
  reference: CanonicalThreadReference | null | undefined,
): boolean =>
  rowMatchesThreadReference(row, reference, { conversationId: conversationIdFor(row) })

export type { CanonicalThreadReference, WritableThreadKeyResult }
