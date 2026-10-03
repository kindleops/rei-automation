import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  CLUSTER_AT, isReservedHue, marketNote, marketsOfSpec, planCameraIntent, previewFeatures, previewPaint, previewTitle,
  readFollowMode, shouldCluster, statusLine, unionBounds, writeFollowMode, type GeoPreview,
} from './preview-model'
import { CP_LAYERS, CP_SOURCE, repaintPreviewLayer, removePreviewLayer, setPreviewMode, syncPreviewLayer } from './preview-layer'
import {
  __campaignPreviewTest, clearCampaignPreview, getCampaignPreview, latestCampaignPreviewKey, previewSpecKey, publishCampaignPreview, resolvePreviewBinding,
} from '../../../../domain/campaign-preview/campaign-preview-context'

const SPEC = { filters: { properties: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Minneapolis, MN', 'Dallas, TX'] }] }, template_use_case: 'ownership_check' }

function geo(n: number, markets = 1): GeoPreview {
  const ids: string[] = [], lng: number[] = [], lat: number[] = [], market: number[] = []
  for (let i = 0; i < n; i += 1) { ids.push(String(270000000 + i)); lng.push(-93.2 - (i % 997) / 1e4); lat.push(44.9 + (i % 991) / 1e4); market.push(i % markets) }
  return {
    ok: true, at: '2026-10-03T22:00:00Z', eligible: n, mapped: n, unmapped: 0,
    reconciliation: { composer_eligible: n, matches: true, delta: 0 }, excluded: { held_by_build: 0, not_routable: 0, no_greeting: 0 },
    ready: n, capped_by_build_limit: false, build_limit: 100000,
    markets: Array.from({ length: markets }, (_, i) => ({ market: `M${i}`, eligible: 0, mapped: 0, unmapped: 0, not_routable: 0, no_greeting: 0, bbox: [-93.3, 44.9, -93.2, 45] as [number, number, number, number] })),
    points: { ids, lng, lat, market },
  }
}

describe('data truth', () => {
  it('draws exactly the points the server returned — unusable coordinates dropped, never invented', () => {
    const g = geo(4)
    g.points.lng[1] = 0; g.points.lat[1] = 0 // placeholder, not a location
    g.points.lat[2] = Number.NaN
    const fc = previewFeatures(g)
    expect(fc.features.map((f) => f.properties.pid)).toEqual([g.points.ids[0], g.points.ids[3]])
    expect(previewFeatures(null).features).toHaveLength(0)
  })

  it('words eligible / mapped / without coordinates from the server counts', () => {
    expect(statusLine({ eligible: 2552, mapped: 2487, unmapped: 65 })).toBe('2,552 eligible · 2,487 mapped · 65 without coordinates')
    expect(statusLine({ eligible: 2432, mapped: 2432, unmapped: 0 })).toBe('2,432 eligible · 2,432 mapped')
  })

  it('explains an empty market only with server-counted reasons', () => {
    expect(marketNote({ market: 'Phoenix, AZ', eligible: 0, mapped: 0, unmapped: 0, not_routable: 2843, no_greeting: 0, bbox: null })).toBe('No sender route')
    expect(marketNote({ market: 'Dallas, TX', eligible: 10, mapped: 8, unmapped: 2, not_routable: 0, no_greeting: 0, bbox: [0, 0, 1, 1] })).toBe('2 without coordinates')
  })

  it('reads the markets from the Composer clauses in the order chosen', () => {
    expect(marketsOfSpec(SPEC.filters)).toEqual(['Minneapolis, MN', 'Dallas, TX'])
    expect(previewTitle(['Minneapolis, MN', 'Dallas, TX'])).toBe('Campaign Preview · Minneapolis + Dallas')
    expect(previewTitle(['Minneapolis, MN', 'Dallas, TX', 'Jacksonville, FL'])).toBe('Campaign Preview · Minneapolis + 2 markets')
  })

  it('frames the union of mapped markets only', () => {
    expect(unionBounds([{ bbox: [-97.5, 32.5, -96.5, 33] }, { bbox: null }, { bbox: [-93.7, 44.8, -92.9, 45.2] }])).toEqual([[-97.5, 32.5], [-92.9, 45.2]])
    expect(unionBounds([{ bbox: null }])).toBeNull()
  })
})

describe('camera: cinematic on intent, calm on iteration', () => {
  const M = ['Minneapolis, MN']
  const MD = ['Minneapolis, MN', 'Dallas, TX']
  it('activation frames; filter edits never move the camera', () => {
    expect(planCameraIntent({ cause: 'activated', mode: 'auto', prevMarkets: null, nextMarkets: M })).toEqual({ kind: 'frame_all' })
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'auto', prevMarkets: M, nextMarkets: M })).toBeNull()
  })
  it('adding a market acknowledges it and fits the combined audience; removing re-fits', () => {
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'auto', prevMarkets: M, nextMarkets: MD })).toEqual({ kind: 'arrive', market: 'Dallas, TX' })
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'auto', prevMarkets: MD, nextMarkets: M })).toEqual({ kind: 'frame_all' })
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'auto', prevMarkets: [], nextMarkets: M })).toEqual({ kind: 'frame_all' })
  })
  it('Markets follow goes to the market added; Manual never moves on its own', () => {
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'markets', prevMarkets: M, nextMarkets: MD })).toEqual({ kind: 'frame_market', market: 'Dallas, TX' })
    expect(planCameraIntent({ cause: 'activated', mode: 'manual', prevMarkets: null, nextMarkets: MD })).toBeNull()
    expect(planCameraIntent({ cause: 'audience_changed', mode: 'manual', prevMarkets: M, nextMarkets: MD })).toBeNull()
    // the operator's own Frame Campaign always frames
    expect(planCameraIntent({ cause: 'frame_request', mode: 'manual', prevMarkets: MD, nextMarkets: MD })).toEqual({ kind: 'frame_all' })
  })
  it('persists the follow mode per pane for the session', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) } }
    expect(readFollowMode('i1', store)).toBe('auto')
    writeFollowMode('i1', 'manual', store)
    expect(readFollowMode('i1', store)).toBe('manual')
    expect(readFollowMode('i2', store)).toBe('auto')
  })
})

