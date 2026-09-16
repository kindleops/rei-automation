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
/**
 * The production shape after LOCK-1B wired the bridge: the acquisition event
 * that feeds this workflow occurs 1340 times, the bridge can deliver it, and
 * the workflow is still `published` so nothing enters. All three facts have to
 * survive into the copy.
 */
describe('a bridge-connected workflow that is not armed', () => {
  const production = wf({
    status: 'published',
    operational_mode: 'active_safe',
    trigger_type: 'trigger.inbound_message_received',
    trigger_kind: 'inbound_reply',
    trigger_matchable: false,
    trigger_bridge_connected: true,
    canonical_event_count: 1340,
    canonical_last_seen_at: '2026-09-12T19:34:13.903Z',
  })

  it('is not presented as active', () => {
    const truth = describeActivation(production)
    expect(truth.canBeEntered).toBe(false)
    expect(truth.label).not.toMatch(/active/i)
    expect(truth.tone).toBe('not-armed')
  })

  it('reports the bridge, the real volume, and why nothing enters', () => {
    const { detail } = describeActivation(production)
    expect(detail).toMatch(/bridge connected/i)
    expect(detail).toMatch(/1340 inbound_reply events observed/)
    expect(detail).toMatch(/status=active/)
  })

  it('never renders operational_mode as if it were the status', () => {
    expect(lifecycleLabel(production)).toBe('published · active safe')
  })
})

describe('the bridge states are distinguished from each other', () => {
  /** Manual enrollment is operator-initiated by design, not broken. */
  it('a trigger no acquisition event feeds is reported as manual only', () => {
    const truth = describeActivation(wf({
      status: 'published',
      trigger_type: 'trigger.manual_enrollment',
      trigger_kind: 'manual_enrollment',
      trigger_matchable: false,
      trigger_bridge_connected: false,
      trigger_bridge_reason: 'no_canonical_event_maps_to_kind',
      canonical_event_count: null,
    }))
    expect(truth.tone).toBe('manual')
    expect(truth.detail).toMatch(/operator enrolls/)
  })

  /** The real wiring gap: trigger.classification_completed. */
  it('an unrecognised trigger is reported as having no event source', () => {
    const truth = describeActivation(wf({
      status: 'published',
      trigger_type: 'trigger.classification_completed',
      trigger_kind: null,
      trigger_matchable: false,
      trigger_bridge_connected: false,
      trigger_bridge_reason: 'unrecognised_trigger_type',
    }))
    expect(truth.tone).toBe('unsubscribed')
    expect(truth.label).toBe('no event source')
    expect(truth.canBeEntered).toBe(false)
    expect(truth.detail).toMatch(/needs a canonical event mapped/)
  })

  it('armed with real volume reports armed', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'test_runtime_proof',
      trigger_kind: 'test_runtime_proof',
      trigger_matchable: true,
      trigger_bridge_connected: true,
      canonical_event_count: 2,
      canonical_last_seen_at: '2026-09-16T04:24:00.000Z',
    }))
    expect(truth.tone).toBe('armed')
    expect(truth.canBeEntered).toBe(true)
    expect(truth.detail).toMatch(/2 test_runtime_proof events observed/)
  })

  /** Armed is not running. A subscriber with no traffic is idle, and says so. */
  it('armed with zero volume is reported as idle, not as running', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'trigger.follow_up_due',
      trigger_kind: 'follow_up_due',
      trigger_matchable: true,
      trigger_bridge_connected: true,
      canonical_event_count: 0,
    }))
    expect(truth.tone).toBe('unsubscribed')
    expect(truth.label).toBe('armed · idle')
    expect(truth.detail).toMatch(/no follow_up_due event has occurred yet/)
  })
})

describe('counts are phrased correctly', () => {
  it('a single event is not pluralised', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'stage_entered',
      trigger_kind: 'stage_entered',
      trigger_matchable: true,
      trigger_bridge_connected: true,
      canonical_event_count: 1,
    }))
    expect(truth.detail).toMatch(/1 stage_entered event observed/)
  })

  it('an unmeasured volume on a connected bridge is not reported as zero', () => {
    const truth = describeActivation(wf({
      status: 'active',
      trigger_type: 'inbound_reply',
      trigger_kind: 'inbound_reply',
      trigger_matchable: true,
      trigger_bridge_connected: true,
      canonical_event_count: null,
    }))
    expect(truth.detail).toMatch(/volume unmeasured/)
    expect(truth.detail).not.toMatch(/no inbound_reply event has occurred/)
  })
})

describe('absent truth is reported as absent', () => {
  /** A failed measurement must not render as calm. */
  it('an unresolvable bridge is unknown, not zero', () => {
    const truth = describeActivation(wf({
      trigger_type: 'trigger.offer_sent',
      trigger_matchable: null,
      trigger_bridge_connected: null,
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
    const truth = describeActivation(wf({ is_legacy: true, trigger_type: 'anything', trigger_matchable: true, trigger_bridge_connected: true }))
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
