/**
 * Count boot proof: cached counts hydrate store without zero-flash semantics.
 * Run: npx tsx apps/dashboard/scripts/proof/inbox-count-boot-proof.ts
 */

import { inboxReducer, EMPTY_INBOX_STORE_STATE } from '../../src/modules/inbox/inbox-store'

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

let state = {
  ...EMPTY_INBOX_STORE_STATE,
  viewCounts: { new_replies: 12, priority: 4, all_messages: 7891 },
}

state = inboxReducer(state, {
  type: 'SET_VIEW_COUNTS',
  counts: { new_replies: 0, priority: 0, all_messages: 0 },
  preserveExisting: true,
  reason: 'degraded_timeout',
})

assert(state.viewCounts.new_replies === 12, 'degraded zero must not erase cached new_replies')
assert(state.viewCounts.priority === 4, 'degraded zero must not erase cached priority')
assert(state.viewCounts.all_messages === 7891, 'degraded zero must not erase cached all_messages')

state = inboxReducer(state, {
  type: 'SET_VIEW_COUNTS',
  counts: { new_replies: 9, priority: 3, all_messages: 7880 },
})

assert(state.viewCounts.new_replies === 9, 'authoritative counts must replace cached values')
assert(state.viewCounts.all_messages === 7880, 'authoritative all_messages must replace cached values')

console.log('inbox-count-boot-proof: success')