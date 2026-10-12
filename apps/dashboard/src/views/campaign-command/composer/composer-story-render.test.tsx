/**
 * The Composer's premium surfaces render (static markup): the story rail,
 * the audience lens (ring, funnel, markets), the phone, and the AI assist —
 * which only ever hands a read-only question to the agent dock.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AiAssist, AudienceLens, PhonePreview, StoryRail } from './ComposerStory'
import { storySteps } from './composer-story'
import type { ComposerAudience } from './composer-types'

const audience = {
  ok: true, at: '2026-10-12T00:00:00Z', strategy: { use_case: 'ownership_check', stage_code: 'S1' },
  matched: 1200, addressable: 1100, reachable: 900, sms_eligible: 820, clean: 700, eligible_in_audience: 680,
  exclusions: { suppressed: 10, dnc: 0, wrong_number: 2, no_phone: 300, sms_ineligible: 80, no_sender_route: 0, pending_prior_touch: 30, active_queue: 0 },
  build: { ok: true, whole_cohort: true, ready: 650, sendable_now: 640, held: 10, held_by_reason: {}, rows_read: 680, recipients: 660 },
  universe: { count: 5000, location_filters: ['properties.market'], targeting_filters: [] },
  distributions: { markets: [{ value: 'Dallas, TX', label: 'Dallas, TX', count: 1200 }], languages: [], property_types: [], zips: [], zones: [] },
  zones: { scanned: 0, unresolved: 0 }, inapplicable_filters: [], unsupported_filters: [], dropped_filter_count: 0, graph_freshness: {}, graph_unavailable: false, warnings: [],
  samples: [{ id: 's1', property_id: 'p1', recipient: 'Redacted', place: 'Dallas, TX', market: 'Dallas, TX', language: 'en', ok: true, text: 'Hi there — is this still your place on Elm St?', template_id: 't-1', reason: null }],
} as unknown as ComposerAudience
const ctx = { name: 'Dallas', filters: [{ label: 'Market', value: 'Dallas, TX' }], matched: 1200, eligible: 640, markets: ['Dallas, TX'], strategy: null }

describe('composer story surfaces', () => {
  it('the rail tells four steps with their states', () => {
    const steps = storySteps({ audience: '1,200 → 640 eligible' }, (l) => (l === 'audience' ? 'ok' : 'checking'))
    const html = renderToStaticMarkup(<div className="ccz"><StoryRail steps={steps} onStep={() => {}} /></div>)
    for (const t of ['Audience', 'Message', 'Schedule', 'Review']) expect(html).toContain(t)
    expect(html).toContain('is-ok')
    expect(html).toContain('aria-label="Composition story"')
  })
  it('the lens draws the ring, the funnel and the market mix from the audience read', () => {
    const html = renderToStaticMarkup(<AudienceLens audience={audience} eligible={640} loading={false} labelOf={(k) => k} assist={ctx} />)
    expect(html).toContain('of matched are sendable today')
    expect(html).toContain('Market universe')
    expect(html).toContain('Dallas, TX')
    expect(html).toContain('AI assist')
    expect(renderToStaticMarkup(<AudienceLens audience={null} eligible={null} loading labelOf={(k) => k} />)).toContain('aria-busy="true"')
  })
  it('the phone shows the rendered sample with its segment count', () => {
    const html = renderToStaticMarkup(<PhonePreview samples={audience.samples} loading={false} />)
    expect(html).toContain('is this still your place on Elm St?')
    expect(html).toMatch(/\d+ chars · 1 segment/)
    expect(renderToStaticMarkup(<PhonePreview samples={[]} loading />)).toContain('Rendering from real targets')
  })
  it('AI assist is disabled (with the reason) when the agent is off, and only ever sends an "ask"', () => {
    const off = renderToStaticMarkup(<AiAssist context={ctx} kinds={['explain']} enabled={false} />)
    expect(off).toMatch(/<button[^>]*disabled/)
    const send = vi.fn()
    const on = renderToStaticMarkup(<AiAssist context={ctx} kinds={['explain', 'segment']} enabled send={send} />)
    expect(on).toContain('Explain this audience')
    expect(on).toContain('Suggest a segment')
    expect(on).toContain('read-only')
  })
})
