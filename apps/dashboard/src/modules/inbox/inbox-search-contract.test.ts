import { describe, expect, it } from 'vitest'
import { dedupeThreadsByKey } from '../../lib/data/inboxData'
import { matchesSearch } from './components/InboxSidebar'
import type { InboxThread } from '../../domain/inbox/inbox-model-types'
import type { InboxWorkflowThread } from '../../lib/data/inboxData'

/**
 * INBOX-FINAL-HARDEN-2 §1 — search is server-backed and page-independent.
 *
 * The defect: /api/cockpit/inbox/live answers `q` correctly, but the search box
 * only called setSearchQuery. Nothing refreshed, so the only thing that
 * narrowed was the list's own filter over rows already in memory — and a
 * corpus match outside the loaded page could never appear.
 *
 *   q=Salazar   API 10 matching threads   UI 0 rows
 *
 * Two behaviours have to hold for that to stay fixed, and both are testable
 * without rendering the page.
 */

const thread = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'ct:default',
  threadKey: 'default',
  latestMessageAt: '2026-09-12T10:00:00Z',
  ...over,
}) as unknown as InboxThread

describe('the list must not re-narrow what the server already filtered', () => {
  /**
   * The certified corpus search matches MESSAGE BODIES through a trigram index
   * over message_events. The row the client holds carries only
   * `latest_message_body`, so a hit on any earlier message in the thread has
   * no field on the client to match against.
   *
   * Verified live: `q=cash` returns 13 threads, and two of them
   * ("Hola Martha, habla Carmen…", "Hi Concepcion, Mason here…") have previews
   * that do not contain the word at all. The old client filter dropped exactly
   * those rows.
   */
  it('keeps a thread whose match is in a message the client cannot see', () => {
    const bodyOnlyMatch = {
      latest_message_body: 'Hola Martha, habla Carmen. Queria volver a llamar.',
      seller_display_name: 'Concepcion Amaya',
      property_address_full: '900 Main St, Houston, TX',
    } as unknown as InboxWorkflowThread

    expect(matchesSearch(bodyOnlyMatch, 'cash')).toBe(true)
  })

  it('keeps every row for every query — the server decides membership', () => {
    const row = { seller_display_name: 'Bertha A Daniels' } as unknown as InboxWorkflowThread
    for (const query of ['Salazar', 'cash', '3053516081', 'Worthington', '']) {
      expect(matchesSearch(row, query), query).toBe(true)
    }
  })
})

describe('one conversation is one row, on both fetch paths', () => {
  /**
   * A thread can exist under both a bare-digit and an E.164 thread_key that
   * resolve to the SAME conversation_thread_id. The card renders
   * data-thread-id from that field, so two rows render as a duplicate card.
   *
   * Measured on /inbox/live?q=Salazar: 10 rows, 10 unique thread_keys, 9 unique
   * conversation_thread_ids. The direct-Supabase path already collapsed this;
   * the live path did not, and a corpus search is what puts both halves
   * (buckets `cold` and `dead`) in one page.
   */
  const CONVERSATION = 'ct:property:24560207|owner:mo_8c8d25d5fa49e559f5883623|phone:+18478679735'

  it('collapses the bare-digit and E.164 halves of one conversation', () => {
    const rows = [
      thread({
        threadKey: '8478679735',
        conversation_thread_id: CONVERSATION,
        id: CONVERSATION,
        inboxBucket: 'cold',
        latestMessageAt: '2026-09-10T10:00:00Z',
      }),
      thread({
        threadKey: '+18478679735',
        conversation_thread_id: CONVERSATION,
        id: 'ct:prospect:pros1_8e2a7231|property:24560207',
        inboxBucket: 'dead',
        latestMessageAt: '2026-09-12T10:00:00Z',
      }),
    ]

    const deduped = dedupeThreadsByKey(rows)
    expect(deduped).toHaveLength(1)
  })

  it('keeps the newer row when the two halves disagree', () => {
    const rows = [
      thread({ conversation_thread_id: CONVERSATION, inboxBucket: 'cold', latestMessageAt: '2026-09-10T10:00:00Z' }),
      thread({ conversation_thread_id: CONVERSATION, inboxBucket: 'dead', latestMessageAt: '2026-09-12T10:00:00Z' }),
    ]
    const [merged] = dedupeThreadsByKey(rows) as unknown as Array<Record<string, unknown>>
    expect(merged.inboxBucket).toBe('dead')
  })

  it('does not collapse genuinely different conversations', () => {
    const rows = [
      thread({ conversation_thread_id: 'ct:a', id: 'ct:a' }),
      thread({ conversation_thread_id: 'ct:b', id: 'ct:b' }),
      thread({ conversation_thread_id: 'ct:c', id: 'ct:c' }),
    ]
    expect(dedupeThreadsByKey(rows)).toHaveLength(3)
  })

  it('drops a row with no identity rather than keying it as empty', () => {
    const rows = [
      thread({ conversation_thread_id: '', id: '', threadKey: '' }),
      thread({ conversation_thread_id: 'ct:real', id: 'ct:real' }),
    ]
    expect(dedupeThreadsByKey(rows)).toHaveLength(1)
  })
})
