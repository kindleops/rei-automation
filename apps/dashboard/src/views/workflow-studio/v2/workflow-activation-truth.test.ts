import { describe, expect, it } from 'vitest'
import type { Workflow } from '../workflow.types'
import { describeActivation, describeSendCapability, lifecycleLabel } from './workflow-activation-truth'

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'w1',
  workflow_key: 'k',
  name: 'W',
  channel: 'multichannel',
  workflow_type: 'automation',
  status: 'published',
  live_send_enabled: false,
  ...over,
} as Workflow)

/**
 * The exact production shape on 2026-09-15: published, operational_mode
 * active_safe, trigger.* subscribed, never emitted. This is the row that used
 * to read "active safe".
 */
describe('a published workflow whose trigger never fires', () => {
  const production = wf({
    status: 'published',
    operational_mode: 'active_safe',
    trigger_type: 'trigger.inbound_message_received',
    trigger_event_count: 0,
    trigger_last_seen_at: null,
    trigger_matchable: false,
  })

  it('is not presented as active', () => {
    const truth = describeActivation(production)
    expect(truth.canBeEntered).toBe(false)
    expect(truth.label).not.toMatch(/active/i)
    expect(truth.tone).toBe('not-armed')
  })

  it('says both why it cannot be entered and that arming is not enough', () => {
    const { detail } = describeActivation(production)
    expect(detail).toMatch(/status=active/)
    expect(detail).toMatch(/never been emitted/)
  })

  it('never renders operational_mode as if it were the status', () => {
    expect(lifecycleLabel(production)).toBe('published · active safe')
  })
})

describe('the armed cases are distinguished from each other', () => {
  it('armed with observed events reports the count and when', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'lead_entered_workflow',
      trigger_event_count: 4,
      trigger_last_seen_at: '2026-06-12T05:58:25.666Z',
      trigger_matchable: true,
    }))
    expect(truth.tone).toBe('armed')
    expect(truth.canBeEntered).toBe(true)
    expect(truth.detail).toMatch(/4 events observed/)
  })

  /** Armed is not the same as running. A subscriber with no traffic is idle. */
  it('armed with zero observed events is reported as never fired, not as armed', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'trigger.offer_sent',
      trigger_event_count: 0,
      trigger_matchable: true,
    }))
    expect(truth.tone).toBe('unsubscribed')
    expect(truth.label).toBe('never fired')
    expect(truth.canBeEntered).toBe(true)
  })

  it('a single event is not pluralised', () => {
    const truth = describeActivation(wf({
      status: 'active', trigger_type: 't', trigger_event_count: 1, trigger_matchable: true,
    }))
    expect(truth.detail).toMatch(/1 event observed/)
  })
})

describe('absent truth is reported as absent', () => {
  /** A failed measurement must not render as calm. */
  it('an unmeasured trigger count is unknown, not zero', () => {
    const truth = describeActivation(wf({
      trigger_type: 'trigger.offer_sent',
      trigger_event_count: null,
      trigger_matchable: null,
    }))
    expect(truth.tone).toBe('unknown')
    expect(truth.canBeEntered).toBe(false)
    expect(truth.detail).toMatch(/unverified/)
  })

  it('a workflow with no trigger cannot be entered', () => {
    for (const trigger of [null, undefined, '   ']) {
      const truth = describeActivation(wf({ status: 'draft', trigger_type: trigger as string | null }))
      expect(truth.label).toBe('no trigger')
      expect(truth.canBeEntered).toBe(false)
    }
  })

  it('a legacy workflow is read-only, never enterable', () => {
    const truth = describeActivation(wf({ is_legacy: true, trigger_type: 'anything', trigger_matchable: true }))
    expect(truth.tone).toBe('inert')
    expect(truth.canBeEntered).toBe(false)
  })
})

describe('send capability is counted, never assumed', () => {
  it('reports the real node count', () => {
    expect(describeSendCapability(wf({ send_node_count: 1 })).label).toBe('1 send node')
    expect(describeSendCapability(wf({ send_node_count: 3 })).label).toBe('3 send nodes')
    expect(describeSendCapability(wf({ send_node_count: 1 })).sends).toBe(true)
  })

  it('zero is a measured zero', () => {
    expect(describeSendCapability(wf({ send_node_count: 0 })).sends).toBe(false)
  })

  /**
   * The API hardcoded send_node_count to 0 for every workflow, including the
   * four that carry a send node. An unmeasurable count must read as unknown so
   * that regression cannot come back silently.
   */
  it('an unmeasured count is unknown, not "no sends"', () => {
    const { label, sends } = describeSendCapability(wf({ send_node_count: null }))
    expect(sends).toBe(null)
    expect(label).toBe('sends unknown')
  })
})

describe('lifecycleLabel keeps status as the authority', () => {
  it('shows the status alone when the mode adds nothing', () => {
    expect(lifecycleLabel(wf({ status: 'draft', operational_mode: 'draft' }))).toBe('draft')
    expect(lifecycleLabel(wf({ status: 'draft' }))).toBe('draft')
  })

  it('never returns an empty label', () => {
    expect(lifecycleLabel(wf({ status: '' as Workflow['status'] }))).toBe('unknown')
  })
})
