/**
 * TEST-ONLY synthetic plans for behaviour and scale tests.
 *
 * Never imported by a runtime module (a test asserts this). Synthetic pages
 * are plans with obviously artificial paths (/zz-synthetic/...) and carry no
 * measures — scale tests measure the engine, not invented traffic.
 */
import type {
  InternalLink, KeywordCluster, LaunchWave, PropertyConnection, SearchDataset, SearchGeography, SearchKeyword, SearchPage, SearchProperty,
} from '../types'

const SRC = { kind: 'operator' as const, label: 'synthetic test fixture' }

export function property(id: string, over: Partial<SearchProperty> = {}): SearchProperty {
  return {
    id, brand: id.toUpperCase(), domain: `${id}.test`, origin: `https://${id}.test`, strategy: 'test', thesis: 'test', lifecycle: 'BUILDING',
    lifecycleNote: 'test', launchedAt: null, accent: 'exec', hierarchy: [], excludedHosts: [], sources: [SRC], order: 1,
    expectations: [], facts: [], reservedFamilies: [], ...over,
  }
}

export function page(id: string, propertyId: string, path: string, over: Partial<SearchPage> = {}): SearchPage {
  return {
    id, propertyId, path, family: 'page', parentId: null, geographyIds: [], intent: null, primaryClusterId: null, secondaryClusterIds: [],
    secondaryKeywords: [], primaryKeyword: null, copy: { title: null, h1: null, meta: null, state: 'NOT_WRITTEN' }, canonical: null, schemaTypes: [],
    indexability: 'UNDECIDED', robots: null, inSitemap: null, launchWaveId: null, status: 'PLANNED',
    stage: { planned: true, builtRoute: false, published: false, indexed: null }, thesis: null, notes: null, aliases: [], source: SRC, ...over,
  }
}

export function cluster(id: string, propertyId: string, over: Partial<KeywordCluster> = {}): KeywordCluster {
  return {
    id, propertyId, label: id, primaryKeyword: `kw ${id}`, parentTopic: null, intent: 'transactional', geoLevel: null, ownerPageId: null, ownerRef: null,
    priority: null, wave: null, source: 'PLANNED', provenance: SRC, notes: null, ...over,
  }
}

export function keyword(id: string, propertyId: string, query: string, over: Partial<SearchKeyword> = {}): SearchKeyword {
  return { id, propertyId, query, clusterId: null, intent: null, geographyId: null, assignedPageId: null, status: 'PLANNED', priority: null, source: 'PLANNED', provenance: SRC, ...over }
}

export function wave(id: string, propertyId: string, order: number, over: Partial<LaunchWave> = {}): LaunchWave {
  return { id, propertyId, label: id, order, status: 'PLANNED', targetDate: null, dependsOn: [], blockers: [], notes: null, source: SRC, ...over }
}

export const GEO: SearchGeography[] = [
  { id: 'us', kind: 'COUNTRY', name: 'United States', code: 'US', parentId: null, stateCode: null, lat: 39.5, lng: -98.35 },
  { id: 'us-fl', kind: 'STATE', name: 'Florida', code: 'FL', parentId: 'us', stateCode: 'FL', lat: 28.66, lng: -82.5 },
  { id: 'us-fl-miami-dade-county', kind: 'COUNTY', name: 'Miami-Dade County', code: null, parentId: 'us-fl', stateCode: 'FL', lat: 25.61, lng: -80.5 },
  { id: 'us-fl-miami', kind: 'CITY', name: 'Miami', code: null, parentId: 'us-fl-miami-dade-county', stateCode: 'FL', lat: 25.76, lng: -80.19 },
  { id: 'us-ga', kind: 'STATE', name: 'Georgia', code: 'GA', parentId: 'us', stateCode: 'GA', lat: 32.65, lng: -83.45 },
  { id: 'us-tx', kind: 'STATE', name: 'Texas', code: 'TX', parentId: 'us', stateCode: 'TX', lat: 31.5, lng: -99.3 },
]

export function dataset(parts: Partial<SearchDataset>): SearchDataset {
  return {
    properties: [], pages: [], links: [], clusters: [], keywords: [], geographies: GEO, waves: [], connections: [],
    measures: { page: new Map(), keyword: new Map() }, ...parts,
  }
}

export function none(propertyId: string): PropertyConnection[] {
  return (['SEARCH_CONSOLE', 'GA4', 'FIRST_PARTY', 'CLOUDFLARE', 'EXTERNAL_RESEARCH', 'LEADCOMMAND'] as const).map((provider) => ({
    propertyId, provider, state: 'NOT_CONFIGURED', vendor: null, lastSyncAt: null, dataThrough: null, note: null,
  }))
}

/**
 * A programmatic architecture of `n` planned pages: national → 50 states →
 * counties → cities → situations, with one cluster per 5 pages and 3 keywords
 * per cluster, plus content links between siblings. Deterministic.
 */
export function syntheticScale(n: number): SearchDataset {
  const pid = 'zz'
  const pages: SearchPage[] = [page('zz:root', pid, '/zz-synthetic', { family: 'national', stage: { planned: true, builtRoute: true, published: false, indexed: null }, status: 'READY' })]
  const links: InternalLink[] = []
  const clusters: KeywordCluster[] = []
  const keywords: SearchKeyword[] = []
  const statuses = ['PLANNED', 'RESEARCHED', 'BUILDING', 'QA', 'READY', 'NEEDS_WORK'] as const
  let i = 0
  const parents: string[] = ['zz:root']
  while (pages.length < n) {
    const parent = parents[Math.floor(i / 8) % parents.length]
    const id = `zz:p${i}`
    const fam = pages.length < 51 ? 'state' : pages.length < 600 ? 'county' : pages.length < 3000 ? 'city' : 'situation'
    pages.push(page(id, pid, `/zz-synthetic/${fam}/${i}`, {
      family: fam, parentId: parent, status: statuses[i % statuses.length], launchWaveId: `zz:w${i % 4}`,
      stage: { planned: true, builtRoute: i % 3 === 0, published: false, indexed: null },
      primaryClusterId: i % 5 === 0 ? `zz:c${i / 5}` : null,
    }))
    if (i % 5 === 0) {
      clusters.push(cluster(`zz:c${i / 5}`, pid, { ownerPageId: i % 10 === 0 ? id : null }))
      for (let k = 0; k < 3; k += 1) keywords.push(keyword(`zz:k${i}-${k}`, pid, `synthetic query ${i} ${k}`, { clusterId: `zz:c${i / 5}`, assignedPageId: k === 0 ? id : null }))
    }
    links.push({ fromPageId: parent, toPageId: id, kind: 'parent' })
    if (i > 0 && i % 2 === 0) links.push({ fromPageId: `zz:p${i - 1}`, toPageId: id, kind: 'content' })
    parents.push(id)
    i += 1
  }
  return dataset({
    properties: [property(pid)], pages, links, clusters, keywords,
    waves: [0, 1, 2, 3].map((w) => wave(`zz:w${w}`, pid, w)), connections: none(pid),
  })
}
