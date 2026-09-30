/**
 * Mobile Map + Live Activity — focused tests (model + render contract).
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LiveActivityEvent } from '../live-activity-engine'
import {
  ACTIVITY_SCOPES,
  buildMarkerEmphasisExpr,
  dedupeEvents,
  eventAction,
  filterActivity,
  groupByPlace,
  markerEmphasis,
  MARKER_EMPHASIS,
  newEventIds,
  precisionForZoom,
  scopeCounts,
  scopeOf,
  selectionNeedsNudge,
  tierOf,
} from './map-mobile-model'
import { MapMobileChrome } from './MapMobileChrome'

;(globalThis as any).React = React

/**
 * The breakpoint is pinned per test: the phone contract renders the phone chrome,
 * the desk contract the desktop one. (Unpinned, a window-less test resolves to a
 * 1280px desktop — the phone contract would silently test the desk instead.)
 */
const screen = vi.hoisted(() => ({ desk: false }))
/** The realtime stream, pinned: off by default (exactly what a server render sees). */
const stream = vi.hoisted(() => ({ live: false }))
vi.mock("./useRealtimeActivity", () => ({ useRealtimeActivity: () => ({ events: [], live: stream.live, coveredSince: stream.live ? Date.now() - 3600_000 : null }) }))
vi.mock('../../../modules/mobile/useBreakpoint', () => ({
  useBreakpoint: () => ({
    breakpoint: screen.desk ? 'desktop' : 'phone', isPhone: !screen.desk, isTablet: false, isDesktop: screen.desk,
    isMobile: true, isModernDesktop: screen.desk, isLandscapeMobile: false, isCommandCenterLayout: false,
    isPortrait: !screen.desk, width: screen.desk ? 1440 : 390, height: screen.desk ? 900 : 844, layoutWidth: screen.desk ? 1440 : 390, layoutHeight: screen.desk ? 900 : 844,
  }),
}))

const NOW = new Date('2026-09-25T16:00:00Z')
const ev = (over: Partial<LiveActivityEvent> = {}): LiveActivityEvent => ({
  id: 'e1', type: 'new_reply', priority: 'normal', title: 'Seller replied', severity: 'info', channel: 'live',
  summary: '', primaryAction: '', secondaryAction: null, occurredAt: '2026-09-25T15:58:00Z', receivedAt: '2026-09-25T15:58:00Z',
  source: 'thread', isUnread: true, isPinned: false, isAcknowledged: false, rankScore: 0, isGlobalCritical: false,
  lat: 29.76, lng: -95.37, targetType: 'seller', targetId: 't1', address: '8111 N El Dorado St', market: 'Houston, TX',
  ...over,
} as LiveActivityEvent)

describe('marker hierarchy (A, B)', () => {
  it('A: a selected property is strongest', () => {
    expect(markerEmphasis({ pin_selected: 1 })).toBe(MARKER_EMPHASIS.selected)
    expect(markerEmphasis({ pin_selected: 1, ring_color: '#30d158' })).toBe(1)
  })
  it('B: untouched properties are quieter than worked and live ones', () => {
    const quiet = markerEmphasis({})
    const staged = markerEmphasis({ ring_color: '#30d158' })
    const live = markerEmphasis({ motion: 'reply_ripple' })
    expect(quiet).toBeLessThan(staged)
    expect(staged).toBeLessThanOrEqual(live)
    // the map's defaults (grey ring, a priority_tier on nearly everything) are NOT "worked"
    expect(markerEmphasis({ ring_color: '#7A8FA8', priority_tier: 50, motion: 'static' })).toBe(MARKER_EMPHASIS.quiet)
    expect(markerEmphasis({ breakout: 1 })).toBe(MARKER_EMPHASIS.live)
  })
  it('the GL expression encodes the same four tiers', () => {
    const expr = JSON.stringify(buildMarkerEmphasisExpr())
    for (const v of Object.values(MARKER_EMPHASIS)) expect(expr).toContain(String(v))
    expect(expr).toContain('pin_selected')
    expect(expr).toContain('ring_color')
  })
})

