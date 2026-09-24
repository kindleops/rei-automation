import { describe, expect, it } from 'vitest'
import { carrierWords, describeException, formatExceptionDate, summarizeExceptions } from './campaign-exceptions'
import type { CampaignFailuresResult } from './campaigns.adapter'
import type { CampaignFailureGroup } from './campaigns.types'

const group = (failure_category: string, count: number, extra: Partial<CampaignFailureGroup> = {}): CampaignFailureGroup => ({
  campaign_id: 'c1',
  failure_category,
  count,
  severity: failure_category.includes('compliance') ? 'critical' : 'warning',
  sample_numbers: [],
  sample_reasons: [],
  ...extra,
})

/** Miami's summary response on 2026-09-24, as the failures API now returns it. */
const MIAMI: CampaignFailuresResult = {
  targetPreparation: [],
  execution: [
    group('expired_before_send', 595, { sample_reasons: ['stale_runnable_row_expired'], latest_at: '2026-07-01T03:30:57.136072+00:00' }),
    group('compliance_terminalization', 16, {
      sample_reasons: [
        'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}',
        'The message From/To pair violates a blacklist rule.',
      ],
      latest_at: '2026-09-09T12:06:29.674193+00:00',
    }),
    group('provider_unconfirmed', 1, { sample_reasons: ['SEND FAILED - NO SID'], latest_at: '2026-09-09T14:53:11.770036+00:00' }),
  ],
  targetTotal: 0,
  executionTotal: 612,
  targetTruncated: false,
  executionTruncated: false,
  source: 'failures_api',
}

describe('carrierWords', () => {
  it('pulls the carrier message out of a TextGrid failure body', () => {
    expect(carrierWords('TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}'))
      .toBe('The message From/To pair violates a blacklist rule.')
  })

  it('never quotes our own codes or all-caps internal errors', () => {
    expect(carrierWords('stale_runnable_row_expired')).toBeNull()
    expect(carrierWords('SEND FAILED - NO SID')).toBeNull()
    expect(carrierWords('{"status":"500"}')).toBeNull()
    expect(carrierWords('')).toBeNull()
    expect(carrierWords(null)).toBeNull()
  })

  it('passes a plain sentence through', () => {
    expect(carrierWords('The message From/To pair violates a blacklist rule.')).toBe('The message From/To pair violates a blacklist rule.')
  })
})

describe('summarizeExceptions — Miami', () => {
  const summary = summarizeExceptions(MIAMI)

  it('reports the API total, not a capped sample', () => {
    expect(summary.sendingTotal).toBe(612)
    expect(summary.sendingIsFloor).toBe(false)
    expect(summary.audienceTotal).toBe(0)
  })

  it('puts what someone can act on first, then the rest by size', () => {
    expect(summary.sending.map((e) => e.category)).toEqual([
      'provider_unconfirmed',
      'compliance_terminalization',
      'expired_before_send',
    ])
    expect(summary.attentionCount).toBe(1)
  })

  it('quotes the carrier once, even when two samples say the same thing', () => {
    const refused = summary.sending.find((e) => e.category === 'compliance_terminalization')!
    expect(refused.copy.title).toBe('Refused by the carrier')
    expect(refused.quotes).toEqual(['The message From/To pair violates a blacklist rule.'])
  })

  it('does not quote the expiry code', () => {
    const expired = summary.sending.find((e) => e.category === 'expired_before_send')!
    expect(expired.quotes).toEqual([])
    expect(expired.copy.tone).toBe('calm')
  })

  it('carries when each kind last happened', () => {
    expect(summary.sending.find((e) => e.category === 'expired_before_send')!.latestAt).toBe('2026-07-01T03:30:57.136072+00:00')
  })
})

describe('summarizeExceptions — edges', () => {
  it('marks a truncated count as a floor', () => {
    const s = summarizeExceptions({ ...MIAMI, executionTotal: 25000, executionTruncated: true })
    expect(s.sendingIsFloor).toBe(true)
    expect(s.sendingTotal).toBe(25000)
  })

  it('treats an unknown category as needing attention, never as harmless', () => {
    const copy = describeException('sending', 'brand_new_failure_kind')
    expect(copy.tone).toBe('attention')
    expect(copy.title).toBe('Brand new failure kind')
  })

  it('reads audience exclusions as sellers left out, separately from sending', () => {
    const s = summarizeExceptions({
      ...MIAMI,
      execution: [],
      executionTotal: 0,
      targetPreparation: [group('no_sender_coverage', 40), group('compliance_suppression', 12)],
      targetTotal: 52,
    })
    expect(s.sendingTotal).toBe(0)
    expect(s.audienceTotal).toBe(52)
    expect(s.audience.map((e) => e.copy.title)).toEqual(['No sender number for their area', 'On a do-not-text list'])
    expect(s.attentionCount).toBe(1)
  })

  it('drops empty groups', () => {
    const s = summarizeExceptions({ ...MIAMI, execution: [group('expired_before_send', 0)], executionTotal: 0 })
    expect(s.sending).toEqual([])
  })
})

describe('describeException — every category the API emits has words', () => {
  // Mirrors STATUS_CATEGORY and classifyExecutionFailure in
  // apps/api/src/lib/domain/campaigns/campaign-failures.js.
  const SENDING_CATEGORIES = [
    'expired_before_send', 'compliance_terminalization', 'provider_unconfirmed', 'provider_failure',
    'invalid_destination', 'missing_template', 'routing_failure', 'duplicate_prevention', 'retry_exhaustion',
    'queue_validation', 'internal_execution_error', 'template_held', 'sender_held', 'health_guard_hold',
    'held_incomplete', 'content_filtered', 'transport_failure', 'undelivered', 'incident_quarantine',
  ]
  const AUDIENCE_CATEGORIES = [
    'compliance_suppression', 'invalid_destination', 'no_sender_coverage', 'missing_template',
    'language_coverage_missing', 'history_unavailable', 'missing_canonical_linkage',
    'eligibility_routing_failed', 'target_preparation_failure',
  ]
  it.each(SENDING_CATEGORIES)('sending: %s', (category) => {
    const copy = describeException('sending', category)
    expect(copy.body).not.toBe('')
    expect(copy.title).not.toMatch(/_/)
  })
  it.each(AUDIENCE_CATEGORIES)('audience: %s', (category) => {
    const copy = describeException('audience', category)
    expect(copy.body).not.toBe('')
    expect(copy.title).not.toMatch(/_/)
  })
})

describe('formatExceptionDate', () => {
  const now = new Date('2026-09-24T12:00:00Z')
  it('drops the year inside the current year', () => {
    expect(formatExceptionDate('2026-07-01T03:30:57Z', now)).not.toMatch(/2026/)
  })
  it('keeps the year for older dates', () => {
    expect(formatExceptionDate('2025-12-30T12:00:00Z', now)).toMatch(/2025/)
  })
  it('returns null for missing or invalid input', () => {
    expect(formatExceptionDate(null, now)).toBeNull()
    expect(formatExceptionDate('not a date', now)).toBeNull()
  })
})
