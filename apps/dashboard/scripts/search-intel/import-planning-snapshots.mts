/**
 * SEARCH INTELLIGENCE — import the EXISTING SEO planning of each property into
 * a provenance-stamped snapshot the workspace renders.
 *
 * READ-ONLY with respect to every source repository: modules are imported and
 * files are read; nothing is written outside this repo's snapshot directory.
 * No network, no database, no credentials.
 *
 * Nothing here invents strategy, copy or metrics. Every object carries the
 * file it came from. Legacy Search Console figures are copied ONLY as labelled
 * legacy evidence (the legacy site's own historical export, with its window) —
 * never as a live measure.
 *
 *   node_modules/.bin/tsx --tsconfig <reivesti>/tsconfig.json \
 *     apps/dashboard/scripts/search-intel/import-planning-snapshots.mts --only=reivesti [--reivesti=<path>]
 *   node_modules/.bin/tsx --tsconfig <prominent>/tsconfig.json \
 *     apps/dashboard/scripts/search-intel/import-planning-snapshots.mts --only=prominent [--prominent=<path>]
 *
 * Run from the repo root with the repo's own tsx (already installed). The
 * Prominent repo resolves `@/` through its tsconfig, which tsx picks up when
 * passed --tsconfig; this script imports Prominent modules lazily after
 * chdir so its relative paths resolve.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '../../src/modules/search-intelligence/data/snapshots')
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const REIVESTI = arg('reivesti', '/Users/ryankindle/reivesti-converge')
const PROMINENT = arg('prominent', '/Users/ryankindle/v0-v0realestatelandingsitemain')
const CAPTURED = new Date().toISOString().slice(0, 10)

type Json = Record<string, unknown>

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}
function repoFacts(repo: string) {
  return {
    repo,
    branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git(repo, 'rev-parse', 'HEAD'),
    dirty: git(repo, 'status', '--porcelain').length > 0,
  }
}
const prov = (facts: ReturnType<typeof repoFacts>, kind: 'repo-registry' | 'repo-doc' | 'import', label: string, file: string) => ({
  kind, label, path: file, repo: facts.repo, branch: facts.branch, commit: facts.commit.slice(0, 12), capturedAt: CAPTURED,
})

/** Minimal RFC-4180 CSV reader (quoted fields, doubled quotes, newlines in quotes). */
function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const normPath = (p: string) => {
  if (!p) return '/'
  let x = p.replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0]
  if (!x.startsWith('/')) x = `/${x}`
  if (x.length > 1) x = x.replace(/\/+$/, '')
  return x
}

const STATE_CODE: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
}
const CODE_STATE = Object.fromEntries(Object.entries(STATE_CODE).map(([n, c]) => [c, n]))

/* ── geography registry (shared ids across properties) ──────────────────── */

const places = new Map<string, Json>()
function stateGeo(code: string): string {
  const id = `us-${code.toLowerCase()}`
  if (!places.has(id)) places.set(id, { id, kind: 'STATE', name: CODE_STATE[code] ?? code, code, parentId: 'us', stateCode: code })
  return id
}
function countyGeo(code: string, county: string): string {
  const name = /county|parish/i.test(county) ? county : `${county} County`
  const id = `us-${code.toLowerCase()}-${slug(name)}`
  if (!places.has(id)) places.set(id, { id, kind: 'COUNTY', name, code: null, parentId: stateGeo(code), stateCode: code })
  return id
}
function cityGeo(code: string, city: string, countyId: string | null = null): string {
  const id = `us-${code.toLowerCase()}-${slug(city)}`
  const prev = places.get(id)
  if (!prev) places.set(id, { id, kind: 'CITY', name: city, code: null, parentId: countyId ?? stateGeo(code), stateCode: code })
  else if (countyId && prev.parentId === stateGeo(code)) prev.parentId = countyId
  return id
}
function metroGeo(code: string, market: string): string {
  const id = `us-${code.toLowerCase()}-${slug(market)}-metro`
  if (!places.has(id)) places.set(id, { id, kind: 'METRO', name: `${market} metro`, code: null, parentId: stateGeo(code), stateCode: code })
  return id
}

/* ── REIVESTI ───────────────────────────────────────────────────────────── */

