import { describe, expect, it } from 'vitest'
import { buildModel } from './model'
import { ctrOf, formatMetric, pageSearchMetric, searchMeasureGate, analyticsMeasureGate, UNAVAILABLE_COPY, unavailable } from './metrics'
import { intelligenceMode, surfaceAwake } from './lifecycle'
import { aliasKey, isOrphan, normalizePath, registryStage, validateRegistry } from './registry'
import { ownershipConflicts, ownershipTable } from './ownership'
import { completion, coverageGaps, drillChildren, geoCoverage } from './geography'
import { allOpportunities, EMPTY_LIVE, liveOpportunities, preLaunchOpportunities, RULES } from './opportunities'
import { nextWave, postLaunchState, preLaunchBrief, propertySummary, waveReadiness } from './brief'
import { buildTree, defaultExpanded, layoutTree, pathTo, findPageNode, buildHitGrid, VISIBLE_BUDGET } from './graph'
import { validateEvent, TELEMETRY_EVENTS, EVENT_SPEC } from './telemetry'
import { buildSearchIndex, searchObjects } from './search'
import { JOURNEY, LEADCOMMAND_BRIDGE } from './bridge'
import { cluster, dataset, keyword, none, page, property, wave, syntheticScale } from './__fixtures__/synthetic'
import type { PropertyConnection } from './types'

const built = { planned: true, builtRoute: true, published: false, indexed: null }

describe('metrics — no fake-metric fallback', () => {
  const pre = property('a', { lifecycle: 'BUILDING' })
  it('a pre-launch property gates every search measure on launch, not on a zero', () => {
    expect(searchMeasureGate(pre, none('a'))).toBe('AWAITING_LAUNCH')
    expect(analyticsMeasureGate(pre, none('a'))).toBe('AWAITING_LAUNCH')
    const m = pageSearchMetric('impressions', undefined, searchMeasureGate(pre, none('a')))
    expect(m).toEqual({ state: 'UNAVAILABLE', reason: 'AWAITING_LAUNCH', provider: 'SEARCH_CONSOLE' })
  })
  it('a live property without a connector says “Search Console not connected”', () => {
    const live = property('a', { lifecycle: 'LIVE' })
    expect(searchMeasureGate(live, none('a'))).toBe('SEARCH_CONSOLE_NOT_CONNECTED')
    expect(formatMetric(pageSearchMetric('clicks', undefined, 'SEARCH_CONSOLE_NOT_CONNECTED'))).toBe('Search Console not connected')
  })
  it('formatMetric never prints a digit for an unavailable metric', () => {
    for (const reason of Object.keys(UNAVAILABLE_COPY) as Array<keyof typeof UNAVAILABLE_COPY>) {
      expect(formatMetric(unavailable(reason))).not.toMatch(/\d/)
    }
  })
  it('only reported provider facts become values; CTR needs both over one window', () => {
    const facts = { provider: 'SEARCH_CONSOLE' as const, through: '2026-10-01', impressions: 200, clicks: 10, position: 7.2 }
    const imp = pageSearchMetric('impressions', facts, null)
    const clk = pageSearchMetric('clicks', facts, null)
    expect(imp).toMatchObject({ state: 'VALUE', value: 200 })
    expect(ctrOf(clk, imp)).toMatchObject({ state: 'VALUE', value: 0.05 })
    expect(ctrOf(unavailable('NOT_REPORTED', 'SEARCH_CONSOLE'), imp).state).toBe('UNAVAILABLE')
    // a GA4 fact can never pose as a Search Console impression
    expect(pageSearchMetric('impressions', { ...facts, provider: 'GA4' }, null).state).toBe('UNAVAILABLE')
  })
})

describe('lifecycle — planning vs live intelligence, wake without redesign', () => {
  it('BUILDING properties render in PLANNING mode with every live surface asleep', () => {
    const p = property('a')
    expect(intelligenceMode(p)).toBe('PLANNING')
    for (const s of ['impressions', 'clicks', 'sessions', 'conversions', 'leads', 'outcomes'] as const) expect(surfaceAwake(p, s, none('a'))).toBe(false)
  })
  it('a connected live property wakes exactly the surfaces its providers serve', () => {
    const p = property('a', { lifecycle: 'CONNECTED' })
    const conns: PropertyConnection[] = none('a').map((c) => (c.provider === 'SEARCH_CONSOLE' ? { ...c, state: 'CONNECTED' } : c))
    expect(intelligenceMode(p)).toBe('LIVE_INTELLIGENCE')
    expect(surfaceAwake(p, 'impressions', conns)).toBe(true)
    expect(surfaceAwake(p, 'sessions', conns)).toBe(false)
    // connected but not launched stays asleep: a connector does not make a site live
    expect(surfaceAwake(property('a', { lifecycle: 'BUILDING' }), 'impressions', conns)).toBe(false)
  })
})

