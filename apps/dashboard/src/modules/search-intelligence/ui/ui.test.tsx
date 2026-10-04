import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
type ReactElement = React.ReactElement

vi.mock('maplibre-gl', () => ({ default: { Map: class {} } }))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))
const width = { value: 0 }
vi.mock('./useContainerWidth', () => ({ useContainerWidth: () => [() => {}, width.value] }))

import prominent from '../data/snapshots/prominent.json'
import reivesti from '../data/snapshots/reivesti.json'
import { assembleDataset, navTargetsOf, type PackedSnapshot } from '../data/snapshot-loader'
import { buildModel } from '../domain/model'
import { allOpportunities } from '../domain/opportunities'
import { propertySummary } from '../domain/brief'
import { buildSearchIndex } from '../domain/search'
import { geoCoverage } from '../domain/geography'
import type { ObjectRef } from '../domain/types'
import { SiContext, type SiCtx } from './si-context'
import { parseState, serializeState, type SiState } from './state'
import { territoryFeatures } from './globe-model'
import { AnalyticsView, ConnectionsView, ConversionsView, HomeView, KeywordsView, LaunchView, OpportunitiesView, PagesView, ArchitectureView } from './views'
import { InspectorHost } from './Inspector'
import { GlobePanel, PortfolioGrid } from './panels'

const snaps = [prominent, reivesti] as unknown as PackedSnapshot[]
const model = buildModel(assembleDataset(snaps), navTargetsOf(snaps))
const opportunities = allOpportunities(model, null)
const data = {
  model, opportunities, summaries: model.dataset.properties.map((p) => propertySummary(model, p, opportunities)),
  index: buildSearchIndex(model, opportunities), snapshots: [],
}
const noop = () => {}
function render(node: ReactElement, state: Partial<SiState> = {}) {
  const ctx: SiCtx = { data, state: { view: 'home', property: null, object: null, pagesView: 'all', ...state }, actions: { setView: noop, setProperty: noop, inspect: noop, setPagesView: noop } }
  return renderToStaticMarkup(<SiContext.Provider value={ctx}>{node}</SiContext.Provider>)
}

describe('URL state', () => {
  const known = new Set(['prominent', 'offerr'])
  it('round-trips view, property, object and pages view', () => {
    const s: SiState = { view: 'architecture', property: 'prominent', object: { kind: 'page', id: 'pco:home' }, pagesView: 'ready' }
    expect(parseState(serializeState('/search-intelligence', s), known)).toEqual(s)
  })
  it('falls back safely on unknown values', () => {
    expect(parseState('/search-intelligence?v=nope&p=ghost&o=bad', known)).toEqual({ view: 'home', property: null, object: null, pagesView: 'all' })
  })
})

describe('globe planning mode', () => {
  it('lights only planned places, with plan counts — no traffic fields', () => {
    const fc = territoryFeatures(geoCoverage(model, 'prominent'), null)
    expect(fc.features.length).toBeGreaterThan(50)
    for (const f of fc.features) {
      expect(f.properties.planned).toBeGreaterThan(0)
      expect(Object.keys(f.properties).sort()).toEqual(['completion', 'id', 'kind', 'name', 'planned', 'ready', 'selected'])
    }
  })
  it('labels the mode PLANNING · SEARCH FOOTPRINT and offers live modes without data', () => {
    const html = render(<GlobePanel hero />)
    expect(html).toContain('PLANNING · SEARCH FOOTPRINT')
    for (const l of ['Impressions', 'Organic clicks', 'Recent sessions', 'Conversions', 'Leads', 'Outcomes']) expect(html).toContain(l)
    expect(html).toContain('Declared place, no page')
  })
})

describe('portfolio + home', () => {
  it('portfolio cards show lifecycle, connections and honest empties — never a fake zero', () => {
    const html = render(<PortfolioGrid />)
    for (const b of ['Prominent Cash Offer', 'Offerr', 'Reivesti', 'LeadCommand']) expect(html).toContain(b)
    expect(html).toContain('Building')
    expect(html).toContain('Not connected')
    expect(html).toContain('No provider data')
    expect(html).not.toMatch(/Impressions[^<]*0\b/)
  })
  it('home at 1440 renders globe, brief, opportunities, launch feed and portfolio — no site graph', () => {
    width.value = 1440
    const html = render(<HomeView />)
    expect(html).toContain('si-home__globe')
    expect(html).toContain('Intelligence brief')
    expect(html).toContain('Launch status')
    expect(html).not.toContain('si-home__graph')
  })
  it('ultrawide (3800px+) becomes the command wall with the site graph', () => {
    width.value = 3840
    const html = render(<HomeView />)
    expect(html).toContain('is-wall')
    expect(html).toContain('si-home__graph')
    width.value = 0
  })
  it('the wall layout is real CSS: four columns at the wall, container queries elsewhere', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'search-intelligence.css'), 'utf8')
    expect(css).toMatch(/\.si-home\.is-wall \{[^}]*grid-template-columns: minmax\(0, 1\.55fr\) minmax\(0, 1\.15fr\)/)
    expect(css).toContain('container: si / inline-size')
    expect(css).not.toMatch(/100vw|100vh|position: fixed/)
  })
})

