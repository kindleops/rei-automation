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
  buildActivateNowPayload,
  buildCampaignPersistPayload,
  builderStageChoice,
  CAMPAIGN_HYDRATION_CHUNK,
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

  it('never persists the operator browser zone when no market filter names one (RC 7.1)', () => {
    // Map-area / Entity Graph / score-only campaigns have no market filter. The
    // builder used to stamp Intl…resolvedOptions().timeZone (the operator's
    // clock) — "75+ ACQ SCORE", all-Miami, was saved as America/Chicago. The
    // server derives the cohort's zone(s) from the built targets instead.
    const payload = buildCampaignPersistPayload(draft, launch(), serialize) as Record<string, any>
    expect(payload.metadata.timezone).toBeNull()
    expect(payload.metadata.launch_timezone).toBeNull()
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

describe('campaign size is never the worker chunk (the 50-message choke point)', () => {
  // Minneapolis: 503 eligible sellers, batch_max hard-clamped to 50, and the
  // feeder treated batch_max as the whole queue. The operator's size is
  // total_cap; batch_max is only the first hydration chunk.
  it('persists the selected cohort as total_cap, unclamped', () => {
    const payload = buildCampaignPersistPayload(draft, launch({ max_targets: '549' }), serialize) as Record<string, any>
    expect(payload.total_cap).toBe(549)
    expect(payload.batch_max).toBe(CAMPAIGN_HYDRATION_CHUNK)
  })

  it('Activate Now asks for the whole cohort, hydrating one chunk first', () => {
    const payload = buildActivateNowPayload(launch({ max_targets: '549' }), 'c1', 'America/Chicago') as Record<string, any>
    expect(payload.max_targets).toBe(549)
    expect(payload.total_cap).toBe(549)
    expect(payload.batch_max).toBe(CAMPAIGN_HYDRATION_CHUNK)
  })
})

describe('what reopening a saved draft restores', () => {
  it('restores pacing and the window from the campaign, not from presets', () => {
    const restored = hydrateLaunchSettings(launch({
      daily_cap: '750', per_sender_cap: '', contact_window_start: '08:00', contact_window_end: '21:00',
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

describe('per-number daily limit', () => {
  it('is an optional override: blank defers to the server-configured limit, never a builder literal', () => {
    const blank = buildActivateNowPayload(launch({ per_sender_cap: '' }), 'c1', 'America/Chicago') as Record<string, any>
    expect(blank.per_sender_cap).toBeNull()
    const persisted = buildCampaignPersistPayload(draft, launch({ per_sender_cap: '' }), serialize) as Record<string, any>
    expect(persisted.per_sender_cap).toBeNull()
    const override = buildActivateNowPayload(launch({ per_sender_cap: '300' }), 'c1', 'America/Chicago') as Record<string, any>
    expect(override.per_sender_cap).toBe(300)
  })
})

describe('the touch a saved campaign reopens with', () => {
  it('canonical codes the API saves map back to the builder’s choices', () => {
    // The API now saves S1/S2 (what templates carry) instead of 'first_touch'.
    expect(builderStageChoice('S1')).toBe('first_touch')
    expect(builderStageChoice('S2')).toBe('second_touch')
    expect(builderStageChoice('first_touch')).toBe('first_touch')
    expect(builderStageChoice('REENGAGEMENT')).toBe('reengagement')
  })

  it('an unknown or missing code keeps the current choice', () => {
    expect(builderStageChoice(undefined, 'second_touch')).toBe('second_touch')
    expect(builderStageChoice('S6B', 'first_touch')).toBe('first_touch')
  })
})