describe('URL registry', () => {
  it('records the four stages separately', () => {
    expect(registryStage(page('x', 'a', '/x'))).toBe('PLANNED_URL')
    expect(registryStage(page('x', 'a', '/x', { stage: built }))).toBe('BUILT_ROUTE')
    expect(registryStage(page('x', 'a', '/x', { stage: { ...built, published: true } }))).toBe('PUBLISHED_URL')
    expect(registryStage(page('x', 'a', '/x', { stage: { ...built, published: true, indexed: true } }))).toBe('INDEXED_URL')
  })
  it('normalises paths and exposes accidental aliases', () => {
    expect(normalizePath('https://x.test/a/b/?q=1#h')).toBe('/a/b')
    expect(aliasKey('/Miami/index.html')).toBe(aliasKey('/miami'))
  })
  it('flags duplicates, aliases, alias collisions, conflicting canonicals, missing parents, cycles and orphans', () => {
    const pages = [
      page('root', 'a', '/', { stage: built }),
      page('p1', 'a', '/sell', { parentId: 'root', stage: built, aliases: ['/old-sell'] }),
      page('p2', 'a', '/sell', { parentId: 'root' }),
      page('p3', 'a', '/Sell-Now', { parentId: 'root' }),
      page('p4', 'a', '/sell-now', { parentId: 'root' }),
      page('p5', 'a', '/old-sell', { parentId: 'root' }),
      page('p6', 'a', '/dup', { canonical: '/nowhere', parentId: 'root' }),
      page('p7', 'a', '/orphan', { stage: built, parentId: 'root' }),
      page('p8', 'a', '/lost', { parentId: 'ghost' }),
      page('c1', 'a', '/c1', { parentId: 'c2' }),
      page('c2', 'a', '/c2', { parentId: 'c1' }),
    ]
    const m = buildModel(dataset({ properties: [property('a')], pages, links: [{ fromPageId: 'root', toPageId: 'p1', kind: 'parent' }] }))
    const kinds = validateRegistry(m, pages).map((i) => i.kind)
    expect(kinds).toEqual(expect.arrayContaining(['DUPLICATE_ROUTE', 'ACCIDENTAL_ALIAS', 'ALIAS_COLLISION', 'CONFLICTING_CANONICAL', 'MISSING_PARENT', 'PARENT_CYCLE', 'ORPHAN']))
    expect(isOrphan(m, m.page.get('p7')!)).toBe(true)
    expect(isOrphan(m, m.page.get('p1')!)).toBe(false)
  })
  it('does not judge reachability for a property with no link data', () => {
    const pages = [page('h', 'o', '/', { stage: built }), page('s', 'o', '/start', { parentId: 'h', stage: built })]
    const m = buildModel(dataset({ properties: [property('o')], pages }))
    expect(validateRegistry(m, pages).filter((i) => i.kind === 'ORPHAN')).toHaveLength(0)
  })
})

