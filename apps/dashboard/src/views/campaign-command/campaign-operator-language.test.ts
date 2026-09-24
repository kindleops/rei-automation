import { describe, expect, it } from 'vitest'
import {
  formatRatePct,
  campaignContextLine,
  campaignMetrics,
  campaignProgress,
  describeBlocker,
  describeCampaignStatus,
  RATE_MIN_SAMPLE,
} from './campaign-operator-language'
import { PRIMARY_FILTERS, SECONDARY_FILTERS, summaryLine } from './mobile/CampaignCommandMobile'
import { matchesListFilter } from './campaign-health'
import type { CampaignSummary } from './campaigns.types'

const campaign = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: 'c1',
  campaign_name: 'Test campaign',
  status: 'draft',
  total_targets: 0,
  ready_targets: 0,
  scheduled_targets: 0,
  queued_targets: 0,
  sent_count: 0,
  delivered_count: 0,
  failed_count: 0,
  reply_count: 0,
  positive_reply_count: 0,
  negative_reply_count: 0,
  opt_out_count: 0,
  delivery_rate: 0,
  reply_rate: 0,
  positive_rate: 0,
  opt_out_rate: 0,
  failure_rate: 0,
  next_send_at: null,
  last_send_at: null,
  send_interval_seconds: 45,
  send_window_start: null,
  send_window_end: null,
  auto_send_enabled: false,
  health_score: 100,
  health_status: 'healthy',
  ...over,
}) as CampaignSummary

// ── B. lifecycle states map to operator language ──────────────────────────
describe('campaign state mapping', () => {
  it('B. live / paused / scheduled / completed / draft each read plainly', () => {
    expect(describeCampaignStatus(campaign({ status: 'active', ready_targets: 10 })).label).toBe('Live')
    expect(describeCampaignStatus(campaign({ status: 'paused' })).label).toBe('Paused')
    expect(describeCampaignStatus(campaign({ status: 'scheduled' })).label).toBe('Scheduled')
    expect(describeCampaignStatus(campaign({ status: 'completed' })).label).toBe('Completed')
    expect(describeCampaignStatus(campaign({ status: 'draft' })).label).toBe('Draft')
  })

  it('quarantine outranks every other state, including test mode', () => {
    const s = describeCampaignStatus(campaign({ status: 'active', quarantined: true, operator_state: 'test_mode' }))
    expect(s.state).toBe('blocked')
    expect(s.needsOperator).toBe(true)
  })

  it('test mode outranks live, because "nothing transmits" is the headline fact', () => {
    expect(describeCampaignStatus(campaign({ status: 'active', operator_state: 'test_mode' })).state).toBe('test')
  })

  it('a built campaign is not reported as an untouched draft', () => {
    expect(describeCampaignStatus(campaign({ status: 'built' as never, total_targets: 12 })).label).toBe('Ready')
  })

  it('a live campaign with nothing ready needs a person', () => {
    const s = describeCampaignStatus(campaign({ status: 'active', ready_targets: 0 }))
    expect(s.needsOperator).toBe(true)
    expect(s.detail).toMatch(/ready to receive/i)
  })
})

// ── §6. no developer language reaches the screen ──────────────────────────
describe('developer language', () => {
  it('an unmapped canonical code never reaches the operator verbatim', () => {
    expect(describeBlocker('no_ready_recipients_in_target_snapshot')).toBe('No sellers are ready to receive messages yet.')
    // A bare snake_case token is our enum, not a sentence.
    expect(describeBlocker('some_future_code')).toBe('Setup needs attention before this can launch.')
  })

  it('a real human sentence from the backend is passed through', () => {
    expect(describeBlocker('x', 'Sender pool is empty for this market.')).toBe('Sender pool is empty for this market.')
  })

  it('no status string shouts', () => {
    for (const status of ['active', 'paused', 'scheduled', 'completed', 'draft', 'failed'] as const) {
      const { label } = describeCampaignStatus(campaign({ status: status as never }))
      expect(label).not.toBe(label.toUpperCase())
    }
  })
})