async function importReivesti() {
  const facts = repoFacts(REIVESTI)
  const lib = (f: string) => path.join(REIVESTI, f)
  const { REGISTRY } = await import(lib('lib/seo/registry.ts'))
  const { CLUSTERS } = await import(lib('lib/seo/demand/clusters.ts'))
  const { WAVES } = await import(lib('lib/seo/demand/roadmap.ts'))
  const { WAVE1_PILOT } = await import(lib('lib/seo/demand/pilot.ts'))
  const authority = JSON.parse(fs.readFileSync(lib('docs/seo/legacy-audit/market-page-authority.json'), 'utf8'))

  const REG = prov(facts, 'repo-registry', 'Reivesti SEO registry', 'lib/seo/registry.ts')
  const CLU = prov(facts, 'repo-registry', 'Reivesti keyword cluster registry', 'lib/seo/demand/clusters.ts')
  const RMAP = prov(facts, 'repo-doc', 'Reivesti growth roadmap (waves 0–5)', 'lib/seo/demand/roadmap.ts')
  const PILOT = prov(facts, 'repo-doc', 'Reivesti Wave 1 pilot', 'lib/seo/demand/pilot.ts')
  const QUEUE = prov(facts, 'repo-doc', 'Reivesti next page queue', 'docs/seo/NEXT_PAGE_QUEUE.md')
  const LEG = prov(facts, 'import', 'Legacy Carrot site — Search Console export (ingested by the SEO lane)', 'docs/seo/legacy-audit/market-page-authority.json')

  const pid = 'reivesti'
  const pages: Json[] = []
  const byRoute = new Map<string, Json>()
  const idOf = (registryId: string) => `rv:${registryId}`

  // cluster → wave from the roadmap
  const waveOfCluster = new Map<string, number>()
  for (const w of WAVES as Array<{ wave: number; clusterIds: string[] }>) for (const c of w.clusterIds) waveOfCluster.set(c, w.wave)
  // owner registry id → cluster id (one owner per cluster is enforced upstream)
  const clusterOfOwner = new Map<string, string>()
  for (const c of CLUSTERS as Array<{ id: string; recommendedOwner: string }>) if (!c.recommendedOwner.includes('{')) clusterOfOwner.set(c.recommendedOwner, c.id)

  for (const p of REGISTRY as Array<Json & { id: string; route: string; geo?: Json }>) {
    const pub = p.publication as string
    const status = pub === 'live' ? 'READY' : pub === 'draft' ? 'BUILDING' : 'PLANNED'
    const geo = p.geo as { stateCode?: string; marketSlug?: string; stateName?: string } | undefined
    const geographyIds: string[] = []
    if (geo?.stateCode && !geo.marketSlug) geographyIds.push(stateGeo(geo.stateCode))
    if (geo?.stateCode && geo.marketSlug) geographyIds.push(metroGeo(geo.stateCode, (p.h1 as string).replace(/ investment market$/i, '').replace(/^\w/, (x) => x.toUpperCase())))
    const clusterId = clusterOfOwner.get(p.id) ?? (p.family === 'state' ? 'state-hub' : p.family === 'metro' ? 'metro-investment-properties' : null)
    const page = {
      id: idOf(p.id), propertyId: pid, path: normPath(p.route), family: p.family, parentId: p.parentId ? idOf(p.parentId as string) : null,
      geographyIds, intent: p.intent, primaryClusterId: clusterId ? `rv:c:${clusterId}` : null, secondaryClusterIds: [],
      secondaryKeywords: (p.secondaryKeywords as string[]) ?? [], primaryKeyword: String(p.primaryKeyword ?? '').startsWith('__anchor:') ? null : p.primaryKeyword,
      copy: { title: p.title ?? null, h1: p.h1 ?? null, meta: p.description ?? null, state: 'SOURCE_UNAPPROVED' },
      canonical: normPath(p.route), schemaTypes: (p.schemaTypes as string[]) ?? [], indexability: 'COMPUTED_BY_GATE', robots: null,
      inSitemap: p.governance === 'governed' && pub === 'live' ? true : null,
      launchWaveId: clusterId && waveOfCluster.has(clusterId) ? `rv:w:${waveOfCluster.get(clusterId)}` : null,
      status, stage: { planned: true, builtRoute: pub !== 'queued', published: false, indexed: null },
      thesis: null, notes: (p.notes as string) ?? null, aliases: [], source: REG,
      relatedPaths: ((p.relatedRoutes as string[]) ?? []).map(normPath), governance: p.governance,
    }
    pages.push(page)
    byRoute.set(page.path, page)
  }

  // Wave 1 pilot pages not in the registry yet (planned + researched)
  for (const x of WAVE1_PILOT as Array<Json & { id: string; route: string; clusterId: string }>) {
    const route = normPath(x.route)
    const existing = byRoute.get(route)
    if (existing) { existing.thesis = String(x.canonicalOwnership ?? ''); continue }
    const family = route.startsWith('/markets/') ? 'metro' : /-wholesale-real-estate$/.test(route) ? 'wholesale-metro' : route.startsWith('/directory/') ? 'provider-category' : 'national'
    const geographyIds: string[] = []
    let parent = 'rv:home'
    if (route === '/markets/texas/dallas') { geographyIds.push(metroGeo('TX', 'Dallas')); parent = 'rv:state-texas' }
    if (route === '/dallas-tx-wholesale-real-estate') geographyIds.push(cityGeo('TX', 'Dallas'))
    const page = {
      id: `rv:pilot:${x.id}`, propertyId: pid, path: route, family, parentId: parent, geographyIds, intent: null,
      primaryClusterId: `rv:c:${x.clusterId}`, secondaryClusterIds: [], secondaryKeywords: [], primaryKeyword: null,
      copy: { title: null, h1: null, meta: null, state: 'NOT_WRITTEN' }, canonical: route, schemaTypes: [], indexability: 'UNDECIDED',
      robots: null, inSitemap: null, launchWaveId: waveOfCluster.has(x.clusterId) ? `rv:w:${waveOfCluster.get(x.clusterId)}` : null,
      status: 'RESEARCHED', stage: { planned: true, builtRoute: false, published: false, indexed: null },
      thesis: String(x.canonicalOwnership ?? ''), notes: `Wave 1 pilot rank ${x.rank}.`, aliases: [], source: PILOT, relatedPaths: [],
    }
    pages.push(page)
    byRoute.set(route, page)
  }

  // Next page queue — P1 market pages and their state hubs (docs/seo/NEXT_PAGE_QUEUE.md)
  const queue: Array<{ route: string; family: string; parent: string; geo: () => string; note: string }> = [
    { route: '/markets/georgia', family: 'state', parent: 'rv:markets-national', geo: () => stateGeo('GA'), note: 'State hub required before /markets/georgia/atlanta (P1 #5).' },
    { route: '/markets/florida', family: 'state', parent: 'rv:markets-national', geo: () => stateGeo('FL'), note: 'State hub required before /markets/florida/miami (P1 #6).' },
    { route: '/markets/georgia/atlanta', family: 'metro', parent: '/markets/georgia', geo: () => metroGeo('GA', 'Atlanta'), note: 'P1 #5. Not registered in lib/seo/registry.ts; registering as queued is a prerequisite.' },
    { route: '/markets/florida/miami', family: 'metro', parent: '/markets/florida', geo: () => metroGeo('FL', 'Miami'), note: 'P1 #6. Not registered in lib/seo/registry.ts; registering as queued is a prerequisite.' },
  ]
  for (const q of queue) {
    if (byRoute.has(q.route)) continue
    const parentId = q.parent.startsWith('/') ? (byRoute.get(q.parent)?.id as string) : q.parent
    const page = {
      id: `rv:queue:${slug(q.route)}`, propertyId: pid, path: q.route, family: q.family, parentId, geographyIds: [q.geo()], intent: 'commercial-investigation',
      primaryClusterId: q.family === 'state' ? 'rv:c:state-hub' : 'rv:c:metro-investment-properties', secondaryClusterIds: [], secondaryKeywords: [], primaryKeyword: null,
      copy: { title: null, h1: null, meta: null, state: 'NOT_WRITTEN' }, canonical: q.route, schemaTypes: [], indexability: 'UNDECIDED', robots: null, inSitemap: null,
      launchWaveId: 'rv:w:1', status: 'PLANNED', stage: { planned: true, builtRoute: false, published: false, indexed: null },
      thesis: null, notes: q.note, aliases: [], source: QUEUE, relatedPaths: [],
    }
    pages.push(page)
    byRoute.set(q.route, page)
  }

  // Legacy wholesale city pages: Wave 0 preserve-and-rebuild destinations (wholesale-metro family)
  const legacyPages = (authority.pages as Array<Json & { path: string; pageType: string; state: string; place: string }>)
  for (const lp of legacyPages) {
    if (lp.pageType !== 'city-wholesale' && lp.pageType !== 'county-wholesale') continue
    const route = normPath(lp.path)
    const isCounty = lp.pageType === 'county-wholesale'
    const geoId = isCounty ? countyGeo(lp.state, lp.place) : cityGeo(lp.state, lp.place)
    const legacy = {
      label: 'Legacy reivesti.com (Carrot) page', window: authority.evidenceRange, clicks: lp.clicks ?? null, impressions: lp.impressions ?? null,
      averagePosition: lp.averagePosition ?? null, tier: lp.authorityTier ?? null, decision: lp.decisionClass ?? null, legacyPath: lp.path, source: LEG,
    }
    const existing = byRoute.get(route)
    if (existing) { existing.legacy = legacy; continue }
    const page = {
      id: `rv:legacy:${slug(route)}`, propertyId: pid, path: route, family: 'wholesale-metro', parentId: 'rv:markets-national', geographyIds: [geoId],
      intent: 'local', primaryClusterId: 'rv:c:wholesale-city', secondaryClusterIds: [], secondaryKeywords: [], primaryKeyword: null,
      copy: { title: null, h1: null, meta: null, state: 'NOT_WRITTEN' }, canonical: route, schemaTypes: [], indexability: 'UNDECIDED', robots: null, inSitemap: null,
      launchWaveId: 'rv:w:0', status: 'PLANNED', stage: { planned: true, builtRoute: false, published: false, indexed: null },
      thesis: null, notes: `Preserve-and-rebuild at the legacy path (Wave 0). Decision: ${lp.decisionClass ?? 'undecided'}. Legacy copy may not be reused (gate criterion 12).`,
      aliases: [], source: LEG, legacy, relatedPaths: [],
    }
    pages.push(page)
    byRoute.set(route, page)
  }

  // Links: parent edges + related routes declared by the registry
  const links: Json[] = []
  for (const p of pages) {
    if (p.parentId && pages.some((x) => x.id === p.parentId)) links.push({ fromPageId: p.parentId, toPageId: p.id, kind: p.stage && (p.stage as Json).builtRoute ? 'parent' : 'planned' })
    for (const r of (p.relatedPaths as string[]) ?? []) {
      const to = byRoute.get(r)
      if (to) links.push({ fromPageId: p.id, toPageId: to.id, kind: 'related' })
    }
  }

  const clusters = (CLUSTERS as Array<Json & { id: string; classification: Json; geo?: Json; recommendedOwner: string; supportingKeywords: string[] }>).map((c) => {
    const owner = c.recommendedOwner
    const ownerPage = owner.includes('{') ? null : pages.find((p) => p.id === idOf(owner)) ?? null
    const pilotOwner = (WAVE1_PILOT as Array<Json>).find((x) => x.clusterId === c.id)
    const ownerPageId = ownerPage ? ownerPage.id : pilotOwner ? (byRoute.get(normPath(String(pilotOwner.route)))?.id ?? null) : null
    return {
      id: `rv:c:${c.id}`, propertyId: pid, label: c.id.replace(/-/g, ' '), primaryKeyword: c.primaryKeyword, parentTopic: c.family ?? null,
      intent: (c.classification as Json)?.intent ?? null, geoLevel: c.geo ? String((c.geo as Json).level).toUpperCase() : null,
      ownerPageId, ownerRef: owner, ownerExists: c.ownerExists, ownerFamily: c.ownerFamily,
      priority: null, wave: waveOfCluster.has(c.id) ? `rv:w:${waveOfCluster.get(c.id)}` : null,
      source: 'PLANNED', provenance: CLU, notes: (c.notes as string) ?? null, confidence: c.confidence ?? null,
      supporting: c.supportingKeywords ?? [],
    }
  })

  const keywords: Json[] = []
  for (const c of clusters) {
    keywords.push({ id: `${c.id}:k:0`, propertyId: pid, query: c.primaryKeyword, clusterId: c.id, intent: c.intent, geographyId: null, assignedPageId: c.ownerPageId, status: c.ownerPageId ? 'MAPPED' : 'PLANNED', priority: null, source: 'PLANNED', provenance: CLU })
    ;(c.supporting as string[]).forEach((q, i) => keywords.push({ id: `${c.id}:k:${i + 1}`, propertyId: pid, query: q, clusterId: c.id, intent: c.intent, geographyId: null, assignedPageId: c.ownerPageId, status: c.ownerPageId ? 'MAPPED' : 'PLANNED', priority: null, source: 'PLANNED', provenance: CLU }))
  }
  for (const p of pages) {
    // `__anchor:<id>` is the registry's placeholder for pages another lane owns — not a keyword
    if (p.primaryKeyword && !String(p.primaryKeyword).startsWith('__anchor:') && !keywords.some((k) => k.query === p.primaryKeyword)) {
      keywords.push({ id: `${p.id}:pk`, propertyId: pid, query: p.primaryKeyword, clusterId: p.primaryClusterId, intent: p.intent, geographyId: (p.geographyIds as string[])[0] ?? null, assignedPageId: p.id, status: 'MAPPED', priority: null, source: 'PLANNED', provenance: REG })
    }
  }

  const waves = (WAVES as Array<Json & { wave: number; name: string; prerequisites: string[]; thesis: string }>).map((w, i) => ({
    id: `rv:w:${w.wave}`, propertyId: pid, label: `Wave ${w.wave} — ${w.name}`, order: i, status: 'PLANNED', targetDate: null,
    dependsOn: w.wave > 0 ? [`rv:w:${w.wave - 1}`] : [], blockers: w.prerequisites ?? [], notes: w.thesis ?? null, source: RMAP,
  }))

  return { propertyId: pid, provenance: facts, pages: pages.map(strip), links, clusters: clusters.map(stripCluster), keywords, waves }
}