describe('selection camera (G, H)', () => {
  const size = { width: 390, height: 780 }
  it('does not move the map when the selected pin is already visible above the card', () => {
    expect(selectionNeedsNudge({ x: 200, y: 300 }, size)).toBe(false)
  })
  it('nudges only when the pin would sit under the card, the chrome or off-screen', () => {
    expect(selectionNeedsNudge({ x: 200, y: 600 }, size)).toBe(true)
    expect(selectionNeedsNudge({ x: 200, y: 40 }, size)).toBe(true)
    expect(selectionNeedsNudge({ x: 5, y: 300 }, size)).toBe(true)
  })
})

describe('Live Activity (I–P)', () => {
  const events = [
    ev({ id: 'r1', type: 'new_reply', occurredAt: '2026-09-25T15:58:00Z' }),
    ev({ id: 'o1', type: 'offer', occurredAt: '2026-09-25T15:30:00Z', severity: 'attention' }),
    ev({ id: 'f1', type: 'message_failed', occurredAt: '2026-09-25T09:00:00Z', severity: 'blocked' }),
    ev({ id: 'b1', type: 'buyer_activity', occurredAt: '2026-09-20T09:00:00Z', lat: 25.77, lng: -80.19 }),
  ]
  it('J/N: scopes and windows filter the real feed', () => {
    expect(filterActivity(events, { scope: 'all', window: '15m', now: NOW }).map((e) => e.id)).toEqual(['r1'])
    expect(filterActivity(events, { scope: 'all', window: '1h', now: NOW }).map((e) => e.id)).toEqual(['r1', 'o1'])
    expect(filterActivity(events, { scope: 'deals', window: 'all', now: NOW }).map((e) => e.id)).toEqual(['o1'])
    expect(scopeOf(ev({ type: 'message_failed' }))).toBe('outreach')
    const counts = scopeCounts(events, 'all', NOW)
    expect(counts.all).toBe(4)
    expect(ACTIVITY_SCOPES.map((s) => s.key)).toContain('buyers')
  })
  it('L: a duplicate event never renders twice', () => {
    const dup = [events[0], { ...events[0] }, events[1]]
    expect(dedupeEvents(dup).length).toBe(2)
    expect(filterActivity(dup, { scope: 'all', window: 'all', now: NOW }).length).toBe(2)
  })
  it('K: only genuinely new ids pulse', () => {
    const seen = new Set(['r1', 'o1'])
    expect(newEventIds(seen, events)).toEqual(['f1', 'b1'])
    expect(newEventIds(new Set(events.map((e) => e.id)), events)).toEqual([])
  })
  it('severity tiers come from the engine’s own severity, deterministically', () => {
    expect(tierOf(ev({ severity: 'blocked' }))).toBe('critical')
    expect(tierOf(ev({ severity: 'attention' }))).toBe('important')
    expect(tierOf(ev({ severity: 'info', priority: 'muted' }))).toBe('background')
  })
  it('P: dense events at one place collapse into one marker, with the strongest tier', () => {
    const dense = Array.from({ length: 12 }, (_, i) => ev({ id: `m${i}`, lat: 25.7743 + i * 0.0001, lng: -80.1937, severity: i === 3 ? 'urgent' : 'info' }))
    const places = groupByPlace(dense, precisionForZoom(11))
    expect(places.length).toBe(1)
    expect(places[0].events.length).toBe(12)
    expect(places[0].tier).toBe('critical')
  })
  it('M: an event links to the property only when it carries a locatable seller', () => {
    expect(eventAction(ev())?.kind).toBe('select_property')
    expect(eventAction(ev({ lat: undefined, lng: undefined, targetType: 'system', threadKey: undefined }))).toBeNull()
  })
})

