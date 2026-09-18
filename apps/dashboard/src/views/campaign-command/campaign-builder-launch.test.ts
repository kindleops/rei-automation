/**
 * A SCHEDULE THAT DOES NOT SURVIVE A RELOAD IS NOT A SCHEDULE (§12, §13, §15).
 *
 * The builder persisted pacing to real campaign columns and then never read a
 * single one back, and it never persisted the start time at all. So an operator
 * who set "09:00, 60/hr, 09:00-18:00 window" on their phone, saved, and
 * reopened the draft got 750/day, 08:00-21:00 and "two hours from now" — with
 * nothing on screen to say their settings had been discarded rather than never
 * entered.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCampaignPersistPayload,
  hydrateLaunchSettings,
  toLocalDateTimeInputValue,
  type LaunchPersistSettings,
} from './campaign-builder-launch'

const launch = (over: Partial<LaunchPersistSettings> = {}): LaunchPersistSettings => ({
  daily_cap: '300',
  per_sender_cap: '90',
  per_market_cap: '250',
  max_targets: '40',
  spread_interval_seconds: '60',
  contact_window_start: '09:00',
  contact_window_end: '18:00',
  first_scheduled_at: '2026-09-20T09:00',
  ...over,
})

const draft = {
  name: 'Controlled proof',
  description: '',
  template_use_case: 'cold_outreach',
  stage_code: 'S1',
  target_filters: {},
} as never

const serialize = () => ({})

describe('what the draft actually persists', () => {
  it('carries the operator-entered schedule, not just pacing', () => {
    const payload = buildCampaignPersistPayload(draft, launch(), serialize) as Record<string, any>
    expect(payload.metadata.planned_first_scheduled_at).toBe('2026-09-20T09:00')
  })

  it('records the planned schedule as INTENT, never as the canonical one', () => {
    // `campaigns.scheduled_for` is owned by the state machine and is only
    // meaningful paired with status='scheduled'. Writing it on a draft would
    // claim a campaign is scheduled when no transition happened and no
    // activation will ever fire.
    const payload = buildCampaignPersistPayload(draft, launch(), serialize) as Record<string, any>
    expect(payload.scheduled_for).toBeUndefined()
    expect(payload.status).toBe('draft')
  })

  it('still persists pacing and the contact window to real columns', () => {
    const payload = buildCampaignPersistPayload(draft, launch(), serialize) as Record<string, any>
    expect(payload.daily_cap).toBe(300)
    expect(payload.per_sender_cap).toBe(90)
    expect(payload.send_interval_seconds).toBe(60)
    expect(payload.contact_window_start).toBe('09:00')
    expect(payload.contact_window_end).toBe('18:00')
  })
})

describe('what reopening a saved draft restores', () => {
  it('restores pacing and the window from the campaign, not from presets', () => {
    const restored = hydrateLaunchSettings(launch({
      daily_cap: '750', per_sender_cap: '150', contact_window_start: '08:00', contact_window_end: '21:00',
    }), {
      daily_cap: 300, per_sender_cap: 90, market_cap: 250, total_cap: 40,
      send_interval_seconds: 60, contact_window_start: '09:00', contact_window_end: '18:00',
      metadata: {},
    })

    expect(restored.daily_cap).toBe('300')
    expect(restored.per_sender_cap).toBe('90')
    expect(restored.contact_window_start).toBe('09:00')
    expect(restored.contact_window_end).toBe('18:00')
  })

  it('a genuinely scheduled campaign restores its CANONICAL schedule', () => {
    const at = new Date('2026-09-20T09:00:00')
    const restored = hydrateLaunchSettings(launch({ first_scheduled_at: '' }), {
      scheduled_for: at.toISOString(),
      metadata: { planned_first_scheduled_at: '2026-01-01T00:00' },
    })
    // The live schedule the activation cron will act on wins over stale intent.
    expect(restored.first_scheduled_at).toBe(toLocalDateTimeInputValue(at))
  })

  it('a draft restores the recorded intent', () => {
    const restored = hydrateLaunchSettings(launch({ first_scheduled_at: '' }), {
      metadata: { planned_first_scheduled_at: '2026-09-20T09:00' },
    })
    expect(restored.first_scheduled_at).toBe('2026-09-20T09:00')
  })

  it('an absent value keeps the current setting rather than inventing a zero', () => {
    const restored = hydrateLaunchSettings(launch(), { metadata: {} })
    expect(restored.daily_cap).toBe('300')
    expect(restored.contact_window_start).toBe('09:00')
  })

  it('THE DATETIME INPUT SPEAKS LOCAL TIME, NOT UTC', () => {
    // `toISOString().slice(0,16)` is the obvious-looking one-liner and it
    // shifts the displayed time by the UTC offset — a campaign scheduled for
    // 09:00 reads back as 14:00, and an operator "correcting" it would move
    // the real send.
    const at = new Date(2026, 8, 20, 9, 5)
    expect(toLocalDateTimeInputValue(at)).toBe('2026-09-20T09:05')
  })
})
