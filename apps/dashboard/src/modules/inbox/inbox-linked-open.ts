/**
 * INBOX · LINKED CONTEXT — open the conversation for a property selected in
 * another open app.
 *
 * This is NAVIGATION, never an open-as-read: the only selection the caller
 * may wire to `selectInList` is the `'navigate'` intent
 * (thread-read-policy.ts), and a thread fetched by key is selected without
 * any read write. Nothing here sends, writes or creates anything.
 *
 * Resolution, cheapest first:
 *   1. the locator's thread, or a loaded row for the property
 *   2. property → thread: the newest `inbox_thread_state` row for that
 *      property (the same read the Map uses for a seller's thread)
 *   3. the thread fetched by key (it may sit outside the loaded page)
 * No conversation for the property is an honest `missing`.
 */
import type { PropertyLocator } from '../../domain/locator/property-locator'

export interface LinkedInboxDeps<T> {
  /** the loaded row (its id) for a thread key or a property, if any */
  findInList: (q: { threadKey: string | null; propertyId: string | null }) => string | null
  /** property → newest thread key; null when the property has no conversation */
  lookupThreadKey: (propertyId: string, signal: AbortSignal) => Promise<string | null>
  /** one thread by key, outside the loaded page */
  fetchThread: (threadKey: string, signal: AbortSignal) => Promise<T | null>
  /** select a loaded row with the NAVIGATE intent — never a read */
  selectInList: (rowId: string) => void
  /** select a fetched thread — never a read */
  selectFetched: (thread: T) => void
}

export type LinkedInboxOutcome = 'in_list' | 'fetched' | 'missing' | 'unresolvable' | 'aborted'

export async function openLinkedThread<T>(loc: PropertyLocator, deps: LinkedInboxDeps<T>, signal: AbortSignal): Promise<LinkedInboxOutcome> {
  if (!loc.threadKey && !loc.propertyId) return 'unresolvable'
  const direct = deps.findInList({ threadKey: loc.threadKey, propertyId: loc.propertyId })
  if (direct) { deps.selectInList(direct); return 'in_list' }

  const key = loc.threadKey ?? (loc.propertyId ? await deps.lookupThreadKey(loc.propertyId, signal) : null)
  if (signal.aborted) return 'aborted'
  if (!key) return 'missing'
  const listed = loc.threadKey ? null : deps.findInList({ threadKey: key, propertyId: null })
  if (listed) { deps.selectInList(listed); return 'in_list' }

  const thread = await deps.fetchThread(key, signal)
  if (signal.aborted) return 'aborted'
  if (!thread) return 'missing'
  deps.selectFetched(thread)
  return 'fetched'
}

/** property → the newest conversation's thread key (inbox_thread_state, read-only). */
export async function lookupThreadKeyForProperty(propertyId: string, signal: AbortSignal): Promise<string | null> {
  const { getSupabaseClient } = await import('../../lib/supabaseClient')
  const { data, error } = await getSupabaseClient()
    .from('inbox_thread_state')
    .select('thread_key')
    .eq('property_id', propertyId)
    .order('latest_message_at', { ascending: false })
    .limit(1)
    .abortSignal(signal)
    .maybeSingle()
  if (error) return null
  const key = String((data as { thread_key?: unknown } | null)?.thread_key ?? '').trim()
  return key || null
}
