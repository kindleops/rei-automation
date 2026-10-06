/**
 * RC 8.4.3 — Queue Desk scroll contract (stylesheet).
 *
 * Owner (RC 8.4.2): "the tables can't be scrolled at all, vertically or
 * horizontally." Root cause, measured at 1440x900 on prod 8f4bf32b:
 *  - .qdk was overflow: hidden at exactly the pane height, so the rows table
 *    got whatever the flow + tabs + time-zone lanes left over: a 212 px
 *    window (4 rows), and nothing else could scroll;
 *  - .qdk-gridwrap had an auto column track, so the table's own min-width
 *    widened it past the pane (876 px in an 828 px box) and overflow: hidden
 *    clipped the right-hand columns and the pager instead of the table
 *    scrolling sideways.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'queue-desk.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Declarations of every top-level rule whose selector list is exactly `selector`. */
const rule = (selector: string, source = css): Record<string, string> => {
  const out: Record<string, string> = {}
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '))
    if (!selectors.includes(selector)) continue
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
  }
  return out
}
const containerBlock = (query: string): string => {
  const start = css.indexOf(`@container qdk (${query})`)
  if (start < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i) }
  }
  return ''
}

describe('Queue Desk: one scroll root, tables that scroll', () => {
  it('the desk is the scroll root (vertical), never a clipping box', () => {
    const qdk = rule('.qdk')
    expect(qdk['overflow-y']).toBe('auto')
    expect(qdk['overflow-x']).toBe('hidden')
    expect(qdk.overflow).toBeUndefined()
    expect(qdk['min-height']).toBe('0')
  })

  it('dispatch keeps a usable floor so the rows table is never squeezed to a sliver', () => {
    const body = rule(".qdk[data-section='queue'] .qdk-body")
    expect(body['min-height']).toMatch(/800px/)
  })

  it('the rows table host gives the table the pane width, so wide columns scroll sideways inside it', () => {
    const wrap = rule('.qdk-gridwrap')
    expect(wrap['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(wrap['min-width']).toBe('0')
    expect(wrap['grid-template-rows']).toBe('auto minmax(0, 1fr) auto')
    expect(rule('.qdk-grid')['min-width']).toBe('0')
    expect(rule('.qdk-grid')['min-height']).toBe('0')
  })

  it('nested scrollers hand the wheel back to the desk at their ends', () => {
    for (const sel of ['.qdk .lc-scroll', '.qdk .lc-grid__scroller', '.qdk .qdk-lanes__grid', '.qdk .qdk-cap__list', '.qdk .qdk-reasons']) {
      expect(rule(sel)['overscroll-behavior'], sel).toBe('auto')
    }
  })

  it('stacked (narrow pane): the body grows with its content — no second scroll root inside the desk', () => {
    const narrow = containerBlock('max-width: 1039px')
    expect(narrow).not.toBe('')
    expect(rule('.qdk-body', narrow).overflow).toBe('visible')
    expect(rule('.qdk-main--section', narrow).overflow).toBe('visible')
    expect(rule('.qdk-main', narrow)['grid-template-rows']).toBe('auto minmax(420px, 1fr)')
  })

  it('no rule in the desk traps the wheel with overscroll containment except the root', () => {
    const contained = [...css.matchAll(/([^{}]+)\{[^{}]*overscroll-behavior:\s*contain[^{}]*\}/g)].map((m) => m[1].trim())
    expect(contained).toEqual(['.qdk'])
  })
})
