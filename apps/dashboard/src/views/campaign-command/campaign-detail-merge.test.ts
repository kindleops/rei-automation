import { describe, expect, it } from 'vitest'
import { mergeCampaignDetail } from './campaign-detail-merge'
import type { CampaignSummary } from './campaigns.types'

/** The measured Miami rows: list vs detail disagree on every delivery figure. */
const listRow = {
  id: '320c798a', campaign_name: 'Miami - Test Campaign', status: 'paused', operator_state: 'test_mode',
  total_targets: 802, ready_targets: 789, scheduled_targets: 0, queued_targets: 0,
  sent_count: 354, delivered_count: 351, failed_count: 30, delivery_rate: 99.2,
  reply_count: 0, positive_reply_count: 0, negative_reply_count: 0, opt_out_count: 0,
  reply_rate: 0, positive_rate: 0, opt_out_rate: 0, failure_rate: 0,
  last_send_at: '2026-06-20T23:46:30.000Z',
} as unknown as CampaignSummary

const detailSummary = {
  id: '320c798a', status: 'paused', operator_state: undefined,
  sent_count: 0, delivered_count: 0, failed_count: 16, delivery_rate: 0,
  planned_targets: 13, ready_targets: 789, last_send_at: null,
  launch_readiness: 'warnings',
} as unknown as Partial<CampaignSummary>

describe('mergeCampaignDetail', () => {
  it('the detail payload can no longer flip "354 sent" to "0 sent"', () => {
    const m = mergeCampaignDetail(listRow, detailSummary)
    expect(m.sent_count).toBe(354)
    expect(m.delivered_count).toBe(351)
    expect(m.failed_count).toBe(30)
    expect(m.delivery_rate).toBe(99.2)
  })

  it('an absent operator_state does not erase test mode', () => {
    expect(mergeCampaignDetail(listRow, detailSummary).operator_state).toBe('test_mode')
  })

  it('a null timestamp does not erase a known one', () => {
    expect(mergeCampaignDetail(listRow, detailSummary).last_send_at).toBe('2026-06-20T23:46:30.000Z')
  })

  it('fields the list lacks still flow through from the detail', () => {
    const m = mergeCampaignDetail(listRow, detailSummary)
    expect(m.planned_targets).toBe(13)
    expect(m.launch_readiness).toBe('warnings')
  })

  it('a payload for another campaign is ignored', () => {
    expect(mergeCampaignDetail(listRow, { ...detailSummary, id: 'other' })).toBe(listRow)
    expect(mergeCampaignDetail(listRow, null)).toBe(listRow)
  })
})
