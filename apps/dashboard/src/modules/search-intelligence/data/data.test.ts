import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import prominent from './snapshots/prominent.json'
import reivesti from './snapshots/reivesti.json'
import { assembleDataset, navTargetsOf, type PackedSnapshot } from './snapshot-loader'
import { CONNECTIONS, PROPERTY_META } from './properties'
import { buildModel, geoPath } from '../domain/model'
import { allOpportunities } from '../domain/opportunities'
import { coverageGaps, drillChildren, geoCoverage } from '../domain/geography'
import { validateRegistry } from '../domain/registry'
import { intelligenceMode } from '../domain/lifecycle'

const snaps = [prominent, reivesti] as unknown as PackedSnapshot[]
const ds = assembleDataset(snaps)
const m = buildModel(ds, navTargetsOf(snaps))

describe('portfolio — multiple properties, pre-launch, no connections', () => {
  it('is data-driven: the four initial properties come from rows, in their own order', () => {
    expect(ds.properties.map((p) => p.id)).toEqual(['prominent', 'offerr', 'reivesti', 'leadcommand'])
    expect(ds.properties.map((p) => p.domain)).toEqual(['prominentcashoffer.com', 'offerr.ai', 'reivesti.com', 'leadcommand.ai'])
  })
  it('adding a brand is a row, not a schema change', () => {
    const extra = assembleDataset(snaps, [...PROPERTY_META, { ...PROPERTY_META[3], id: 'signpro', brand: 'SignPro', domain: 'signpro.example', order: 5 }])
    expect(extra.properties.map((p) => p.id)).toContain('signpro')
    expect(buildModel(extra).pagesOf.get('signpro')).toBeUndefined()
  })
  it('every property is pre-launch and in PLANNING mode; no connector is connected', () => {
    for (const p of ds.properties) {
      expect(['PLANNED', 'BUILDING']).toContain(p.lifecycle)
      expect(intelligenceMode(p)).toBe('PLANNING')
    }
    expect(CONNECTIONS.every((c) => c.state === 'NOT_CONFIGURED' || c.state === 'NOT_APPLICABLE')).toBe(true)
    expect(CONNECTIONS.every((c) => c.lastSyncAt === null && c.dataThrough === null)).toBe(true)
  })
  it('ops.leadcommand.ai is not an SEO property', () => {
    expect(ds.properties.some((p) => p.domain.startsWith('ops.'))).toBe(false)
    expect(ds.properties.find((p) => p.id === 'leadcommand')?.excludedHosts).toContain('ops.leadcommand.ai')
    expect(m.pagesOf.get('leadcommand')).toBeUndefined()
  })
  it('Offerr spelling and intent families: named, not researched, no invented keywords', () => {
    expect(ds.properties.find((p) => p.id === 'offerr')?.brand).toBe('Offerr')
    const fam = ds.clusters.filter((c) => c.propertyId === 'offerr')
    expect(fam).toHaveLength(9)
    expect(fam.every((c) => c.primaryKeyword === null && c.ownerPageId === null && c.source === 'OPERATOR')).toBe(true)
    expect(ds.keywords.filter((k) => k.propertyId === 'offerr')).toHaveLength(0)
  })
})

