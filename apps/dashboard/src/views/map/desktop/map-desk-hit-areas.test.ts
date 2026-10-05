/**
 * Hit-area contract for the desktop Map's floating chrome: a transparent
 * wrapper never takes the pointer, only the visible glass does. jsdom has no
 * layout, so the geometry is proven by the real-stylesheet Chromium probe
 * (scripts/proof/desktop/map-bottom-hit-probe.mjs: elementFromPoint just
 * outside the legend glass resolves to the map canvas). This test pins the
 * rules that make it true, so a later edit cannot quietly drop them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./map-desk.css', import.meta.url)), 'utf8').replace(/\s+/g, ' ')
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return null
  return css.slice(at + selector.length + 2, css.indexOf('}', at)).trim()
}
const P = 'html.is-desktop-modern .mx.is-desk'

describe('desktop Map chrome hit areas', () => {
  it('the instrument columns are pass-through wrappers', () => {
    expect(rule(`${P} .mxd-cards`)).toMatch(/pointer-events: none/)
    expect(rule(`${P} .mxd-stack`)).toMatch(/pointer-events: none/)
    expect(rule(`${P} .mxd-toasts`)).toMatch(/pointer-events: none/)
  })

  it('the legend section passes the pointer through; its panel and chip take it', () => {
    // the section is sized by the column's max-content (1312px at 1440 around a 768px panel)
    expect(rule(`${P} .mxd-cards > .mxd-legend`)).toBe('pointer-events: none;')
    expect(rule(`${P} .mxd-legend > :is(.mxd-legend__panel, .mxd-legend__chip)`)).toBe('pointer-events: auto;')
  })

  it('a wrapped command row passes the pointer through; its pills take it', () => {
    expect(rule(`${P} .mxd-stack > .mxd-stack__row`)).toBe('pointer-events: none;')
    expect(rule(`${P} .mxd-stack__row > *`)).toBe('pointer-events: auto;')
  })
})
