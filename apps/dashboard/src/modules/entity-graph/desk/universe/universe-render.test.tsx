/**
 * EG · the Overview page renders data — never "Computing" — and every number
 * is a drill (a button carrying its chip); a scope that does not apply a
 * global filter says so; loading is a skeleton, a failure says retry.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UniverseCardView, UniverseChartView, UniverseView } from './EntityGraphUniverse'
import type { UniverseCard } from './universe-model'

const NOW = new Date('2026-10-12T04:24:04.500Z').getTime()
const props: UniverseCard = {
  id: 'properties', scope: 'properties', label: 'Properties', total: 176603, source: 'facts', as_of: '2026-10-11T04:24:04.500Z',
  applied: [], ignored: [],
  kpis: [{ key: 'sms', label: 'SMS eligible', value: 72681, filter: { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible'] } }],
  charts: [{ key: 'market', label: 'Markets', form: 'bars', buckets: [
    { key: 'Miami, FL', label: 'Miami, FL', count: 20395, filter: { field_key: 'properties.market', operator: 'is_any_of', value: ['Miami, FL'] }, tone: 'value' },
    { key: '__none', label: 'Not recorded', count: 12, filter: null, tone: 'none' },
  ] }],
}
const people: UniverseCard = { ...props, id: 'people', scope: 'people', label: 'People', total: 149802, source: 'live', kpis: [], charts: [], ignored: [{ key: 'markets', values: ['Miami, FL'], reason: 'People has no market field — shown for every market' }] }

describe('the Overview page', () => {
  it('renders the universe with numbers, as-of and sources — never "Computing"', () => {
    const html = renderToStaticMarkup(
      <div className="egdk">
        <UniverseView globals={{ markets: [], states: [] }} onGlobalsChange={() => {}} onDrill={() => {}} now={NOW}
          slots={{ properties: { key: 'k', cards: [props], error: null, loading: false }, people: { key: 'k', cards: [people], error: null, loading: false } }}
          byScope={{ properties: [props], people: [people] }} options={{ markets: [{ value: 'Miami, FL', count: 20395 }], states: [{ value: 'FL', count: 30000 }] }} onRetry={() => {}} />
      </div>,
    )
    expect(html).not.toMatch(/Computing/i)
    expect(html).toContain('Every table, one picture')
    expect(html).toMatch(/As of .* · property facts read model/)
    expect(html).toContain('Miami, FL')
    expect(html).toContain('Applied to every table that has the field')
    // every card of the page has a slot (loaded or skeleton)
    for (const t of ['Properties', 'Pipeline', 'Contacts &amp; reach', 'Owners', 'People', 'Phones', 'Buyers', 'Companies']) expect(html).toContain(t)
  })
  it('a bucket with a chip is a button; context ("Not recorded") is not', () => {
    const html = renderToStaticMarkup(<UniverseChartView chart={props.charts[0]} onPick={() => {}} />)
    expect(html).toMatch(/<button[^>]*class="egu-bar"[^>]*title="Miami, FL: 20,395/)
    expect(html).toMatch(/<div class="egu-bar is-context"/)
  })
  it('a scope that does not apply a global filter says so; failures retry; no data = skeleton', () => {
    const ignored = renderToStaticMarkup(<UniverseCardView id="people" index={4} card={people} loading={false} error={null} onRetry={() => {}} onDrill={() => {}} now={NOW} />)
    expect(ignored).toContain('every market')
    expect(ignored).toMatch(/computed live/)
    const failed = renderToStaticMarkup(<UniverseCardView id="buyers" index={6} card={null} loading={false} error="timeout" onRetry={() => {}} onDrill={() => {}} now={NOW} />)
    expect(failed).toMatch(/did not load — timeout/)
    expect(failed).toContain('Retry')
    const skel = renderToStaticMarkup(<UniverseCardView id="buyers" index={6} card={null} loading error={null} onRetry={() => {}} onDrill={() => {}} now={NOW} />)
    expect(skel).toContain('is-skeleton')
    expect(skel).not.toMatch(/Computing/i)
  })
})
