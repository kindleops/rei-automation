/**
 * Thread-state key resolution — now a thin delegation to the canonical contract.
 *
 * Historically this module was the *read-path* resolver (phone-first, then any thread
 * identity) while `inboxWorkflowData.toThreadKey` was the *write-path* resolver
 * (threadKey/id-first). Two resolvers, one table, different answers — DD-003.
 *
 * Both now resolve through `canonical-thread-reference.ts`. The one behavioural change:
 * a key is returned **only** when it satisfies the server's `/^\+1\d{10}$/` guard
 * (`cockpit-service.js:27-31`). Previously this function could return a UUID or a
 * composite key, which the server rejected with a 400 that no caller inspected.
 * Callers must now handle `null` explicitly instead of firing a doomed request.
 *
 * Kept dependency-free (delegates to the pure module, not the app adapter) because
 * `inboxData.ts` imports this file — importing the adapter here would be circular.
 */

import {
  isSyntheticThreadIdentity as isSyntheticThreadIdentityCore,
  resolveDialablePhoneFromThread as resolveDialablePhoneFromThreadCore,
  resolveWritableThreadKey,
  type ThreadIdentityInput,
} from './canonical-thread-reference'

export const isSyntheticThreadIdentity = isSyntheticThreadIdentityCore

/** Resolve a dialable seller phone from explicit phone fields (never synthetic keys). */
export const resolveDialablePhoneFromThread = resolveDialablePhoneFromThreadCore

/**
 * Resolve the E.164 `thread_key` required by `/api/cockpit/inbox/thread-state`.
 * Returns null when no server-writable contact route exists — callers must surface that
 * rather than substituting an unrelated identifier.
 */
export const resolveCanonicalThreadStateKey = (thread: ThreadIdentityInput): string | null => {
  const result = resolveWritableThreadKey(thread)
  return result?.ok ? result.threadKey : null
}