describe('themes + day/night: accent, never semantic red / green / amber', () => {
  it('keeps the default teal and falls back from reserved hues to execution cyan', () => {
    expect(previewPaint({ accentRgb: '94, 234, 212', styleMode: 'dark_ops' }).core).toBe('rgb(94, 234, 212)')
    expect(isReservedHue([255, 69, 58])).toBe(true) // red ops accent
    expect(isReservedHue([61, 220, 151])).toBe(true) // verified green
    expect(isReservedHue([240, 179, 90])).toBe(true) // attention amber
    expect(previewPaint({ accentRgb: '255, 69, 58', execRgb: '76, 201, 240', styleMode: 'red_ops' }).core).toBe('rgb(76, 201, 240)')
    expect(previewPaint({ accentRgb: '61, 220, 151', execRgb: '76, 201, 240', styleMode: 'dark_ops' }).core).toBe('rgb(76, 201, 240)')
  })
  it('rims dots for the basemap: white on light maps, near-black on dark', () => {
    expect(previewPaint({ accentRgb: '94, 234, 212', styleMode: 'light_street' }).stroke).toMatch(/255, 255, 255/)
    expect(previewPaint({ accentRgb: '94, 234, 212', styleMode: 'satellite' }).stroke).toMatch(/4, 7, 12/)
  })
  it('paint has no time input — day/night never redraws the campaign points', () => {
    const a = previewPaint({ accentRgb: '94, 234, 212', styleMode: 'dark_ops' })
    vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
    const b = previewPaint({ accentRgb: '94, 234, 212', styleMode: 'dark_ops' })
    vi.useRealTimers()
    expect(b).toEqual(a)
  })
})

/* a fake map: records what the layer does (no N+1, no re-init) */
function fakeMap() {
  const sources = new Map<string, { opts: Record<string, unknown>; setData: ReturnType<typeof vi.fn> }>()
  const layers = new Map<string, Record<string, unknown>>()
  const calls = { addSource: 0, addLayer: 0, setData: 0, setPaint: 0, removeSource: 0 }
  const map = {
    isStyleLoaded: () => true,
    getStyle: () => ({}),
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, opts: Record<string, unknown>) => { calls.addSource += 1; sources.set(id, { opts, setData: vi.fn(() => { calls.setData += 1 }) }) },
    addLayer: (l: Record<string, unknown>) => { calls.addLayer += 1; layers.set(String(l.id), l) },
    removeLayer: (id: string) => { layers.delete(id) },
    removeSource: (id: string) => { calls.removeSource += 1; sources.delete(id) },
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(() => { calls.setPaint += 1 }),
    setFilter: vi.fn(),
  }
  return { map: map as unknown as import('maplibre-gl').Map, calls, layers, sources }
}

