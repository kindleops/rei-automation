import { describe, expect, it } from 'vitest'
import { encodeB64Url } from '../../../domain/analytics/analytics-lab-api'
import { DEFAULT_CONTEXT, makeActions, readContext, sanitize, serverContext, sliceKey, urlFor } from './intel-state'
import type { IntelContext } from './intel-state'
import { stableJson } from './intel-data'

const TZ = 'America/Chicago'

describe('analytical state', () => {
  it('round-trips through the URL exactly', () => {
    const ctx: IntelContext = sanitize({ ...DEFAULT_CONTEXT, lens: 'pipeline', metric: 'delivery_rate', groupBy: 'market', segment: [{ dim: 'market', value: 'minneapolis-mn', label: 'Minneapolis, MN' }], filters: [{ field: 'state', op: 'in', value: ['MN'] }] }, TZ)
    expect(readContext(urlFor(ctx), null, TZ)).toEqual(ctx)
  })

  it('honours the simple hand-off params Home and other apps use', () => {
    const c = readContext('/analytics?metric=reply_rate&lens=geography&range=90d&market=miami-fl&market_label=Miami%2C%20FL', null, TZ)
    expect(c.metric).toBe('reply_rate')
    expect(c.lens).toBe('geography')
    expect(c.range).toEqual({ preset: '90d' })
    expect(c.segment).toEqual([{ dim: 'market', value: 'miami-fl', label: 'Miami, FL' }])
  })

  it('a hand-off param wins over a stored context; an unknown lens or range is ignored', () => {
    const stored = JSON.stringify({ ...DEFAULT_CONTEXT, metric: 'delivery_rate', lens: 'campaigns' })
    expect(readContext('/analytics?metric=sellers_reached', stored, TZ).metric).toBe('sellers_reached')
    expect(readContext('/analytics?metric=sellers_reached', stored, TZ).lens).toBe('campaigns')
    const bad = readContext('/analytics?lens=nope&range=forever', null, TZ)
    expect(bad.lens).toBe('overview')
    expect(bad.range).toEqual({ preset: '30d' })
  })

  it('reads the 2.0 Lab links (mode → lens)', () => {
    const old = encodeB64Url({ v: 1, tz: TZ, mode: 'automation', metric: 'reply_rate', groupBy: null, filters: [], segment: [], range: { preset: '7d' }, compare: { mode: 'previous' }, grain: 'auto' })
    const c = readContext(`/analytics?lab=${old}`, null, TZ)
    expect(c.lens).toBe('automation')
    expect(c.range).toEqual({ preset: '7d' })
  })

  it('the server never sees the lens: switching lenses re-reads nothing', () => {
    const a = sanitize({ ...DEFAULT_CONTEXT, lens: 'overview' }, TZ)
    const b = sanitize({ ...DEFAULT_CONTEXT, lens: 'automation' }, TZ)
    expect(stableJson(serverContext(a))).toBe(stableJson(serverContext(b)))
    expect(serverContext(a).mode).toBe('overview')
    expect(sliceKey(a)).toBe(sliceKey(b))
  })

  it('stable JSON: the same question is the same path whatever the key order', () => {
    expect(stableJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(stableJson({ a: [{ x: 1, y: 2 }], b: 1 }))
  })

  it('actions: one seller cohort at a time; a breadcrumb step replaces its own dimension', () => {
    let ctx = sanitize(DEFAULT_CONTEXT, TZ)
    const act = makeActions((patch) => { ctx = sanitize({ ...ctx, ...(typeof patch === 'function' ? patch(ctx) : patch) }, TZ) })
    act.setCohort('replied', 'Replied sellers')
    act.setCohort('interested', 'Interested sellers')
    expect(ctx.segment).toEqual([{ dim: 'cohort', value: 'interested', label: 'Interested sellers' }])
    act.pushSegment({ dim: 'market', value: 'mpls', label: 'Minneapolis, MN' })
    act.pushSegment({ dim: 'market', value: 'miami', label: 'Miami, FL' })
    expect(ctx.segment.map((s) => s.value)).toEqual(['interested', 'miami'])
    act.setCohort(null)
    expect(ctx.segment.map((s) => s.dim)).toEqual(['market'])
    act.setRange('custom', { start: '2026-09-21T05:00:00.000Z', end: '2026-09-22T05:00:00.000Z' })
    expect(ctx.range).toEqual({ preset: 'custom', start: '2026-09-21T05:00:00.000Z', end: '2026-09-22T05:00:00.000Z' })
    act.clearSlice()
    expect(ctx.segment).toEqual([])
  })
})