// ── K. metrics omit unavailable values rather than fabricate them ─────────
describe('metric honesty', () => {
  it('K. a rate is withheld until there is a sample to compute it from', () => {
    const thin = campaignMetrics(campaign({ sent_count: 9, delivered_count: 9, delivery_rate: 1 }))
    expect(thin[0]).toMatchObject({ label: 'Delivered', value: '9' })

    // delivery_rate is ALREADY A PERCENTAGE. This fixture previously used 0.95,
    // which encoded the same wrong assumption as the code and so passed while
    // production rendered Miami's 99.2 as "9920% Delivered".
    const fat = campaignMetrics(campaign({ sent_count: RATE_MIN_SAMPLE, delivered_count: 19, delivery_rate: 95 }))
    expect(fat[0]).toMatchObject({ label: 'Delivered', value: '95%' })
  })

  it('K. zero-valued metrics are dropped, never rendered as grey zeros', () => {
    const m = campaignMetrics(campaign({ sent_count: 40, delivered_count: 38, delivery_rate: 95 }))
    expect(m.map((x) => x.key)).not.toContain('replies')
    expect(m.map((x) => x.key)).not.toContain('qualified')
  })

  it('never renders more than three metrics', () => {
    const m = campaignMetrics(campaign({
      sent_count: 500, delivered_count: 480, delivery_rate: 96, reply_count: 40, positive_reply_count: 9,
    }))
    expect(m.length).toBeLessThanOrEqual(3)
  })

  it('progress is omitted entirely when there is no denominator', () => {
    expect(campaignProgress(campaign({ total_targets: 0, sent_count: 9 }))).toBeNull()
    expect(campaignProgress(campaign({ total_targets: 854, sent_count: 504 }))).toMatchObject({ pct: 59 })
  })

  it('absent market is omitted, not printed as "No market set"', () => {
    expect(campaignContextLine(campaign({ total_targets: 0 }))).toBe('')
    expect(campaignContextLine(campaign({ market_label: 'Atlanta', total_targets: 4595 }))).toBe('Atlanta · 4.6k sellers')
  })

  it('one seller is not "1 sellers"', () => {
    expect(campaignContextLine(campaign({ total_targets: 1 }))).toBe('1 seller')
  })
})

// ── L. filters are canonical and actually filter ──────────────────────────
describe('list filters', () => {
  it('L. every primary filter is a value matchesListFilter actually handles', () => {
    // The previous chip row passed 'active', which is not a CampaignListFilter.
    // matchesListFilter has no branch for it and falls through to `return true`,
    // so the "Active" chip silently showed the entire book.
    const live = campaign({ status: 'active' })
    const draft = campaign({ status: 'draft' })
    for (const { key } of PRIMARY_FILTERS) {
      if (key === 'all') continue
      const matchesEverything = matchesListFilter(live, key) && matchesListFilter(draft, key)
      expect(matchesEverything, `filter "${key}" does not discriminate`).toBe(false)
    }
  })

  it('L. secondary filters are canonical too', () => {
    for (const { key } of SECONDARY_FILTERS) {
      expect(() => matchesListFilter(campaign(), key)).not.toThrow()
    }
    expect(matchesListFilter(campaign({ status: 'active' }), 'live')).toBe(true)
    expect(matchesListFilter(campaign({ status: 'draft' }), 'live')).toBe(false)
  })
})

// ── header summary ────────────────────────────────────────────────────────
describe('index summary line', () => {
  it('says nothing when there is nothing to say', () => {
    expect(summaryLine({ running: 0, attention: 0, scheduled: 0 }, 'normal')).toBe('')
  })

  it('leads with what is running and ends with what needs a person', () => {
    expect(summaryLine({ running: 3, attention: 1, scheduled: 2 }, 'normal'))
      .toBe('3 active · 2 scheduled · 1 needs attention')
  })

  it('pluralises attention correctly', () => {
    expect(summaryLine({ running: 0, attention: 2, scheduled: 0 }, 'normal')).toBe('2 need attention')
  })

  it('surfaces a non-normal send posture, and stays quiet about a normal one', () => {
    expect(summaryLine({ running: 1, attention: 0, scheduled: 0 }, 'normal')).toBe('1 active')
    expect(summaryLine({ running: 1, attention: 0, scheduled: 0 }, 'scoped_canary_only'))
      .toBe('1 active · sending paused')
  })
})

// ── the shipped 9920% bug, pinned to the real production row ──────────────
describe('rate scale', () => {
  it('Miami (sent 354, delivery_rate 99.2) reads 99%, not 9920%', () => {
    const miami = campaign({
      campaign_name: 'Miami - Test Campaign', status: 'paused', operator_state: 'test_mode',
      total_targets: 802, sent_count: 354, delivered_count: 351, failed_count: 30, delivery_rate: 99.2,
    })
    const m = campaignMetrics(miami)
    expect(m[0]).toMatchObject({ key: 'delivery', value: '99%' })
    for (const metric of m) expect(metric.value).not.toMatch(/\d{3,}%/)
  })

  it('formatRatePct never rounds a near-perfect rate up to 100%', () => {
    expect(formatRatePct(99.6)).toBe('99%')
    expect(formatRatePct(100)).toBe('100%')
    expect(formatRatePct(77.8)).toBe('78%')
    expect(formatRatePct(null)).toBe('—')
    expect(formatRatePct(140)).toBe('100%')
  })
})

describe('paused vs test mode', () => {
  it('a paused campaign in test mode headlines as Paused, not Test', () => {
    const s = describeCampaignStatus(campaign({ status: 'paused', operator_state: 'test_mode', sent_count: 354 }))
    expect(s.label).toBe('Paused')
    expect(s.detail).toMatch(/test mode/i)
  })

  it('test-mode copy is forward-looking, never a blanket claim history can falsify', () => {
    const s = describeCampaignStatus(campaign({ status: 'active', operator_state: 'test_mode', sent_count: 9 }))
    expect(s.state).toBe('test')
    expect(s.detail).not.toMatch(/^No messages will be sent/)
    expect(s.detail).toMatch(/new messages/i)
  })
})
