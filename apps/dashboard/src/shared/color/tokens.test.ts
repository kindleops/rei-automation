import { describe, expect, it } from 'vitest'
import { computeAppearance, appearanceAttributes } from './tokens'
import { defaultAppearance, normalizeMaterial } from './appearance'
import { contrast, parseColor } from './oklch'

const ap = defaultAppearance()

describe('the generated Experience Token sheet', () => {
  it('scopes the derived system to the desktop and leaves the phone on its own stylesheet', () => {
    const c = computeAppearance({ nexusTheme: 'dark', accentPalette: 'cyan', appearance: ap })
    expect(c.css).toContain(':root.is-desktop-modern[data-nexus-theme] {')
    expect(c.css).not.toContain('[data-nexus-accent="custom"]')
    // the legacy chain must beat Red Ops' forced red on the desktop
    expect(c.css).toMatch(/--nexus-accent-rgb: 6, 182, 212 !important;/)
    expect(c.css).toMatch(/--lg-alpha: [\d.]+ !important;/)
  })

  it('publishes a custom accent everywhere (no stylesheet knows its colour)', () => {
    const c = computeAppearance({ nexusTheme: 'light', accentPalette: 'custom', appearance: { ...ap, accent: { custom: '#FEF9C3', intensity: 50 } } })
    expect(c.css).toContain(':root[data-nexus-theme][data-nexus-accent="custom"] {')
    // the pale yellow is the inspiration, not the token
    expect(c.css).not.toMatch(/--nx-accent: #FEF9C3/)
  })

  it('every accent, chart, environment and glass family is present', () => {
    const c = computeAppearance({ nexusTheme: 'true_black', accentPalette: 'violet', appearance: ap })
    for (const name of ['--lc-accent-base', '--lc-accent-hover', '--lc-accent-pressed', '--lc-accent-soft', '--lc-accent-muted', '--lc-accent-border', '--lc-accent-focus', '--lc-accent-underlight', '--lc-accent-glow-low', '--lc-accent-text', '--lc-accent-on', '--lc-select-rgb', '--lc-focus-rgb', '--lc-chart-primary', '--lc-chart-secondary', '--lc-chart-1', '--lc-chart-8', '--lc-env-a', '--lc-env-d', '--lc-env-o', '--lc-glass-edge', '--dsk-primary-ink']) {
      expect(c.css).toContain(`${name}:`)
    }
  })

  it('writes edge overrides only when the operator moved Edge', () => {
    const balanced = computeAppearance({ nexusTheme: 'dark', accentPalette: 'cyan', appearance: ap, liquidGlass: normalizeMaterial({ preset: 'smoke', blur: 30, transparency: 16, sheen: 28, edge: 'balanced' }) })
    expect(balanced.css).not.toContain('--dsk-edge:')
    const crisp = computeAppearance({ nexusTheme: 'dark', accentPalette: 'cyan', appearance: ap, liquidGlass: normalizeMaterial({ preset: 'smoke', blur: 30, transparency: 16, sheen: 28, edge: 'crisp' }) })
    expect(crisp.css).toContain('--dsk-edge: rgba(255, 255, 255, 0.116)')
  })

  it('is memoised per appearance (no recalculation on unrelated settings changes)', () => {
    const a = computeAppearance({ nexusTheme: 'dark', accentPalette: 'teal', appearance: ap })
    const b = computeAppearance({ nexusTheme: 'dark', accentPalette: 'teal', appearance: JSON.parse(JSON.stringify(ap)) })
    expect(b).toBe(a)
  })

  it('exposes the attributes CSS keys on', () => {
    const c = computeAppearance({ nexusTheme: 'red_ops', accentPalette: 'custom', appearance: { ...ap, accent: { custom: '#FF1212', intensity: 50 } } })
    expect(appearanceAttributes(c, ap, undefined)).toEqual({ 'data-lc-env': 'liquid', 'data-lc-env-motion': 'calm', 'data-lc-accent-reserved': 'crit', 'data-lc-material': 'crystal' })
  })

  it('publishes accent surfaces whose ink reads on every fill stop, in every foundation', () => {
    for (const theme of ['dark', 'light', 'true_black', 'red_ops']) {
      for (const accent of ['cyan', 'violet', 'gold', 'blue', 'lime', 'pink'] as const) {
        const c = computeAppearance({ nexusTheme: theme, accentPalette: accent, appearance: ap })
        for (const name of ['--lc-primary-rgb', '--lc-primary-on', '--lc-primary-fill', '--lc-bubble-out-fill', '--lc-bubble-out-ink', '--lc-accent-glow']) expect(c.css).toContain(`${name}:`)
        const ink = parseColor(/--lc-primary-on: (#[0-9a-f]{6})/i.exec(c.css)![1])!
        const stops = /--lc-primary-fill: linear-gradient\(180deg, (#[0-9a-f]{6}) 0%, (#[0-9a-f]{6}) 100%\)/i.exec(c.css)!
        for (const hex of [stops[1], stops[2]]) expect(contrast(ink, parseColor(hex)!)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('never fills a primary action or an outbound bubble with a failure-red accent', () => {
    const c = computeAppearance({ nexusTheme: 'red_ops', accentPalette: 'custom', appearance: { ...ap, accent: { custom: '#FF1212', intensity: 50 } } })
    expect(c.css).toContain('--lc-primary-rgb: 226, 232, 240;')
    expect(c.css).toContain('--lc-bubble-out-rgb: 226, 232, 240;')
  })
})