describe('surfaces stay finished with zero live data', () => {
  it('analytics frames say "not connected" for every provider', () => {
    const html = render(<AnalyticsView />)
    expect(html).toContain('Search Console')
    expect(html).toContain('No data — not connected')
    expect(html).toContain('Awaiting site launch')
  })
  it('conversions show the journey with LeadCommand ownership and the Offerr path', () => {
    const html = render(<ConversionsView />)
    expect(html).toContain('LC conversation')
    expect(html).toContain('Offerr attribution path')
    expect(html).toContain('LeadCommand outcomes not linked')
  })
  it('connections list every provider with read-only scope and server-side credentials', () => {
    const html = render(<ConnectionsView />)
    for (const l of ['Google Search Console', 'Google Analytics 4', 'First-party telemetry', 'Cloudflare Web Analytics', 'External research', 'LeadCommand bridge']) expect(html).toContain(l)
    expect(html).toContain('webmasters.readonly')
  })
  it('LeadCommand public site shows deliberate empties for architecture and keywords', () => {
    expect(render(<ArchitectureView />, { property: 'leadcommand' })).toContain('No architecture registered yet')
    expect(render(<KeywordsView />, { property: 'leadcommand' })).toContain('No keyword plan yet')
  })
  it('pages gaining/declining/indexed views explain why they are empty', () => {
    expect(render(<PagesView />, { pagesView: 'gaining' })).toContain('No ranking history yet')
    expect(render(<PagesView />, { pagesView: 'indexed' })).toContain('Search Console not connected')
  })
  it('opportunities list rules by phase; live rules wait for Search Console', () => {
    const html = render(<OpportunitiesView />)
    expect(html).toContain('Live — waiting for Search Console')
    expect(html).toContain('Striking distance')
  })
  it('launch command shows every lifecycle step and the Reivesti waves', () => {
    const html = render(<LaunchView />)
    expect(html).toContain('Ready for verification')
    expect(html).toContain('Wave 0')
  })
  it('Offerr keyword universe shows the named families as not researched', () => {
    const html = render(<KeywordsView />, { property: 'offerr' })
    expect(html).toContain('AI home offers')
    expect(html).toContain('not researched')
    expect(html).toContain('No destination page')
  })
})

describe('inspectors', () => {
  const insp = (object: ObjectRef) => render(<InspectorHost stack={[object]} onBack={noop} />, { object })
  it('page inspector: registry ladder, COPY NOT APPROVED, and honest search metrics', () => {
    const html = insp({ kind: 'page', id: 'pco:home' })
    expect(html).toContain('Built route')
    expect(html).toContain('COPY NOT APPROVED')
    expect(html).toContain('Awaiting site launch')
    expect(html).not.toMatch(/>0<\/span>/)
  })
  it('legacy evidence is labelled as an import, not a live measure', () => {
    const legacyPage = model.dataset.pages.find((p) => p.legacy)!
    expect(insp({ kind: 'page', id: legacyPage.id })).toContain('Legacy authority (imported, not live)')
  })
  it('cluster, keyword, geography, wave, opportunity and property inspectors render', () => {
    const unowned = model.dataset.clusters.find((c) => c.propertyId === 'reivesti' && c.ownerRef === 'academy-hub')!
    expect(insp({ kind: 'cluster', id: unowned.id })).toContain('No destination page')
    expect(insp({ kind: 'keyword', id: model.dataset.keywords[0].id })).toContain('No research provider connected')
    expect(insp({ kind: 'geography', id: 'us-fl' })).toContain('Pages targeting this place')
    expect(insp({ kind: 'wave', id: 'rv:w:0' })).toContain('Blockers')
    expect(insp({ kind: 'opportunity', id: opportunities[0].id })).toContain('Deterministic rule')
    expect(insp({ kind: 'property', id: 'reivesti' })).toContain('carrot.com')
  })
  it('an unknown object renders a not-found inspector instead of crashing', () => {
    expect(insp({ kind: 'page', id: 'nope' })).toContain('Not found')
  })
})