describe('render contract (I, Y)', () => {
  const props = {
    map: null, mapEpoch: 0,
    modes: [{ key: 'acquisition', label: 'Acquisition Radar', description: 'Seller leads', swatches: ['#fff'] }],
    mode: 'acquisition', onMode: () => {},
    themes: [{ id: 'dark_ops', label: 'Dark', accentColor: '#38bdf8' }], styleMode: 'dark_ops', onStyle: () => {},
    dimension: '2d' as const, onDimension: () => {},
    filterCount: 3, onOpenFilters: () => {},
    activityEvents: [ev()], onSelectEvent: () => {},
    showMapKey: false, onShowMapKey: () => {}, showCensusDock: false, onShowCensusDock: () => {},
    performance: { performanceMode: 'auto', markerDensity: 'high', animation: 'full', liveActivityMode: 'minimal', showHeatEffects: false, clusterAggressiveness: 'medium' } as any,
    onPerformance: () => {}, cardOpen: false, selectedLngLat: null, reducedMotion: true,
  }
  it('Y: every visible control is a real button with a label', () => {
    const html = renderToStaticMarkup(<MapMobileChrome {...props} />)
    for (const c of ['mode', 'layers', 'filters', 'activity', 'recenter', 'filter-summary']) expect(html).toContain(`data-map-control="${c}"`)
    expect(html).toContain('Filters · 3')
    expect(html).toContain('Acquisition Radar')
  })
  it('I: activity off → no activity peek or event UI', () => {
    const html = renderToStaticMarkup(<MapMobileChrome {...props} />)
    expect(html).not.toContain('data-map-control="activity-feed"')
    expect(html).toContain('aria-pressed="false"')
  })
})

describe('desk render contract (map desktop 2.0)', () => {
  const props = {
    map: null, mapEpoch: 0,
    modes: [{ key: 'acquisition', label: 'Acquisition Radar', description: 'Seller leads', swatches: ['#fff'] }],
    mode: 'acquisition', onMode: () => {},
    themes: [{ id: 'dark_ops', label: 'Dark', accentColor: '#38bdf8' }], styleMode: 'dark_ops', onStyle: () => {},
    dimension: '2d' as const, onDimension: () => {},
    filterCount: 7, filterMatching: 18492, onOpenFilters: () => {},
    activityEvents: [ev()], onSelectEvent: () => {},
    showMapKey: false, onShowMapKey: () => {}, showCensusDock: false, onShowCensusDock: () => {},
    performance: { performanceMode: 'auto', markerDensity: 'high', animation: 'full', liveActivityMode: 'minimal', showHeatEffects: false, clusterAggressiveness: 'medium' } as any,
    onPerformance: () => {}, cardOpen: false, selectedLngLat: null, reducedMotion: true,
  }
  const render = () => { screen.desk = true; try { return renderToStaticMarkup(<MapMobileChrome {...props} />) } finally { screen.desk = false } }
  it('renders the rail, the command stack, the legend and the zoom capsule — not the phone chrome', () => {
    const html = render()
    for (const c of ['layers', 'filters', 'draw', 'activity', 'appearance', 'recenter', 'mode', 'filter-summary', 'color-by', 'zoom-in', 'zoom-out', 'dimension', 'north']) expect(html).toContain(`data-map-control="${c}"`)
    expect(html).toContain('mxd-rail')
    expect(html).not.toContain('mx-searchrow')
    expect(html).not.toContain('class="mx-stack"')
    expect(html).not.toContain('data-map-control="activity-feed"')
  })
  it('never offers a measure tool', () => {
    expect(render()).not.toMatch(/measure|ruler/i)
  })
  it('the applied filter collapses to a capsule with its real count', () => {
    expect(render()).toContain('7 filters · 18,492 properties')
  })
  it('LIVE is not claimed while the stream is not flowing', () => {
    // Server render: the realtime channel never subscribes, so no LIVE badge.
    expect(render()).not.toContain('mxd-livebadge')
  })
  it('LIVE shows on the lens pill only while the stream is flowing', () => {
    stream.live = true
    try {
      const html = render()
      expect(html).toContain('mxd-livebadge')
      expect(html).toMatch(/Acquisition Radar<\/b><em class="mxd-livebadge"/)
    } finally { stream.live = false }
  })
})