/* ── PROMINENT CASH OFFER ───────────────────────────────────────────────── */

async function importProminent() {
  const facts = repoFacts(PROMINENT)
  const f = (p: string) => path.join(PROMINENT, p)
  process.chdir(PROMINENT)
  const mp = await import(f('lib/market-pages.ts'))
  const gate = await import(f('lib/market-gate.ts'))
  const ix = await import(f('lib/indexability.ts'))
  const mk = await import(f('lib/markets.ts'))
  const w1 = await import(f('lib/wave1-content.ts'))
  const w2 = await import(f('lib/wave2-content.ts'))

  const INV = prov(facts, 'repo-registry', 'Prominent SEO route inventory', 'reports/SEO-ROUTE-INVENTORY.csv')
  const GATE = prov(facts, 'repo-registry', 'Prominent indexability gate', 'reports/INDEXABILITY-GATE.csv')
  const MKT = prov(facts, 'repo-registry', 'Prominent market page registry + value gate', 'lib/market-pages.ts')
  const KW = prov(facts, 'repo-doc', 'Prominent keyword universe (owner proposals)', 'reports/SEO-KEYWORD-UNIVERSE.csv')
  const OPS = prov(facts, 'repo-registry', 'Prominent operating states', 'lib/markets.ts')
  const W1 = prov(facts, 'repo-doc', 'Prominent SEO Wave 1', 'reports/SEO-WAVE-1.md')
  const W2 = prov(facts, 'repo-doc', 'Prominent SEO Wave 2', 'reports/SEO-WAVE2-EXECUTION.md')

  const pid = 'prominent'
  const inv = readCsv(f('reports/SEO-ROUTE-INVENTORY.csv'))
  const gateRows = new Map(readCsv(f('reports/INDEXABILITY-GATE.csv')).map((r) => [normPath(r.route), r]))
  const wave1 = new Set([w1.WAVE1_FOUNDATION, w1.WAVE1_GUIDES, w1.WAVE1_GEOGRAPHY, w1.WAVE1_HELP].flatMap((m: Json) => Object.keys(m).map(normPath)))
  const wave2 = new Set(Object.keys(w2.WAVE2_GEOGRAPHY).map(normPath))
  const marketRoutes = new Set((mp.MARKET_ROUTES as string[]).map(normPath))

  const pages: Json[] = []
  const byPath = new Map<string, Json>()
  const pageId = (p: string) => `pco:${p === '/' ? 'home' : slug(p)}`

  const parseJson = <T,>(s: string, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback } catch { return fallback } }

  for (const r of inv) {
    const p = normPath(r.route)
    const g = gateRows.get(p)
    const idx = (g?.status ?? r.indexability_policy) as string
    if (idx === 'REDIRECT_ONLY') continue
    const loc = parseJson<{ name?: string; state?: string; level?: string } | null>(r.location, null)
    const geographyIds: string[] = []
    const code = loc?.state ? STATE_CODE[loc.state] : undefined
    if (code && r.location_level === 'state') geographyIds.push(stateGeo(code))
    if (code && r.location_level === 'county' && loc?.name) geographyIds.push(countyGeo(code, loc.name.split(',')[0]))
    if (code && r.location_level === 'metro' && loc?.name) geographyIds.push(metroGeo(code, loc.name.split(',')[0]))
    if (code && r.location_level === 'city' && loc?.name) {
      const seg = p.split('/').filter(Boolean)
      const countySeg = seg.length === 3 && /county/.test(seg[1]) ? seg[1] : null
      const countyId = countySeg ? countyGeo(code, countySeg.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').replace(/ County$/, '').replace(/^Miami Dade$/, 'Miami-Dade')) : null
      geographyIds.push(cityGeo(code, loc.name.split(',')[0], countyId))
    }
    const marketGate = marketRoutes.has(p) ? gate.evaluateMarketPage(r.route.endsWith('/') ? r.route : `${r.route}/`) : null
    const status = idx === 'READY_TO_INDEX' ? (marketGate && !marketGate.pass ? 'NEEDS_WORK' : 'READY') : marketGate?.pass ? 'QA' : 'NEEDS_WORK'
    const page = {
      id: pageId(p), propertyId: pid, path: p, family: marketRoutes.has(p) ? marketFamily(mp.MARKET_PAGES[`${p}/`] ?? mp.MARKET_PAGES[p]) : familyOf(r.cluster, r.location_level, p), parentId: null as string | null,
      breadcrumbs: parseJson<string[]>(r.breadcrumbs, []).map(normPath), geographyIds, intent: r.primary_intent || null,
      primaryClusterId: null as string | null, secondaryClusterIds: [], secondaryKeywords: [],
      primaryKeyword: null,
      copy: { title: r.title || null, h1: r.h1 || null, meta: r.meta_description || null, state: r.title || r.h1 ? 'SOURCE_UNAPPROVED' : 'NOT_WRITTEN' },
      canonical: parseJson<string[]>(r.canonical, []).map(normPath)[0] ?? null, schemaTypes: parseJson<string[]>(r.structured_data, []),
      indexability: idx === 'READY_TO_INDEX' ? 'INDEX' : 'NOINDEX', robots: r.robots || null, inSitemap: idx === 'READY_TO_INDEX' && !(marketGate && !marketGate.pass),
      launchWaveId: marketRoutes.has(p) ? 'pco:w:markets-ga' : wave1.has(p) ? 'pco:w:1' : wave2.has(p) ? 'pco:w:2' : null,
      status, stage: { planned: true, builtRoute: r.http_status === '200', published: false, indexed: null },
      thesis: r.search_purpose || g?.search_purpose || null,
      notes: [g?.reason, g?.recommendation, marketGate && !marketGate.pass ? `Market value gate ${marketGate.score}: ${marketGate.checks.filter((c: Json) => !c.ok).map((c: Json) => c.label).join('; ')}` : null].filter(Boolean).join(' ') || null,
      aliases: [], source: INV, cluster: r.cluster, qualityStatus: r.quality_status, technicalIssues: parseJson<string[]>(r.technical_issues, []),
    }
    pages.push(page)
    byPath.set(p, page)
  }

  // market registry pages not present in the route inventory
  for (const route of mp.MARKET_ROUTES as string[]) {
    const p = normPath(route)
    if (byPath.has(p)) continue
    const m = mp.MARKET_PAGES[route] as Json & { level: string; state?: string; name: string; city?: string; legacy?: string[] }
    const gr = gate.evaluateMarketPage(route)
    const code = m.state ? STATE_CODE[m.state] : undefined
    const geographyIds: string[] = []
    if (code && m.level === 'state') geographyIds.push(stateGeo(code))
    if (code && m.level === 'county') geographyIds.push(countyGeo(code, m.name.replace(/ County$/, '')))
    if (code && m.level === 'city') geographyIds.push(cityGeo(code, m.name))
    if (code && m.level === 'situation') {
      const seg = p.split('/').filter(Boolean)
      if (seg.length === 4) { const cityPage = mp.MARKET_PAGES[`/${seg.slice(0, 3).join('/')}/`] as Json | undefined; if (cityPage) geographyIds.push(cityGeo(code, String(cityPage.name))) }
      else geographyIds.push(stateGeo(code))
    }
    const ri = (ix.ROUTE_INDEXABILITY as Record<string, string>)[route]
    const page = {
      id: pageId(p), propertyId: pid, path: p, family: marketFamily(m), parentId: null,
      breadcrumbs: [], geographyIds, intent: m.level === 'situation' ? 'seller situation search intent in a specific place' : 'local direct-sale search intent',
      primaryClusterId: null, secondaryClusterIds: [], secondaryKeywords: [], primaryKeyword: null,
      copy: { title: null, h1: null, meta: null, state: 'NOT_WRITTEN' }, canonical: p, schemaTypes: [], indexability: ri === 'READY_TO_INDEX' ? 'INDEX' : 'NOINDEX',
      robots: null, inSitemap: ri === 'READY_TO_INDEX' && gr.pass, launchWaveId: 'pco:w:markets-ga',
      status: ri === 'READY_TO_INDEX' ? (gr.pass ? 'READY' : 'NEEDS_WORK') : gr.pass ? 'QA' : 'NEEDS_WORK',
      stage: { planned: true, builtRoute: true, published: false, indexed: null }, thesis: null,
      notes: `Market value gate ${gr.score}${gr.pass ? ' (pass)' : `: ${gr.checks.filter((c: Json) => !c.ok).map((c: Json) => c.label).join('; ')}`}. Indexability: ${ri ?? 'not in gate'} — enters the index only when the state batch is owner-approved.`,
      aliases: (m.legacy ?? []).map(normPath), source: MKT, cluster: 'geography', qualityStatus: null, technicalIssues: [],
    }
    pages.push(page)
    byPath.set(p, page)
  }

  // hierarchy: market routes nest by path; inventory pages by breadcrumbs, then path prefix
  for (const page of pages) {
    const p = page.path as string
    let parent: Json | undefined
    if (p.startsWith('/we-buy-houses/')) {
      const seg = p.split('/').filter(Boolean)
      for (let n = seg.length - 1; n >= 1 && !parent; n -= 1) parent = byPath.get(`/${seg.slice(0, n).join('/')}`)
    } else {
      const crumbs = (page.breadcrumbs as string[]).filter((c) => c !== p)
      for (let i = crumbs.length - 1; i >= 0 && !parent; i -= 1) parent = byPath.get(crumbs[i])
      if (!parent) {
        const seg = p.split('/').filter(Boolean)
        for (let n = seg.length - 1; n >= 1 && !parent; n -= 1) parent = byPath.get(`/${seg.slice(0, n).join('/')}`)
      }
    }
    if (!parent && p !== '/') parent = byPath.get('/')
    page.parentId = parent && parent !== page ? (parent.id as string) : null
  }

  // internal links: unique CONTENT edges from the link audit (real anchors only — no edge is synthesised
  // from the hierarchy). Sitewide navigation is kept as the set of pages it reaches, not as edges.
  const edges = readCsv(f('reports/SEO-INTERNAL-LINK-EDGES.csv'))
  const seen = new Set<string>()
  const contentEdges: Array<{ a: Json; b: Json; anchor: string }> = []
  const navTargets = new Set<string>()
  let navEdges = 0
  for (const e of edges) {
    const b = byPath.get(normPath(e.destination))
    if (e.area !== 'content') { navEdges += 1; if (b) navTargets.add(b.id as string); continue }
    const a = byPath.get(normPath(e.source))
    if (!a || !b || a === b) continue
    const k = `${a.id}>${b.id}`
    if (seen.has(k)) continue
    seen.add(k)
    contentEdges.push({ a, b, anchor: (e.anchor ?? '').trim().toLowerCase().replace(/\s+/g, ' ') })
  }

  // keyword universe → clusters by family, owner by proposed_owner
  const kw = readCsv(f('reports/SEO-KEYWORD-UNIVERSE.csv'))
  const families = new Map<string, { owner: string; intents: Set<string>; queries: Json[] }>()
  for (const r of kw) {
    const fam = r.family || 'unassigned'
    if (!families.has(fam)) families.set(fam, { owner: normPath(r.proposed_owner), intents: new Set(), queries: [] })
    const fx = families.get(fam)!
    fx.intents.add(r.intent)
    fx.queries.push(r)
  }
  const clusters: Json[] = []
  const keywords: Json[] = []
  for (const [fam, fx] of families) {
    const cid = `pco:c:${slug(fam)}`
    // owner = the most common proposed owner in the family
    const counts = new Map<string, number>()
    for (const q of fx.queries) { const o = normPath(String(q.proposed_owner)); counts.set(o, (counts.get(o) ?? 0) + 1) }
    const owner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const ownerPage = owner ? byPath.get(owner) : undefined
    clusters.push({
      id: cid, propertyId: pid, label: fam.replace(/-/g, ' '), primaryKeyword: String(fx.queries[0].query), parentTopic: null,
      intent: [...fx.intents].join(' / ').toLowerCase(), geoLevel: null, ownerPageId: ownerPage?.id ?? null, ownerRef: owner,
      ownerExists: Boolean(ownerPage), ownerFamily: null, priority: null, wave: null, source: 'PLANNED', provenance: KW,
      notes: `Validation: ${[...new Set(fx.queries.map((q) => q.validation_status))].join(', ')}. Volume is not validated in the source.`, confidence: null, supporting: [],
    })
    if (ownerPage && !ownerPage.primaryClusterId) ownerPage.primaryClusterId = cid
    fx.queries.forEach((q, i) => {
      const o = normPath(String(q.proposed_owner))
      const assigned = byPath.get(o)
      keywords.push({
        id: `${cid}:k:${i}`, propertyId: pid, query: q.query, clusterId: cid, intent: String(q.intent).toLowerCase(), geographyId: null,
        assignedPageId: assigned?.id ?? null, status: assigned ? 'MAPPED' : 'PLANNED', priority: null, source: 'PLANNED', provenance: KW,
        proposedOwner: o, separateUrl: q.separate_url || null,
      })
      if (assigned && assigned.primaryClusterId && assigned.primaryClusterId !== cid && !(assigned.secondaryClusterIds as string[]).includes(cid)) (assigned.secondaryClusterIds as string[]).push(cid)
    })
  }

  // anchor → cluster only on an EXACT match of the anchor text to a planned query
  const queryCluster = new Map<string, string>()
  for (const k of keywords) queryCluster.set(String(k.query).trim().toLowerCase(), String(k.clusterId))
  const links: Json[] = contentEdges.map(({ a, b, anchor }) => ({ fromPageId: a.id, toPageId: b.id, kind: 'content', anchorClusterId: queryCluster.get(anchor) ?? null }))

  // operating states → planned territory (an owner-attested service area, not a page)
  const operatingStates = (mk.OPERATING_STATES as string[]).map((s) => STATE_CODE[s] ?? s)
  for (const c of operatingStates) stateGeo(c)

  const waves = [
    { id: 'pco:w:1', propertyId: pid, label: 'Wave 1 — foundation, guides, geography, help', order: 0, status: 'IN_PROGRESS', targetDate: null, dependsOn: [], blockers: ['Human approval of each review card ("No card is approved by this document").', 'Production smoke verification before indexing.'], notes: null, source: W1 },
    { id: 'pco:w:2', propertyId: pid, label: 'Wave 2 — geography', order: 1, status: 'PLANNED', targetDate: null, dependsOn: ['pco:w:1'], blockers: [], notes: null, source: W2 },
    { id: 'pco:w:markets-ga', propertyId: pid, label: 'Markets — Georgia batch (/we-buy-houses/georgia/…)', order: 2, status: 'IN_PROGRESS', targetDate: null, dependsOn: [], blockers: ['State batch is not owner-approved (ROUTE_INDEXABILITY = NEEDS_ENRICHMENT).', '19 of 33 market pages fail the market value gate (reports/SEO-MARKET-GATE.md).'], notes: 'A market page enters the index and sitemap only when its state batch is owner-approved and it passes every check for its level.', source: MKT },
  ]

  return {
    propertyId: pid, provenance: facts, operatingStates, operatingStatesSource: OPS, navigationEdges: navEdges, navTargets: [...navTargets],
    situations: Object.entries(mp.SITUATIONS as Record<string, { slug: string; label: string }>).map(([key, s]) => ({ key, slug: s.slug, label: s.label })),
    gateSource: GATE,
    audit: (() => {
      const a = JSON.parse(fs.readFileSync(f('reports/SEO-AUDIT-SUMMARY.json'), 'utf8'))
      return {
        source: prov(facts, 'repo-doc', 'Prominent SEO audit summary (local HTTP crawl, not Google)', 'reports/SEO-AUDIT-SUMMARY.json'),
        generatedAt: a.generated_at, routes: a.routes, orphanRoutes: a.orphan_routes.length, weakContextualRoutes: a.weak_contextual_routes.length,
        unreachableFromHome: a.unreachable_from_home.length, missingParentToChild: a.missing_parent_to_child_links.length, sitemapCount: a.sitemap_count,
        highSimilarity: a.high_similarity, redirects: a.redirect_count_including_compatibility, legacyRecords: a.legacy_records, legacyDecisions: a.legacy_decisions,
        measurementLimits: a.measurement_limits,
      }
    })(),
    pages: pages.map(strip), links, clusters: clusters.map(stripCluster), keywords, waves,
  }
}

