import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import {
  RESTING,
  deriveComposerPhase,
  isLiveQueuedTransition,
  mergeQueueBubbles,
  queueRowToBubble,
  readReplyMarker,
  visibleComposerPhase,
  type ComposerPhase,
} from './composer-phase'

const T0 = Date.parse('2026-10-01T15:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const message = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm',
  direction: 'inbound',
  body: 'hello',
  createdAt: iso(T0),
  timelineAt: iso(T0),
  sentAt: null,
  deliveredAt: null,
  deliveryStatus: 'sent',
  fromNumber: '',
  toNumber: '',
  ownerId: '',
  prospectId: '',
  propertyId: '',
  phoneNumber: '',
  canonicalE164: '',
  templateId: null,
  templateName: null,
  agentId: null,
  source: 'textgrid',
  rawStatus: '',
  error: null,
  metadata: {},
  ...overrides,
})

const inbound = (meta: Record<string, unknown>, at = T0) => message({ id: 'in-1', createdAt: iso(at), timelineAt: iso(at), metadata: meta })

describe('reading the automation\'s marker', () => {
  it('reads the queue id and status from metadata or its payload', () => {
    expect(readReplyMarker(inbound({ auto_reply_queue_id: 'q1', auto_reply_status: 'queued' }))).toMatchObject({ queueId: 'q1', status: 'queued' })
    expect(readReplyMarker(inbound({ payload: { auto_reply_queue_id: 'q2' } })).queueId).toBe('q2')
    expect(readReplyMarker(inbound({ human_review_required: 'true' })).humanReview).toBe(true)
  })
})