describe('the layer: one dedicated source, updates are setData', () => {
  const paint = previewPaint({ accentRgb: '94, 234, 212', styleMode: 'dark_ops' })
  it('creates once, then a filter change is one setData (no layer churn)', () => {
    const { map, calls } = fakeMap()
    expect(syncPreviewLayer(map, previewFeatures(geo(500)), { clustered: false, mode: 'audience', paint })).toBe(true)
    const layersAfterCreate = calls.addLayer
    syncPreviewLayer(map, previewFeatures(geo(450)), { clustered: false, mode: 'audience', paint })
    expect(calls.addSource).toBe(1)
    expect(calls.addLayer).toBe(layersAfterCreate)
    expect(calls.setData).toBe(1)
  })
  it('auto-clusters at scale (source re-created only when clustering flips)', () => {
    const { map, calls, sources, layers } = fakeMap()
    syncPreviewLayer(map, previewFeatures(geo(500)), { clustered: shouldCluster(500), mode: 'audience', paint })
    syncPreviewLayer(map, previewFeatures(geo(CLUSTER_AT + 1)), { clustered: shouldCluster(CLUSTER_AT + 1), mode: 'audience', paint })
    expect(calls.addSource).toBe(2)
    expect(sources.get(CP_SOURCE)?.opts.cluster).toBe(true)
    expect(layers.has(CP_LAYERS.cluster)).toBe(true)
  })
  it('repaint (theme / accent) touches paint only; Density is visibility only', () => {
    const { map, calls } = fakeMap()
    syncPreviewLayer(map, previewFeatures(geo(10)), { clustered: false, mode: 'audience', paint })
    const before = calls.setData
    repaintPreviewLayer(map, previewPaint({ accentRgb: '120, 140, 255', styleMode: 'light_street' }))
    setPreviewMode(map, 'density')
    expect(calls.setData).toBe(before)
    expect(calls.addSource).toBe(1)
    removePreviewLayer(map)
    expect(calls.removeSource).toBe(1)
  })
})

describe('performance (measured): feature build at 500 / 2,500 / 10,000 / 50,000', () => {
  it('builds every size well inside one frame budget per 10K', () => {
    const out: Record<number, number> = {}
    for (const n of [500, 2500, 10000, 50000]) {
      const g = geo(n, 3)
      const t = performance.now()
      const fc = previewFeatures(g)
      out[n] = Math.round((performance.now() - t) * 10) / 10
      expect(fc.features).toHaveLength(n)
    }
    console.info('[campaign preview] previewFeatures ms', JSON.stringify(out), '· clustered ≥', CLUSTER_AT)
    expect(out[50000]).toBeLessThan(400)
    expect(shouldCluster(2500)).toBe(false)
    expect(shouldCluster(10000)).toBe(true)
  })
})

describe('shared preview context: pane binding', () => {
  beforeEach(() => __campaignPreviewTest.reset())
  const ctx = (key: string, over: Partial<Parameters<typeof publishCampaignPreview>[0]> = {}) => ({
    key, draftId: null, name: 'Minneapolis · Oct 3', markets: ['Minneapolis, MN'], activeMarket: 'Minneapolis, MN', spec: SPEC, specKey: previewSpecKey(SPEC), composerEligible: 2432, section: null, ...over,
  })
  it('prefers the pane opened from that Composer; otherwise the newest live preview', () => {
    publishCampaignPreview(ctx('A'))
    publishCampaignPreview(ctx('B'))
    const isLive = (k: string) => Boolean(getCampaignPreview(k))
    expect(resolvePreviewBinding({ pathKey: 'A', pinned: false, follows: true, isLive, latest: latestCampaignPreviewKey() })).toEqual({ key: 'A', reason: 'path' })
    expect(resolvePreviewBinding({ pathKey: null, pinned: false, follows: true, isLive, latest: latestCampaignPreviewKey() })).toEqual({ key: 'B', reason: 'latest' })
  })
  it('a pinned pane never adopts a preview it was not opened with', () => {
    publishCampaignPreview(ctx('A'))
    const isLive = (k: string) => Boolean(getCampaignPreview(k))
    expect(resolvePreviewBinding({ pathKey: null, pinned: true, follows: false, isLive, latest: 'A' }).key).toBeNull()
    expect(resolvePreviewBinding({ pathKey: 'A', pinned: true, follows: false, isLive, latest: 'A' }).key).toBe('A')
  })
  it('a closed Composer ends its preview; a stale path never stays attached', () => {
    publishCampaignPreview(ctx('A'))
    clearCampaignPreview('A')
    const isLive = (k: string) => Boolean(getCampaignPreview(k))
    expect(resolvePreviewBinding({ pathKey: 'A', pinned: false, follows: true, isLive, latest: latestCampaignPreviewKey() })).toEqual({ key: null, reason: 'none' })
    publishCampaignPreview(ctx('C', { name: 'Dallas' }))
    expect(resolvePreviewBinding({ pathKey: 'A', pinned: false, follows: true, isLive, latest: latestCampaignPreviewKey() }).key).toBe('C')
  })
  it('re-publishing identical content does not notify', () => {
    publishCampaignPreview(ctx('A'))
    const first = getCampaignPreview('A')!.updatedAt
    publishCampaignPreview(ctx('A'))
    expect(getCampaignPreview('A')!.updatedAt).toBe(first)
  })
})