function marketFamily(m: { level?: string } | undefined): string {
  return !m?.level ? 'market' : m.level === 'situation' ? 'market-situation' : `market-${m.level}`
}

function familyOf(cluster: string, level: string, p: string): string {
  if (p === '/') return 'home'
  if (p.startsWith('/we-buy-houses')) return 'market-national'
  if (cluster === 'geography') return /^\/webuyhouses|^\/[a-z-]+\/$/.test(`${p}/`) && level !== 'state' && level !== 'county' && !p.includes('/', 1) ? `legacy-${level}` : `geo-${level}`
  return cluster || 'page'
}

function strip(p: Json): Json {
  const { relatedPaths: _r, breadcrumbs: _b, ...rest } = p
  return rest
}
function stripCluster(c: Json): Json {
  const { supporting: _s, ...rest } = c
  return rest
}

/* ── run ────────────────────────────────────────────────────────────────── */

const ONLY = arg('only', '')
fs.mkdirSync(OUT_DIR, { recursive: true })
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(data)}\n`)
const summary = (s: { provenance: { commit: string; dirty: boolean }; pages: unknown[]; links: unknown[]; clusters: unknown[]; keywords: unknown[]; waves: unknown[] }) =>
  ({ commit: s.provenance.commit.slice(0, 12), dirty: s.provenance.dirty, pages: s.pages.length, links: s.links.length, clusters: s.clusters.length, keywords: s.keywords.length, waves: s.waves.length })
// Each source repo resolves `@/` against its own root, so run once per property with that repo's tsconfig:
//   --only=reivesti  --tsconfig <reivesti>/tsconfig.json
//   --only=prominent --tsconfig <prominent>/tsconfig.json
if (ONLY !== 'reivesti' && ONLY !== 'prominent') {
  console.error('usage: tsx --tsconfig <repo>/tsconfig.json import-planning-snapshots.mts --only=reivesti|prominent')
  process.exit(2)
}
const snap = ONLY === 'reivesti' ? await importReivesti() : await importProminent()

/**
 * Pack: provenance objects become keys into one table, long free text is
 * interned, links become [from, to, kind] tuples. The loader
 * (data/snapshot-loader.ts) reverses it exactly.
 */
function pack<T extends { pages: Json[]; links: Json[]; clusters: Json[]; keywords: Json[]; waves: Json[] }>(x: T) {
  const sources: Record<string, unknown> = {}
  const srcKey = new Map<string, string>()
  const texts: string[] = []
  const textIdx = new Map<string, number>()
  const src = (o: unknown) => {
    if (!o || typeof o !== 'object') return o
    const j = JSON.stringify(o)
    if (!srcKey.has(j)) { const k = `s${srcKey.size}`; srcKey.set(j, k); sources[k] = o }
    return srcKey.get(j)
  }
  const txt = (t: unknown) => {
    if (typeof t !== 'string' || t.length < 24) return t
    if (!textIdx.has(t)) { textIdx.set(t, texts.length); texts.push(t) }
    return textIdx.get(t)
  }
  const fix = (o: Json) => {
    const out: Json = { ...o }
    for (const k of ['source', 'provenance']) if (k in out) out[k] = src(out[k])
    for (const k of ['notes', 'thesis', 'intent']) if (k in out) out[k] = txt(out[k])
    if (out.legacy && typeof out.legacy === 'object') out.legacy = { ...(out.legacy as Json), source: src((out.legacy as Json).source) }
    if (out.copy && typeof out.copy === 'object') out.copy = { ...(out.copy as Json), meta: txt((out.copy as Json).meta) }
    return out
  }
  const LINK_KIND = ['parent', 'related', 'nav', 'content', 'planned']
  return {
    ...x,
    pages: x.pages.map(fix), clusters: x.clusters.map(fix), keywords: x.keywords.map(fix), waves: x.waves.map(fix),
    links: x.links.map((l) => (l.anchorClusterId ? [l.fromPageId, l.toPageId, LINK_KIND.indexOf(String(l.kind)), l.anchorClusterId] : [l.fromPageId, l.toPageId, LINK_KIND.indexOf(String(l.kind))])),
    sources, texts, format: 'si-snapshot/1',
  }
}
/**
 * State label points from the Census outlines this repo already ships
 * (apps/dashboard/static/geo/us-states.json): area-weighted centroid of the
 * largest polygon, so Florida's point sits on the peninsula, not in the Gulf.
 */
const STATES_GEOJSON = path.resolve(HERE, '../../static/geo/us-states.json')
const statePoints = new Map<string, [number, number]>()
for (const ft of JSON.parse(fs.readFileSync(STATES_GEOJSON, 'utf8')).features as Array<{ properties: { abbr: string }; geometry: { type: string; coordinates: number[][][] | number[][][][] } }>) {
  const polys = (ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates) as number[][][][]
  let best: { a: number; x: number; y: number } | null = null
  for (const poly of polys) {
    const ring = poly[0]
    let a = 0, cx = 0, cy = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
      a += cross; cx += (ring[j][0] + ring[i][0]) * cross; cy += (ring[j][1] + ring[i][1]) * cross
    }
    if (a !== 0 && (!best || Math.abs(a) > Math.abs(best.a))) best = { a, x: cx / (3 * a), y: cy / (3 * a) }
  }
  if (best) statePoints.set(ft.properties.abbr, [Math.round(best.y * 100) / 100, Math.round(best.x * 100) / 100])
}
for (const pl of places.values()) if (pl.kind === 'STATE') { const pt = statePoints.get(String(pl.code)); if (pt) { pl.lat = pt[0]; pl.lng = pt[1] } }
const geo = [...places.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
write(`${ONLY}.json`, { ...pack(snap), places: geo })
console.log(JSON.stringify({ [ONLY]: summary(snap), places: geo.length }))
