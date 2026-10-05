import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceShare, InferredInvestorSlot } from './ui/evidence'
import { figureRequest, projectOutlines } from './ui/figure-model'
import type { MiValues } from './mi-types'

const ok = (value: number, n: number, extra = {}) => ({ value, n, status: 'ok' as const, ...extra })
// National shape: 665,288 sales, a buyer recorded on 40,213 (6%), 13,183 investor purchases.
const NATION: MiValues = {
  sales_count: ok(665288, 665288),
  investor_purchase_count: ok(13183, 665288),
  investor_purchase_share: ok(13183 / 40213, 40213, { coverage: 40213 / 665288 }),
  buyer_evidence_coverage: ok(40213 / 665288, 665288),
  cash_purchase_count: ok(9428, 665288),
  cash_purchase_share: ok(9428 / 46516, 46516, { coverage: 46516 / 665288 }),
  cash_evidence_coverage: ok(46516 / 665288, 665288),
}
const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('investor clarity: a count is never read against total sales', () => {
  it('leads with the share of sales that record a buyer, names that base, shows coverage', () => {
    const t = text(<EvidenceShare kind="investor" values={NATION} />)
    expect(t).toContain('Investor share')
    expect(t).toContain('33%')
    expect(t).toContain('of 40,213 sales with a recorded buyer')
    expect(t).toContain('6.0% of deeds record the buyer')
    expect(t).not.toContain('665,288')
    expect(t).toContain('13,183 investor purchases on record')
  })
  it('cash uses its own evidence base', () => {
    const t = text(<EvidenceShare kind="cash" values={NATION} />)
    expect(t).toContain('Cash share')
    expect(t).toContain('of 46,516 sales with cash evidence')
    expect(t).toContain('7.0% of deeds record cash or financing')
  })
  it('a thin evidence base withholds the share', () => {
    const t = text(<EvidenceShare kind="investor" values={{ ...NATION, investor_purchase_share: { value: null, n: 4, status: 'insufficient', reason: 'Insufficient sample: 4 of 20 needed' } }} />)
    expect(t).toContain('Thin sample')
    expect(t).not.toMatch(/\d+% of 4 /)
  })
  it('the explainer names the evidence coverage of this geography', () => {
    const html = renderToStaticMarkup(<EvidenceShare kind="investor" values={NATION} />)
    expect(html).toContain('Buyer identity is recorded on 6.0% of deeds in this geography')
  })
})

describe('inferred investor slot (owner-based; data owned by the inference API)', () => {
  it('says unavailable when the API provides nothing', () => {
    expect(text(<InferredInvestorSlot data={undefined} />)).toContain('Unavailable')
    expect(text(<InferredInvestorSlot data={{ status: 'unavailable', reason: 'Not built' }} />)).toContain('Not built')
  })
  it('renders the API tiers and validation note verbatim', () => {
    const t = text(<InferredInvestorSlot data={{ status: 'ok', share: 0.21, base_n: 5411, base_label: 'properties', tiers: [{ id: 'llc', label: 'LLC / company owner', share: 0.12 }, { id: 'absentee', label: 'Absentee mailing', n: 640 }], validation: 'Validated against 1,204 deed-recorded investor purchases.' }} />)
    expect(t).toContain('21%')
    expect(t).toContain('of 5,411 properties')
    expect(t).toContain('LLC / company owner')
    expect(t).toContain('640')
    expect(t).toContain('Validated against 1,204')
    expect(t).toContain('inference, not a deed')
  })
})

describe('map-first figure (geometry we own)', () => {
  it('asks for ZIP outlines around small areas and states for large ones', () => {
    expect(figureRequest({ level: 'market', bbox: [-97.0, 32.6, -96.5, 33.0], centroid: null })?.zoom).toBe(10)
    expect(figureRequest({ level: 'state', bbox: [-106, 26, -93, 36], centroid: null })?.zoom).toBe(4)
    expect(figureRequest({ level: 'county', bbox: [-100, 30, -95, 35], centroid: null })?.zoom).toBe(4)
  })
  it('projects polygons into the viewBox', () => {
    const p = projectOutlines([{ id: 'zip:1', outline: { type: 'Polygon', coordinates: [[[-93.3, 45.0], [-93.2, 45.0], [-93.2, 45.1], [-93.3, 45.0]]] } }], 960, 360)
    expect(p.ok).toBe(true)
    const nums = p.paths[0].d.match(/-?\d+\.?\d*/g)!.map(Number)
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...nums)).toBeLessThanOrEqual(960)
  })
})

describe('scroll contract (owner: "It doesn\'t let me scroll")', () => {
  const css = readFileSync(join(__dirname, 'market-intelligence.css'), 'utf8')
  it('grid surfaces and the wall do not scroll the page; the grid / columns are the root', () => {
    expect(css).toMatch(/\.mi-main\.is-fill, \.mi-main\.is-wall \{ overflow: hidden;/)
    expect(css).toMatch(/\.mi-fill > \.mi-grid-host \{ flex: 1 1 auto;/)
    expect(css).toMatch(/\.mi-wall__col \{[^}]*overflow-y: auto/)
  })
  it('nested grids never trap the wheel', () => {
    expect(css).toMatch(/\.mi \.lc-grid__scroller, \.mi \.lc-scroll \{ overscroll-behavior: auto; \}/)
  })
  it('no fixed-height nested scroller inside a scrolling document surface', () => {
    expect(css).not.toMatch(/max-height:[^;]+;\s*overflow-y: auto/)
    expect(css).not.toMatch(/\b(100vh|100vw|position: fixed)\b/)
  })
})
