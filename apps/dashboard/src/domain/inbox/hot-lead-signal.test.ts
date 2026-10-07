import { describe, expect, it } from 'vitest'

import { resolveInboxThreadState } from './resolveInboxThreadState'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

// Inbox Actionability 8.5 (owner 2026-10-06): HOT LEAD comes ONLY from the
// server's canonical is_hot_lead (apps/api reply-actionability.js). A new reply
// ('high') or a numeric score is never hot by itself.
const thread = (extra: Record<string, unknown>) => ({
  id: 't1',
  thread_key: '+15550001111',
  latest_direction: 'inbound',
  latest_message_body: 'There are shitstains all over the walls',
  is_read: true,
  ...extra,
}) as unknown as InboxWorkflowThread

describe('hot lead signal', () => {
  it("a 'high' priority new reply is not a hot lead", () => {
    const state = resolveInboxThreadState(thread({ priority: 'high', priority_score: 95 }))
    expect(state.bucket).not.toBe('priority')
  })

  it('the canonical is_hot_lead flag still marks a hot lead', () => {
    const state = resolveInboxThreadState(thread({ is_hot_lead: true, latest_message_body: '$185k and we can close fast' }))
    expect(state.bucket).toBe('priority')
  })
})