describe('keyword → page ownership', () => {
  const base = () => {
    const pages = [
      page('a', 'p', '/a', { primaryClusterId: 'c-shared', intent: 'transactional' }),
      page('b', 'p', '/b', { primaryClusterId: 'c-shared', intent: 'transactional' }),
      page('guide', 'p', '/guide', { intent: 'informational', primaryClusterId: 'c-money', secondaryClusterIds: ['c1', 'c2', 'c3'] }),
      page('fl', 'p', '/fl', { primaryClusterId: 'c-geo', geographyIds: ['us-fl'] }),
      page('fl2', 'p', '/fl-2', { primaryClusterId: 'c-geo', geographyIds: ['us-fl'] }),
      page('tx', 'p', '/tx', { primaryClusterId: 'c-geo', geographyIds: ['us-tx'] }),
      page('owner', 'p', '/owner', { primaryClusterId: 'c-owned' }),
      page('linker', 'p', '/linker'),
      page('other', 'p', '/other', { copy: { title: 'Same', h1: null, meta: null, state: 'SOURCE_UNAPPROVED' } }),
      page('other2', 'p', '/other-2', { copy: { title: 'Same', h1: null, meta: null, state: 'SOURCE_UNAPPROVED' } }),
    ]
    const clusters = [
      cluster('c-shared', 'p'), cluster('c-none', 'p', { ownerRef: 'future-page' }), cluster('c-money', 'p', { intent: 'transactional' }),
      cluster('c1', 'p'), cluster('c2', 'p'), cluster('c3', 'p'),
      cluster('c-geo', 'p', { primaryKeyword: '{state} sell house', geoLevel: 'STATE' }), cluster('c-owned', 'p', { ownerPageId: 'owner' }),
    ]
    const keywords = [keyword('k-orphan', 'p', 'loose query'), keyword('k-page', 'p', 'page owned', { assignedPageId: 'a' })]
    const links = [{ fromPageId: 'linker', toPageId: 'a', kind: 'content' as const, anchorClusterId: 'c-owned' }]
    return buildModel(dataset({ properties: [property('p')], pages, clusters, keywords, links }))
  }
  it('detects every conflict kind with the product sentence', () => {
    const c = ownershipConflicts(base(), 'p')
    const by = (k: string) => c.filter((x) => x.kind === k)
    expect(by('CLUSTER_WITHOUT_PAGE').map((x) => x.clusterIds[0])).toContain('c-none')
    expect(by('CLUSTER_WITHOUT_PAGE')[0].message).toMatch(/no destination page/)
    expect(by('COMPETING_PAGES').some((x) => x.message === '2 pages compete for this topic.' && x.clusterIds[0] === 'c-shared')).toBe(true)
    expect(by('CONFLICTING_INTENT').map((x) => x.pageIds[0])).toContain('guide')
    expect(by('PAGE_OVERREACH').map((x) => x.pageIds[0])).toContain('guide')
    expect(by('LINK_TO_WRONG_OWNER')[0].message).toMatch(/the owner is \/owner/)
    expect(by('ORPHANED_KEYWORD').map((x) => x.keywordIds[0])).toEqual(['k-orphan'])
    expect(by('DUPLICATE_PAGE_IDENTITY')).toHaveLength(1)
  })
  it('templated clusters are owned per geography: two Florida pages compete, Texas does not', () => {
    const geo = ownershipConflicts(base(), 'p').filter((x) => x.kind === 'COMPETING_PAGES' && x.clusterIds[0] === 'c-geo')
    expect(geo).toHaveLength(1)
    expect(geo[0].pageIds.sort()).toEqual(['fl', 'fl2'])
    expect(ownershipTable(base(), 'p').find((r) => r.cluster.id === 'c-geo')?.state).toBe('CONTESTED')
  })
})

describe('geography coverage + drill', () => {
  const m = buildModel(dataset({
    properties: [property('p', { expectations: [{ kind: 'geo-family', id: 'x', label: 'states', family: 'market-state', geographyIds: ['us-fl', 'us-ga'], source: { kind: 'operator', label: 't' } }] })],
    pages: [
      page('fl', 'p', '/fl', { family: 'market-state', geographyIds: ['us-fl'], status: 'READY', stage: built }),
      page('md', 'p', '/fl/miami-dade', { family: 'market-county', geographyIds: ['us-fl-miami-dade-county'], parentId: 'fl' }),
      page('mia', 'p', '/fl/miami-dade/miami', { family: 'market-city', geographyIds: ['us-fl-miami'], parentId: 'md' }),
    ],
  }))
  it('rolls planned pages up the hierarchy and drills Florida → Miami-Dade → Miami', () => {
    const cov = geoCoverage(m, 'p')
    expect(cov.get('us-fl')?.planned).toBe(3)
    expect(cov.get('us-fl')?.ready).toBe(1)
    expect(cov.get('us-fl')?.indexed).toBeNull()
    expect(drillChildren(m, cov, 'us-fl').map((c) => c.geo.name)).toEqual(['Miami-Dade County'])
    expect(drillChildren(m, cov, 'us-fl-miami-dade-county').map((c) => c.geo.name)).toEqual(['Miami'])
    expect(cov.get('us-fl-miami')?.direct.map((p) => p.id)).toEqual(['mia'])
    expect(completion(cov.get('us-fl')!)).toBeCloseTo(1 / 3)
  })
  it('reports a declared place with no page of the expected family as a gap', () => {
    expect(coverageGaps(m, 'p').map((g) => g.kind === 'GEO_WITHOUT_PAGE' && g.geographyId)).toEqual(['us-ga'])
  })
})

