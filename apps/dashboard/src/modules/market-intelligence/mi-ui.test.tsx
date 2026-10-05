import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceShare, InferredInvestorSlot, InferredInvestorsPanel } from './ui/evidence'
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

describe('inferred investor (owner-based), rendered only from the API', () => {
  it('unavailable: the API message verbatim, no number', () => {
    const t = text(<InferredInvestorSlot data={{ available: false, reason: 'not_built', message: 'Owner-based inference is not built yet (the summary extension is not applied).' }} />)
    expect(t).toContain('Unavailable')
    expect(t).toContain('Owner-based inference is not built yet')
    expect(t).not.toMatch(/\d+%/)
  })
  const DATA = {
    available: true, label: 'Inferred investor (owner-based) · 41% of 210K linked sales · validated 87% precision vs recorded buyers',
    recorded_label: 'Recorded investor (deed buyer) · 33% of 40,213 sales with a recorded buyer', sales: 665288, linked: 210000, coverage: 210000 / 665288,
    tiers: [{ id: 'strong', label: 'Strong inferred investor', n: 30000, counted: true }, { id: 'likely', label: 'Likely inferred investor', n: 56000, counted: true }, { id: 'no_signal', label: 'Individual owner, no investor signal', n: 124000, counted: false }],
    validation: { national: { precision: 0.87, recall: 0.62, n: 31000, matrix: { strong: { recorded_investor: 900, recorded_other: 100 } }, truth: 'Truth = recorded investor buyers.' }, local: null, local_n: 40 },
    top_stacks: [{ stack: 's1', label: 'Unnamed owner portfolio', named: false, linked_purchases: 12, properties_at_mailing_address: 31, entity_share: 0.9 }],
    caveats: ['Inferred from the current owner of record, not the deed; never added to recorded investor purchases.'],
  }
  it('compact plate: label line verbatim, owner-link coverage, confidence', () => {
    const t = text(<InferredInvestorSlot data={DATA} compact />)
    expect(t).toContain(DATA.label)
    expect(t).toContain('Owner-linked on 32% of sales')
    expect(t).toContain('87% precision vs recorded buyers nationally')
  })
  it('panel: recorded and inferred side by side, tiers, evidence, stacks, caveats, exact copy', () => {
    const html = renderToStaticMarkup(<InferredInvestorsPanel data={DATA} values={NATION} />)
    const t = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
    expect(t).toContain('Recorded investor (deed buyer) · 33% of 40,213 sales with a recorded buyer')
    expect(t).toContain(DATA.label)
    expect(t).toContain('Strong inferred investor')
    expect(t).toContain('Too few recorded buyers here to validate locally (40)')
    expect(t).toContain('Unnamed owner portfolio')
    expect(t).toContain('Stack = properties whose tax bill goes to the same mailing address. Not proof of one legal owner.')
    expect(t).toContain("Inferred from each property's current owner of record, only for a property's most recent sale with no later transfer.")
    expect(t).toContain('Inferred from the current owner of record, not the deed')
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