describe('deriveComposerPhase', () => {
  it('rests when nothing is happening', () => {
    expect(deriveComposerPhase([], T0)).toEqual(RESTING)
    expect(deriveComposerPhase([inbound({ auto_reply_status: 'execution_eligible' })], T0).kind).toBe('resting')
  })

  it('processing: the automation marked the message and the reply is not visible yet', () => {
    const phase = deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1', auto_reply_status: 'queued' })], T0 + 5_000)
    expect(phase.kind).toBe('processing')
    expect(phase.inboundId).toBe('in-1')
  })

  it('a reply the queue cancelled is never "replying"', () => {
    expect(deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1' })], T0 + 5_000, (id) => (id === 'q1' ? 'cancelled' : null)).kind).toBe('resting')
    expect(deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1' })], T0 + 5_000, () => 'queued').kind).toBe('processing')
  })

  it('processing is bounded: an old marker with no visible reply is history', () => {
    expect(deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1' })], T0 + 11 * 60_000).kind).toBe('resting')
  })

  it('queued: the real queued reply is visible (a send_queue bubble), with its send time', () => {
    const bubble = queueRowToBubble({ id: 'q1', queue_status: 'queued', source: 'auto_reply', message_body: 'Thanks Wendy', scheduled_for_utc: iso(T0 + 60_000) })!
    const phase = deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1', auto_reply_status: 'queued' }), bubble], T0 + 5_000)
    expect(phase.kind).toBe('queued')
    expect(phase.detail).toMatch(/^sends /)
  })

  it('queued also when the reply already went out (the sent message carries the queue id)', () => {
    const sent = message({ id: 'out-1', direction: 'outbound', createdAt: iso(T0 + 70_000), developerMeta: { queue_id: 'q1' }, deliveryStatus: 'delivered' })
    expect(deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1' }), sent], T0 + 80_000).kind).toBe('queued')
  })

  it('held: needs your review — never "replying"', () => {
    const phase = deriveComposerPhase([inbound({ human_review_required: true, detected_intent: 'unclear', classification_confidence: 0.42 })], T0)
    expect(phase.kind).toBe('held')
    expect(phase.detail).toBe('Intent unclear · 42% confidence')
  })

  it('held ends when someone answers', () => {
    const reply = message({ id: 'out-1', direction: 'outbound', createdAt: iso(T0 + 60_000), deliveryStatus: 'delivered' })
    expect(deriveComposerPhase([inbound({ human_review_required: true }), reply], T0 + 70_000).kind).toBe('resting')
  })

  it('failed: the conversation stands on a failed send, with the existing retry', () => {
    const failed = message({ id: 'out-1', direction: 'outbound', createdAt: iso(T0 + 60_000), deliveryStatus: 'failed', rawStatus: 'failed', error: 'carrier_rejected' })
    const phase = deriveComposerPhase([inbound({}), failed], T0 + 70_000)
    expect(phase.kind).toBe('failed')
    expect(phase.detail).toBe('Carrier rejected')
    expect(phase.canRetry).toBe(true)
  })

  it('a health-guard block is a failure without a retry (the retry path only retries failed sends)', () => {
    const bubble = queueRowToBubble({ id: 'q1', queue_status: 'blocked_by_health_guard', source: 'auto_reply', message_body: 'Thanks', scheduled_for_utc: iso(T0 + 60_000), failed_reason: 'blocked_sender_number' })!
    const phase = deriveComposerPhase([inbound({ auto_reply_queue_id: 'q1' }), bubble], T0 + 90_000)
    expect(phase.kind).toBe('failed')
    expect(phase.canRetry).toBe(false)
    expect(phase.detail).toBe('Blocked sender number')
  })
})

describe('the queued reply as a bubble', () => {
  it('only the automation answering a seller, only while it has not been sent', () => {
    expect(queueRowToBubble({ id: 'q', queue_status: 'queued', source: 'campaign_launch_execution', message_body: 'x' })).toBeNull()
    expect(queueRowToBubble({ id: 'q', queue_status: 'sent', source: 'auto_reply', message_body: 'x', sent_at: iso(T0) })?.sentAt).toBe(iso(T0))
    expect(queueRowToBubble({ id: 'q', queue_status: 'cancelled', source: 'auto_reply', message_body: 'x' })).toBeNull()
    const bubble = queueRowToBubble({ id: 'q', queue_status: 'queued', source: 'seller_inbound_orchestrator', message_body: 'x' })
    expect(bubble?.developerMeta).toEqual({ queue_id: 'q', origin: 'automation_queue' })
    expect(bubble?.source).toBe('send_queue')
  })

  it('is dropped once the sent message for the same queue row is in the timeline', () => {
    const bubble = queueRowToBubble({ id: 'q1', queue_status: 'sending', source: 'auto_reply', message_body: 'x' })!
    const sent = message({ id: 'out', direction: 'outbound', developerMeta: { queue_id: 'q1' } })
    expect(mergeQueueBubbles([sent], [bubble])).toEqual([sent])
    expect(mergeQueueBubbles([], [bubble])).toEqual([bubble])
  })
})

describe('success is a transition, not a state', () => {
  const processing: ComposerPhase = { kind: 'processing', inboundId: 'in-1', detail: null, canRetry: false }
  const queued: ComposerPhase = { kind: 'queued', inboundId: 'in-1', detail: 'sends 3:01 PM', canRetry: false }

  it('the reply appearing while the conversation is open is a live transition', () => {
    expect(isLiveQueuedTransition({ threadId: 't1', kind: 'processing', inboundId: 'in-1' }, queued, 't1')).toBe(true)
    expect(isLiveQueuedTransition({ threadId: 't1', kind: 'resting', inboundId: 'in-1' }, queued, 't1')).toBe(true)
  })

  it('opening a conversation whose reply was queued earlier is not', () => {
    expect(isLiveQueuedTransition({ threadId: 't1', kind: 'resting', inboundId: null }, queued, 't1')).toBe(false)
  })

  it('switching conversations never carries a success over', () => {
    expect(isLiveQueuedTransition({ threadId: 't1', kind: 'processing', inboundId: 'in-1' }, queued, 't2')).toBe(false)
  })

  it('queued shows only while its flash is live; everything else shows as derived', () => {
    expect(visibleComposerPhase(queued, 'in-1').kind).toBe('queued')
    expect(visibleComposerPhase(queued, null)).toEqual(RESTING)
    expect(visibleComposerPhase(processing, null).kind).toBe('processing')
  })
})
