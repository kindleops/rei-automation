/**
 * Composer story layer (premium redesign 2026-10-12) — presentation only:
 *   - four story steps over the five layers, each step its worst layer's state
 *   - the funnel draws measured stages only; the market mix keeps "N more"
 *   - SMS segments (GSM-7 / UCS-2) for the phone caption
 *   - the AI assist prompt is READ-ONLY by construction and carries no PII
 */
import { describe, expect, it } from 'vitest'
import { assistFilters, assistPrompt, funnelBars, marketBars, phoneSample, sendableShare, smsSegments, storyProgress, storySteps, worstState } from './composer-story'
import type { ComposerAudience, ComposerSample } from './composer-types'
import type { FunnelStage, Layer } from './composer-model'

describe('the story rail', () => {
  it('audience → message → schedule → review over the five layers; a step is its worst layer', () => {
    const states: Record<Layer, 'ok' | 'warn' | 'block' | 'checking'> = { audience: 'ok', strategy: 'ok', delivery: 'warn', schedule: 'ok', launch: 'checking' }
    const steps = storySteps({ audience: '1,000 → 600 eligible', strategy: 'Ownership check', delivery: '300/day', schedule: 'On launch', launch: 'Checking' }, (l) => states[l])
    expect(steps.map((s) => s.id)).toEqual(['audience', 'message', 'schedule', 'review'])
    expect(steps.map((s) => s.layer)).toEqual(['audience', 'strategy', 'delivery', 'launch'])
    expect(steps[2].layers).toEqual(['delivery', 'schedule'])
    expect(steps[2].state).toBe('warn')
    expect(steps[2].line).toBe('On launch · 300/day')
    expect(storyProgress(steps)).toBe(0.75)
    expect(worstState(['idle', 'idle'])).toBe('idle')
    expect(worstState(['ok', 'block', 'warn'])).toBe('block')
  })
})

describe('audience lens', () => {
  it('draws measured funnel stages only, tapered against the first; never a 0 for "not measured"', () => {
    const stages: FunnelStage[] = [
      { key: 'universe', label: 'Market universe', count: 1000, dropped: null, basis: 'graph', reasons: [] },
      { key: 'reachable', label: 'Reachable phone', count: 700, dropped: 300, basis: 'graph', reasons: [] },
      { key: 'routing', label: 'Routing', count: null, dropped: null, basis: 'sample', reasons: [] },
      { key: 'sendable', label: 'Sendable', count: 0, dropped: 700, basis: 'cohort', reasons: [] },
    ]
    const bars = funnelBars(stages)
    expect(bars.map((b) => b.key)).toEqual(['universe', 'reachable', 'sendable'])
    expect(bars[1].share).toBeCloseTo(0.7)
    expect(bars[2].share).toBe(0.015)
  })
  it('market mix: largest first, the tail folded into "N more"; sendable share needs both sides', () => {
    const audience = { distributions: { markets: [{ value: 'a', label: 'A', count: 5 }, { value: 'b', label: 'B', count: 50 }, { value: 'c', label: 'C', count: 3 }, { value: 'z', label: 'Z', count: 0 }], languages: [], property_types: [], zips: [], zones: [] } } as unknown as ComposerAudience
    const bars = marketBars(audience, 2)
    expect(bars.map((b) => b.label)).toEqual(['B', 'A', '1 more'])
    expect(bars[2].count).toBe(3)
    expect(sendableShare(250, 1000)).toBe(0.25)
    expect(sendableShare(null, 1000)).toBeNull()
    expect(sendableShare(5, 0)).toBeNull()
  })
})

describe('phone', () => {
  it('cycles samples both ways; segments follow GSM-7 vs UCS-2', () => {
    const s = [{ id: '1' }, { id: '2' }, { id: '3' }] as ComposerSample[]
    expect(phoneSample(s, -1)!.id).toBe('3')
    expect(phoneSample(s, 4)!.id).toBe('2')
    expect(phoneSample([], 0)).toBeNull()
    expect(smsSegments('Hi Sam, is this still your property on Main St?')).toMatchObject({ segments: 1, unicode: false })
    expect(smsSegments('a'.repeat(161)).segments).toBe(2)
    expect(smsSegments('Hola 🙂').unicode).toBe(true)
    expect(smsSegments('é'.repeat(71))).toMatchObject({ unicode: false, segments: 1 })
    expect(smsSegments('ñ'.repeat(10) + '€').segments).toBe(1)
    expect(smsSegments('').segments).toBe(0)
  })
})

describe('AI assist', () => {
  const ctx = { name: 'Dallas · Oct 12', filters: assistFilters([
    { fieldKey: 'properties.market', label: 'Market', value: ['Dallas, TX'] },
    { fieldKey: 'properties.property_id', label: 'Selected properties', value: ['p1', 'p2', 'p3'] },
    { fieldKey: 'outreach.never_contacted', label: 'Never contacted', value: '' },
  ]), matched: 1200, eligible: 640, markets: ['Dallas, TX'], strategy: 'Ownership check (S1)' }
  it('is read-only by construction, for every kind', () => {
    for (const k of ['explain', 'segment', 'message'] as const) {
      const p = assistPrompt(k, ctx)
      expect(p).toMatch(/^Read-only: explain and suggest only\. Do not change the draft, build targets, launch or send anything\./)
      expect(p).toContain('Matched 1,200 properties; 640 sendable today')
    }
  })
  it('carries filter labels and counts — an id list is a count, never the ids', () => {
    const p = assistPrompt('explain', ctx)
    expect(p).toContain('Selected properties: 3 selected')
    expect(p).not.toMatch(/p1|p2|p3/)
    expect(p).toContain('Never contacted: yes')
    expect(assistPrompt('segment', { ...ctx, matched: null, eligible: null })).toContain('Matched not measured properties; not measured sendable today')
  })
})