describe('launch waves', () => {
  const m = buildModel(dataset({
    properties: [property('p')],
    waves: [wave('w0', 'p', 0, { status: 'LAUNCHED' }), wave('w1', 'p', 1, { dependsOn: ['w0'], blockers: ['owner approval'] }), wave('w2', 'p', 2, { dependsOn: ['w1'] })],
    pages: [page('a', 'p', '/a', { launchWaveId: 'w1', status: 'READY' }), page('b', 'p', '/b', { launchWaveId: 'w1', status: 'NEEDS_WORK' })],
  }))
  it('derives readiness from pages and inherits unmet dependencies as blockers', () => {
    const r1 = waveReadiness(m, m.wave.get('w1')!)
    expect(r1).toMatchObject({ pages: 2, ready: 1 })
    expect(r1.byStatus.NEEDS_WORK).toBe(1)
    expect(r1.blockers).toEqual(['owner approval'])
    expect(waveReadiness(m, m.wave.get('w2')!).blockers).toEqual(['Depends on w1'])
    expect(nextWave(m, 'p')?.id).toBe('w1')
  })
})

describe('opportunities engine', () => {
  const m = buildModel(dataset({
    properties: [property('p')],
    pages: [page('r', 'p', '/', { stage: built, status: 'READY', copy: { title: 'T', h1: 'H', meta: 'M', state: 'SOURCE_UNAPPROVED' } }), page('x', 'p', '/x', { stage: built, parentId: 'r' })],
    clusters: [cluster('c', 'p')],
    keywords: [keyword('k', 'p', 'sell my house', { clusterId: 'c' })],
    links: [{ fromPageId: 'r', toPageId: 'r', kind: 'content' }],
    connections: none('p'),
  }))
  it('every opportunity carries its rule, a reason and evidence', () => {
    const ops = allOpportunities(m, 'p')
    expect(ops.length).toBeGreaterThan(0)
    for (const o of ops) {
      expect(RULES.some((r) => r.id === o.ruleId)).toBe(true)
      expect(o.why.length).toBeGreaterThan(20)
      expect(o.evidence.length).toBeGreaterThan(0)
    }
    expect(ops.map((o) => o.ruleId)).toEqual(expect.arrayContaining(['cluster-without-page', 'copy-not-approved', 'orphan-page', 'missing-metadata']))
  })
  it('live rules emit nothing without provider facts — and fire deterministically with them', () => {
    expect(liveOpportunities(m, EMPTY_LIVE, null)).toEqual([])
    const facts = {
      page: new Map(),
      keyword: new Map([['k', { provider: 'SEARCH_CONSOLE' as const, through: '2026-10-01', impressions: 900, clicks: 3, position: 8.4, previousPosition: 12.1 }]]),
      queryPage: [
        { keywordId: 'k', pageId: 'r', impressions: 600, clicks: 2, position: 8, through: '2026-10-01' },
        { keywordId: 'k', pageId: 'x', impressions: 300, clicks: 1, position: 14, through: '2026-10-01' },
      ],
    }
    const ids = liveOpportunities(m, facts, 'p').map((o) => o.ruleId)
    expect(ids).toEqual(expect.arrayContaining(['striking-distance', 'low-ctr', 'fast-gainer', 'cannibalization']))
  })
  it('the brief reports the plan and leaves post-launch sections unavailable with a reason', () => {
    const ops = preLaunchOpportunities(m, 'p')
    const b = preLaunchBrief(m, 'p', ops)
    expect(b.pagesTotal).toBe(2)
    expect(b.clustersWithoutPages).toBe(1)
    for (const s of postLaunchState(m, 'p')) expect(s.reason).toBe('AWAITING_LAUNCH')
    const sum = propertySummary(m, m.property.get('p')!, ops)
    expect(sum.pagesIndexed).toBeNull()
    expect(sum.dataFreshness).toBeNull()
    expect(sum.mode).toBe('PLANNING')
  })
})

describe('site graph', () => {
  it('groups wide fan-outs by family and supports expand/collapse + path-to', () => {
    const pages = [page('root', 'p', '/', { stage: built })]
    for (let i = 0; i < 30; i += 1) pages.push(page(`c${i}`, 'p', `/city-${i}`, { parentId: 'root', family: 'city' }))
    for (let i = 0; i < 5; i += 1) pages.push(page(`g${i}`, 'p', `/guide-${i}`, { parentId: 'root', family: 'guide' }))
    const m = buildModel(dataset({ properties: [property('p')], pages }))
    const t = buildTree(m, 'p')
    const root = t.children[0]
    expect(root.children.map((c) => c.kind)).toEqual(['group', 'group'])
    const cityGroup = root.children.find((c) => c.family === 'city')!
    expect(cityGroup.size).toBe(30)
    const collapsed = layoutTree(t, defaultExpanded(t))
    expect(collapsed.nodes.find((n) => n.node.id === cityGroup.id)?.collapsed).toBe(true)
    const open = layoutTree(t, new Set([...defaultExpanded(t), cityGroup.id]))
    expect(open.nodes.length).toBe(collapsed.nodes.length + 30)
    const target = findPageNode(t, 'c7')!
    expect(pathTo(t, target.id)).toEqual([t.id, root.id, cityGroup.id, target.id])
  })
  it('hit-tests in layout space', () => {
    const pages = [page('root', 'p', '/'), page('a', 'p', '/a', { parentId: 'root' })]
    const m = buildModel(dataset({ properties: [property('p')], pages }))
    const t = buildTree(m, 'p')
    const l = layoutTree(t, defaultExpanded(t, 9), 'tree')
    const hit = buildHitGrid(l)
    const a = l.nodes.findIndex((n) => n.node.pageId === 'a')
    expect(hit(l.nodes[a].x + 2, l.nodes[a].y + 1, 10)).toBe(a)
  })
})

