import { describe, expect, it } from 'vitest'
import { buildAutomationTrail, humanize, summarizeTrail } from './message-automation-trail'

// Trimmed from a real inbound message_events.metadata (inbound_intelligence_v4).
const real = {
  source: 'textgrid_inbound_webhook',
  language: 'English',
  detected_intent: 'not_interested',
  classification_confidence: 0.92,
  needs_human_review: false,
  automation_decision: {
    reply_mode: 'none',
    disposition: 'not_interested',
    next_action: 'schedule_later_followup',
    follow_up_at: '2026-10-30T04:28:01.327Z',
    lead_temperature: 'cold',
    reply_disposition: 'no_reply',
    should_suppress_contact: false,
    exception_workflow: { label: 'Ambiguous Intent / Context', owner: 'acquisition_rep' },
  },
  payload: {
    stage_before: 'ownership_check',
    stage_after: 'consider_selling',
    auto_reply_queue_id: null,
    metadata: {
      emotion: 'calm',
      language: 'English',
      confidence: 0.92,
      price_parse: { value: null, qualifies_as_seller_asking_price: false },
      seller_state: { emotional_state: 'calm', price_mentioned: null },
      suppression_scope: 'none',
    },
  },
}

describe('message automation trail', () => {
  it('reads the recorded verdict and decision in order', () => {
    const steps = buildAutomationTrail(real)
    expect(steps.map((s) => s.key)).toEqual(['intent', 'sentiment', 'stage', 'temperature', 'next', 'reply', 'workflow'])
    expect(steps[0]).toMatchObject({ label: 'Intent detected', value: 'Not interested · 92%', tone: 'warn' })
    expect(steps.find((s) => s.key === 'stage')!.value).toBe('Ownership check → Consider selling')
    expect(steps.find((s) => s.key === 'next')!.label).toBe('Next · planned')
    expect(steps.find((s) => s.key === 'next')!.value).toMatch(/^Later follow-up · Oct (29|30)$/)
  })

  it('never invents a price, a language step for English, or a review', () => {
    const keys = buildAutomationTrail(real).map((s) => s.key)
    expect(keys).not.toContain('price')
    expect(keys).not.toContain('language')
    expect(keys).not.toContain('review')
    expect(keys).not.toContain('suppressed')
  })

  it('shows an extracted asking price and a non-English language when recorded', () => {
    const steps = buildAutomationTrail({
      ...real,
      language: 'Spanish',
      payload: { ...real.payload, metadata: { ...real.payload.metadata, language: 'Spanish', price_parse: { value: 185000, currency: 'USD', qualifies_as_seller_asking_price: true } } },
    })
    expect(steps.find((s) => s.key === 'price')).toMatchObject({ label: 'Asking price extracted', value: '$185,000', tone: 'good' })
    expect(steps.find((s) => s.key === 'language')!.value).toBe('Spanish')
  })

  it('is empty for a message the automation never touched (outbound, legacy)', () => {
    expect(buildAutomationTrail({ source: 'campaign_launch_execution', queue_key: 'x' })).toEqual([])
    expect(buildAutomationTrail(undefined)).toEqual([])
  })

  it('summarises for the collapsed line', () => {
    expect(summarizeTrail(buildAutomationTrail(real))).toBe('Not interested · 92% · Calm · Ownership check → Consider selling')
    expect(humanize('asks_offer')).toBe('Asks offer')
  })
})

describe('conversation machine v3 audit in the trail (Acquisition OS §81/§83)', () => {
  const v3 = {
    ...real,
    automation_decision: {
      ...real.automation_decision,
      seller_conversation_v3_audit: {
        version: 'seller_conversation_v3_audit_v1',
        stage: 'S3_asking_price',
        objective: 'Discover the asking price',
        checklist: { ownership: 'known', interest: 'known', asking_price: 'unknown', condition: 'unknown', major_repairs: 'unknown', update_years: 'not_applicable', occupancy: 'unknown' },
        next_expected: 'asking price',
        rule: 'v3_s3_yes_continue_price_discovery',
        action: 'reply',
        terminal_action: null,
        seller_situation: { situation: 'FATIGUED_LANDLORD', angle: 'TENANT_RELIEF' },
        negotiation_state: null,
        quoted: null,
      },
    },
  }
  it('adds objective, checklist, waiting-for, situation and why after the stage', () => {
    const steps = buildAutomationTrail(v3)
    const keys = steps.map((s) => s.key)
    expect(keys.slice(keys.indexOf('stage'), keys.indexOf('stage') + 6)).toEqual(['stage', 'v3-objective', 'v3-checklist', 'v3-next', 'v3-situation', 'v3-why'])
    expect(steps.find((s) => s.key === 'v3-objective')?.value).toBe('S3 · Discover the asking price')
    expect(steps.find((s) => s.key === 'v3-checklist')?.value).toBe('2/6 known · open: asking price, condition, major repairs…')
    expect(steps.find((s) => s.key === 'v3-why')?.value).toBe('S3 yes continue price discovery')
  })
  it('shows nothing v3 when the engine recorded no v3 audit (flag off)', () => {
    expect(buildAutomationTrail(real).some((s) => s.key.startsWith('v3-'))).toBe(false)
  })
  it('a quoted number is labelled with its kind, never collapsed', () => {
    const steps = buildAutomationTrail({ ...v3, automation_decision: { ...v3.automation_decision, seller_conversation_v3_audit: { ...v3.automation_decision.seller_conversation_v3_audit, quoted: { kind: 'negotiation_anchor', amount: 210000 } } } })
    expect(steps.find((s) => s.key === 'v3-negotiation')?.value).toBe('Negotiation anchor $210,000')
  })
})
