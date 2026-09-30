import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changeTone, decodeB64Url, encodeB64Url, fmtChange, fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import type { MetricDef } from '../../../domain/analytics/analytics-lab-api'

const here = __dirname
const read = (p: string) => readFileSync(join(here, p), 'utf8')
const def = (unit: MetricDef['unit'], polarity: MetricDef['polarity'] = 'up') => ({ unit, polarity } as MetricDef)

describe('Analytics Lab (desktop)', () => {
  it('only the modern desktop renders the Lab; phones keep the existing surface', () => {
    const surface = read('../performance/AnalyticsSurface.tsx')
    expect(surface).toMatch(/if \(!isModernDesktop\) return <AnalyticsPhoneSurface \/>/)
    expect(surface).toMatch(/fetchAnalyticsPerformance/)
  })

  it('never aggregates events or derives a rate in the browser', () => {
    const files = readdirSync(here).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts'))
      .concat(readdirSync(join(here, 'charts')).map((f) => `charts/${f}`))
    for (const f of files) {
      const src = read(f)
      expect(src, f).not.toMatch(/from\(['"](send_queue|message_events|acquisition_opportunit)/)
      expect(src, f).not.toMatch(/\b(replyRate|deliveryRate)\s*=\s*[^=]/)
    }
  })

  it('round-trips the analytical context through the URL', () => {
    const ctx = { v: 1, tz: 'America/Chicago', mode: 'overview', metric: 'reply_rate', filters: [{ field: 'market', op: 'in', value: ['mpls'] }], segment: [{ dim: 'campaign', value: 'c1', label: 'Map area · Minneapolis' }] }
    expect(decodeB64Url(encodeB64Url(ctx))).toEqual(ctx)
    expect(encodeB64Url(ctx)).not.toMatch(/[+/=]/)
  })

  it('rates change in points, counts in absolute + percent (only on a base of 10+)', () => {
    expect(fmtChange(def('rate'), { comparable: true, kind: 'rate', pts: 3.44 })).toBe('+3.4 pts')
    expect(fmtChange(def('count'), { comparable: true, kind: 'count', delta: 516, pct: 3.58 })).toBe('+516 · +358%')
    expect(fmtChange(def('count'), { comparable: true, kind: 'count', delta: 4, pct: null })).toBe('+4')
    expect(fmtChange(def('rate'), { comparable: false, reason: 'needs n ≥ 30' })).toBeNull()
    expect(changeTone(def('rate', 'down'), { comparable: true, kind: 'rate', pts: 2 })).toBe('bad')
    expect(changeTone(def('count', 'neutral'), { comparable: true, kind: 'count', delta: 50 })).toBe('neutral')
    expect(fmtMetric(def('rate'), null)).toBe('—')
  })
})
