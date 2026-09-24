import { describe, expect, it } from 'vitest'
import { buildActivity, describeEvent, groupActivityByDay } from './campaign-activity'
import type { CampaignActivityEvent } from '../../lib/api/backendClient'

let seq = 0
const ev = (event_type: string, description = '', overrides: Partial<CampaignActivityEvent> = {}): CampaignActivityEvent => {
  seq += 1
  return {
    id: `e${seq}`,
    campaign_id: 'c1',
    event_type,
    severity: 'success',
    title: null,
    description,
    created_at: new Date(Date.UTC(2026, 8, 17, 6, 30) - seq * 300_000).toISOString(),
    ...overrides,
  }
}

describe('describeEvent', () => {
  it('reads an idle scheduler tick as quiet, not as a launch', () => {
    const d = describeEvent(ev('campaign.launch_scheduled', '0 targets planned; 0 queue rows created.'))
    expect(d).toEqual({ title: 'Checked for sellers to queue', detail: 'Nothing new to queue.', tone: 'quiet' })
  })

  it('reads a tick that queued something as what it queued', () => {
    expect(describeEvent(ev('campaign.launch_scheduled', '10 targets planned; 10 queue rows created.')).title).toBe('Queued 10 messages')
    expect(describeEvent(ev('campaign.launch_scheduled', '1 targets planned; 1 queue rows created.')).title).toBe('Queued 1 message')
  })

  it('turns blocker codes into a sentence', () => {
    const d = describeEvent(ev('campaign.launch_blocked', 'Blocked by campaign_status_not_queueable:paused, auto_send_must_remain_disabled, auto_reply_must_remain_disabled', { severity: 'warning' }))
    expect(d.title).toBe('Launch held')
    expect(d.detail).toBe('Held because the campaign is paused, auto-send has to stay off and auto-reply has to stay off.')
    expect(d.detail).not.toMatch(/_/)
  })

  it('names the emergency stop plainly', () => {
    expect(describeEvent(ev('campaign.queue_plan_blocked', 'Blocked by global_emergency_stop_active')).detail)
      .toBe('Held because the emergency stop is on.')
  })

  it('reads the numbers out of conversions, builds and archives', () => {
    expect(describeEvent(ev('campaign.converted_to_live', 'live_state_repaired: purged 3520 proof rows, inserted 5 live rows. Scheduled for 2026-07-01')).detail)
      .toBe('Cleared 3,520 test messages and queued 5 live ones.')
    expect(describeEvent(ev('campaign.targets_built', '1000 target snapshots written. No send_queue rows created.')).title)
      .toBe('Audience built · 1,000 sellers')
    expect(describeEvent(ev('campaign.archived', 'Archived with 1 pending queue rows cancelled.')).detail)
      .toBe('1 waiting message was cancelled.')
    expect(describeEvent(ev('campaign.activated', 'Activated with 0 queue rows inserted; 0 targets skipped; 24 total queue rows.')).detail)
      .toBe('24 messages already in the queue.')
  })

  it('never shows a bare code as the detail', () => {
    expect(describeEvent(ev('campaign.something_new', 'some_internal_code')).detail).toBeNull()
    expect(describeEvent(ev('campaign.something_new', '')).title).toBe('Something new')
  })
})

describe('buildActivity', () => {
  it('folds a run of identical ticks into one line with a count', () => {
    const events = [
      ev('campaign.launch_blocked', 'Blocked by campaign_status_not_queueable:paused', { severity: 'warning', created_at: '2026-09-24T00:41:17Z' }),
      ...Array.from({ length: 20 }, () => ev('campaign.launch_scheduled', '0 targets planned; 0 queue rows created.')),
      ev('campaign.activated', '', { created_at: '2026-06-20T19:14:00Z' }),
    ]
    const out = buildActivity(events)
    expect(out.map((e) => [e.title, e.count])).toEqual([
      ['Launch held', 1],
      ['Checked for sellers to queue', 20],
      ['Campaign started', 1],
    ])
    const run = out[1]
    expect(Date.parse(run.at)).toBeGreaterThan(Date.parse(run.firstAt))
  })

  it('does not fold events that are separated by something else', () => {
    const out = buildActivity([
      ev('campaign.updated', '', { created_at: '2026-09-03T00:00:00Z' }),
      ev('campaign.launch_blocked', 'Blocked by global_emergency_stop_active', { created_at: '2026-09-02T00:00:00Z' }),
      ev('campaign.updated', '', { created_at: '2026-09-01T00:00:00Z' }),
    ])
    expect(out).toHaveLength(3)
  })
})

describe('groupActivityByDay', () => {
  it('labels today and yesterday, then dates', () => {
    const now = new Date('2026-09-24T12:00:00')
    const groups = groupActivityByDay(buildActivity([
      ev('campaign.updated', '', { created_at: new Date('2026-09-24T09:00:00').toISOString() }),
      ev('campaign.created', '', { created_at: new Date('2026-09-23T09:00:00').toISOString() }),
      ev('campaign.cloned', '', { created_at: new Date('2026-09-01T09:00:00').toISOString() }),
    ]), now)
    expect(groups.map((g) => g.day).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(groups).toHaveLength(3)
  })
})