describe('first-party telemetry design', () => {
  const ok = { event: 'form_submit' as const, property_id: 'p', anonymous_id: 'a1b2c3d4e5f6g7h8', session_id: 's1b2c3d4e5f6g7h8', occurred_at: '2026-10-04T00:00:00Z', props: { path: '/sell', form_id: 'offer' } }
  it('covers the 13 designed events and assigns outcomes to the LeadCommand bridge', () => {
    expect(TELEMETRY_EVENTS).toHaveLength(13)
    expect(EVENT_SPEC.deal_closed.origin).toBe('leadcommand-bridge')
    expect(EVENT_SPEC.page_view.origin).toBe('site')
  })
  it('accepts a clean event and rejects contact data, raw addresses and non-opaque ids', () => {
    expect(validateEvent(ok)).toEqual([])
    expect(validateEvent({ ...ok, props: { ...ok.props, email: 'x@y.z' } }).map((v) => v.field)).toContain('email')
    expect(validateEvent({ ...ok, event: 'address_entered', props: { path: '/', address_token: '123 Main St Miami' } }).map((v) => v.field)).toContain('address_token')
    expect(validateEvent({ ...ok, anonymous_id: 'ryan' }).map((v) => v.field)).toContain('anonymous_id')
    expect(validateEvent({ ...ok, props: { path: '/', form_id: '+1 (555) 123-4567' } }).map((v) => v.problem)).toContain('value looks like contact data')
  })
  it('the LeadCommand bridge is an interface only', () => {
    expect(LEADCOMMAND_BRIDGE).toBeNull()
    expect(JOURNEY.filter((j) => j.owner === 'leadcommand').map((j) => j.step)).toEqual(['lead', 'conversation', 'offer', 'contract', 'close'])
  })
})

describe('command search', () => {
  it('finds objects across kinds and respects the property scope', () => {
    const m = buildModel(dataset({ properties: [property('p'), property('q')], pages: [page('a', 'p', '/we-buy-houses/florida'), page('b', 'q', '/florida-guide')], clusters: [cluster('c', 'p', { primaryKeyword: 'sell house florida' })] }))
    const idx = buildSearchIndex(m, [])
    expect(searchObjects(idx, 'florida', null).map((h) => h.ref.kind)).toEqual(expect.arrayContaining(['page', 'cluster', 'geography']))
    expect(searchObjects(idx, 'florida', 'q').filter((h) => h.ref.kind === 'page').map((h) => h.ref.id)).toEqual(['b'])
  })
})

describe('scale (§33) — 500 / 2,500 / 10,000 pages', () => {
  for (const n of [500, 2500, 10000]) {
    it(`builds, validates, rules and lays out ${n.toLocaleString()} pages within budget`, () => {
      const t0 = performance.now()
      const ds = syntheticScale(n)
      const m = buildModel(ds)
      const t1 = performance.now()
      const ops = allOpportunities(m, null)
      const t2 = performance.now()
      const tree = buildTree(m, 'zz')
      const layout = layoutTree(tree, new Set(Array.from({ length: n }, (_, i) => `p:zz:p${i}`).concat(['prop:zz', 'p:zz:root'])), 'radial')
      const t3 = performance.now()
      expect(ds.pages).toHaveLength(n)
      expect(layout.nodes.length).toBeLessThanOrEqual(VISIBLE_BUDGET + 1)
      for (const node of layout.nodes) expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true)
      expect(ops.length).toBeGreaterThan(0)
      console.info(`[si-perf] pages=${n} keywords=${ds.keywords.length} links=${ds.links.length} model=${(t1 - t0).toFixed(1)}ms rules=${(t2 - t1).toFixed(1)}ms tree+layout=${(t3 - t2).toFixed(1)}ms visible=${layout.nodes.length} budgetCollapsed=${layout.budgetCollapsed}`)
      expect(t3 - t0).toBeLessThan(n <= 2500 ? 2000 : 6000)
    })
  }
})