describe('imported plans represent the existing SEO work', () => {
  it('Prominent: all 217 governed routes, gate statuses mapped, provenance on every page', () => {
    const pages = m.pagesOf.get('prominent')!
    expect(pages).toHaveLength(217)
    expect(pages.filter((p) => p.status === 'READY')).toHaveLength(26)
    expect(pages.every((p) => p.source.commit && p.source.path)).toBe(true)
    expect(pages.every((p) => p.stage.published === false && p.stage.indexed === null)).toBe(true)
  })
  it('Reivesti: the governed registry plus pilot, queue and legacy wave-0 destinations', () => {
    const pages = m.pagesOf.get('reivesti')!
    expect(pages.find((p) => p.path === '/markets/texas/austin')?.status).toBe('READY')
    expect(pages.find((p) => p.path === '/markets/florida/miami')?.status).toBe('PLANNED')
    expect(pages.filter((p) => p.family === 'wholesale-metro').length).toBeGreaterThanOrEqual(30)
    expect(ds.waves.filter((w) => w.propertyId === 'reivesti')).toHaveLength(6)
    expect(ds.clusters.filter((c) => c.propertyId === 'reivesti')).toHaveLength(28)
  })
  it('no copy is marked approved — nothing records an owner sign-off', () => {
    expect(ds.pages.some((p) => p.copy.state === 'APPROVED')).toBe(false)
  })
  it('legacy figures are labelled, windowed imports — never live measures', () => {
    const legacy = ds.pages.filter((p) => p.legacy)
    expect(legacy.length).toBeGreaterThan(0)
    for (const p of legacy) {
      expect(p.legacy!.source.kind).toBe('import')
      expect(p.legacy!.window.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(ds.measures.page.size).toBe(0)
    expect(ds.measures.keyword.size).toBe(0)
  })
  it('the registry has no duplicate routes, accidental aliases or cycles', () => {
    const bad = validateRegistry(m, ds.pages).filter((i) => i.kind === 'DUPLICATE_ROUTE' || i.kind === 'ACCIDENTAL_ALIAS' || i.kind === 'PARENT_CYCLE')
    expect(bad).toEqual([])
  })
})

describe('geography relationships on the real plan', () => {
  it('drills Florida → Miami-Dade → Miami for Prominent', () => {
    const cov = geoCoverage(m, 'prominent')
    const fl = drillChildren(m, cov, 'us-fl').map((c) => c.geo.name)
    expect(fl).toContain('Miami Dade County')
    const md = drillChildren(m, cov, 'us-fl-miami-dade-county').map((c) => c.geo.name)
    expect(md).toEqual(expect.arrayContaining(['Miami', 'Miami Beach']))
    expect(geoPath(m, 'us-fl-miami').map((g) => g.name)).toEqual(['United States', 'Florida', 'Miami Dade County', 'Miami'])
  })
  it('places carry reference coordinates; states use Census-outline label points', () => {
    const placed = ds.geographies.filter((g) => g.kind !== 'COUNTRY')
    expect(placed.filter((g) => g.lat == null)).toEqual([])
    const fl = ds.geographies.find((g) => g.id === 'us-fl')!
    expect(fl.lat!).toBeGreaterThan(26)
    expect(fl.lng!).toBeLessThan(-80)
  })
  it('declared operating states without a state market page are coverage gaps', () => {
    const gaps = coverageGaps(m, 'prominent').filter((g) => g.kind === 'GEO_WITHOUT_PAGE')
    expect(gaps.length).toBe(33)
    expect(gaps.some((g) => g.kind === 'GEO_WITHOUT_PAGE' && g.geographyId === 'us-ga')).toBe(false)
  })
})

describe('opportunities on the real plan', () => {
  const ops = allOpportunities(m, null)
  it('every opportunity says why and carries evidence', () => {
    for (const o of ops) { expect(o.why.length).toBeGreaterThan(20); expect(o.evidence.length).toBeGreaterThan(0) }
  })
  it('finds the duplicate Miami identity and the unregistered Reivesti owners', () => {
    expect(ops.some((o) => o.ruleId === 'duplicate-identity' && /miami/i.test(o.title))).toBe(true)
    expect(ops.filter((o) => o.ruleId === 'cluster-without-page' && o.propertyId === 'reivesti').length).toBeGreaterThan(0)
  })
  it('emits no LIVE opportunity without provider facts', () => {
    expect(ops.filter((o) => o.phase === 'LIVE')).toEqual([])
  })
})

describe('boundaries', () => {
  const root = path.resolve(__dirname, '..')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  const runtime = files(root).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__fixtures__'))
  it('no runtime module imports the synthetic test fixtures', () => {
    for (const f of runtime) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/__fixtures__/)
  })
  it('no runtime module reads a LeadCommand table, a credential or a secret', () => {
    for (const f of runtime) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src).not.toMatch(/supabase\.from\(|\.from\(['"](send_queue|master_owners|properties|prospects|seller_)/)
      expect(src).not.toMatch(/-----BEGIN|private_key|client_secret|AIza[0-9A-Za-z_-]{20,}/)
    }
  })
})
