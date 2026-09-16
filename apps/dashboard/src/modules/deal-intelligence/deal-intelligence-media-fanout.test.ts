import { describe, expect, it } from 'vitest'
import { buildInteractiveStreetViewUrl } from './DealIntelligenceMedia'

/**
 * STREET-VIEW-CORRECTION §2/§7 — Deal Intelligence is a DETAIL surface, so
 * Street View belongs here; it just may not load for a pane nobody opened.
 *
 * THE CORRECTION. The previous pass removed Street View from this surface. The
 * measured problem was never per-row fan-out — Deal Intelligence shows ONE
 * property — it was AUTO-LOAD: the pane mounts by default in the desktop Inbox
 * workspace and flipped straight to `interactive` on mount, so every Inbox boot
 * pulled the Maps JS API and built a panorama for a pane nobody had looked at
 * (17 maps requests, measured 2026-09-15).
 *
 * So the imagery is restored behind the intent gate rather than restored to
 * auto-load. These cover the URL builder, which is the thing that decides
 * whether a request can be made at all; the rendered gating is covered by
 * scripts/proof/mobile/street-view-fanout-qa.mjs, which measured Inbox 0,
 * Pipeline board 0, and Deal Intelligence exactly 1.
 */

describe('the Street View embed builder is restored', () => {
  it('builds an embed URL for a single selected property', () => {
    const url = buildInteractiveStreetViewUrl({
      address: '1115 Nw 64th St, Miami, Fl 33150',
      lat: 25.845,
      lng: -80.22,
    })
    expect(url).toBeTruthy()
    expect(url).toContain('maps/embed/v1/streetview')
    // Coordinates win over the address when both are usable.
    expect(url).toContain('location=25.845%2C-80.22')
  })

  it('falls back to the address when coordinates are absent or degenerate', () => {
    for (const coords of [{ lat: null, lng: null }, { lat: 0, lng: 0 }, { lat: 0.00001, lng: 0.00001 }]) {
      const url = buildInteractiveStreetViewUrl({ address: '5115 Michigan Ave, Kansas City, Mo', ...coords })
      expect(url).toContain('Michigan')
    }
  })

  /**
   * No location means no request. This is what stops a subject with no address
   * from producing a Street View call for "undefined".
   */
  it('returns null when there is nothing to look at', () => {
    expect(buildInteractiveStreetViewUrl({ address: null, lat: null, lng: null })).toBeNull()
    expect(buildInteractiveStreetViewUrl({ address: '   ', lat: 0, lng: 0 })).toBeNull()
  })

  /**
   * The removal that took Street View out of IntelligencePanel also deleted a
   * hardcoded `AIza...` key literal from source. That is not coming back: with
   * no configured key the builder returns null and the embed is omitted rather
   * than a credential being shipped. `maps-key-hygiene.test.ts` enforces the
   * absence of the literal repo-wide; this states the runtime consequence.
   */
  it('omits the embed entirely when no key is configured', () => {
    const key = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY
    if (key && key.trim()) {
      // A key is configured in this environment, so assert the positive half:
      // the builder never emits a URL without one.
      const url = buildInteractiveStreetViewUrl({ address: 'anywhere', lat: null, lng: null })
      expect(url).toContain('key=')
      return
    }
    expect(buildInteractiveStreetViewUrl({ address: 'anywhere', lat: null, lng: null })).toBeNull()
  })
})
