/**
 * The indexed model every rule and view reads. Built once per dataset in
 * O(pages + links + keywords); all lookups after that are map reads.
 */
import type {
  InternalLink, KeywordCluster, LaunchWave, PropertyConnection, SearchDataset, SearchGeography, SearchKeyword, SearchPage, SearchProperty,
} from './types'

export interface SearchModel {
  dataset: SearchDataset
  property: Map<string, SearchProperty>
  page: Map<string, SearchPage>
  cluster: Map<string, KeywordCluster>
  keyword: Map<string, SearchKeyword>
  geo: Map<string, SearchGeography>
  wave: Map<string, LaunchWave>
  pagesOf: Map<string, SearchPage[]>
  clustersOf: Map<string, KeywordCluster[]>
  keywordsOf: Map<string, SearchKeyword[]>
  wavesOf: Map<string, LaunchWave[]>
  connectionsOf: Map<string, PropertyConnection[]>
  children: Map<string, SearchPage[]>
  linksOut: Map<string, InternalLink[]>
  linksIn: Map<string, InternalLink[]>
  /** pages whose primary cluster is this cluster */
  primaryPagesOf: Map<string, SearchPage[]>
  /** pages that support (secondary) this cluster */
  supportPagesOf: Map<string, SearchPage[]>
  keywordsOfCluster: Map<string, SearchKeyword[]>
  pagesAtGeo: Map<string, SearchPage[]>
  geoChildren: Map<string, SearchGeography[]>
  /** page ids reachable from sitewide navigation (recorded by the source audit) */
  navTargets: ReadonlySet<string>
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}

export function buildModel(dataset: SearchDataset, navTargets: ReadonlySet<string> = new Set()): SearchModel {
  const m: SearchModel = {
    dataset,
    property: new Map(dataset.properties.map((p) => [p.id, p])),
    page: new Map(dataset.pages.map((p) => [p.id, p])),
    cluster: new Map(dataset.clusters.map((c) => [c.id, c])),
    keyword: new Map(dataset.keywords.map((k) => [k.id, k])),
    geo: new Map(dataset.geographies.map((g) => [g.id, g])),
    wave: new Map(dataset.waves.map((w) => [w.id, w])),
    pagesOf: new Map(), clustersOf: new Map(), keywordsOf: new Map(), wavesOf: new Map(), connectionsOf: new Map(),
    children: new Map(), linksOut: new Map(), linksIn: new Map(), primaryPagesOf: new Map(), supportPagesOf: new Map(),
    keywordsOfCluster: new Map(), pagesAtGeo: new Map(), geoChildren: new Map(), navTargets,
  }
  for (const p of dataset.pages) {
    push(m.pagesOf, p.propertyId, p)
    if (p.parentId) push(m.children, p.parentId, p)
    if (p.primaryClusterId) push(m.primaryPagesOf, p.primaryClusterId, p)
    for (const c of p.secondaryClusterIds) push(m.supportPagesOf, c, p)
    for (const g of p.geographyIds) push(m.pagesAtGeo, g, p)
  }
  for (const c of dataset.clusters) push(m.clustersOf, c.propertyId, c)
  for (const k of dataset.keywords) {
    push(m.keywordsOf, k.propertyId, k)
    if (k.clusterId) push(m.keywordsOfCluster, k.clusterId, k)
  }
  for (const w of dataset.waves) push(m.wavesOf, w.propertyId, w)
  for (const c of dataset.connections) push(m.connectionsOf, c.propertyId, c)
  for (const l of dataset.links) {
    push(m.linksOut, l.fromPageId, l)
    push(m.linksIn, l.toPageId, l)
  }
  for (const g of dataset.geographies) if (g.parentId) push(m.geoChildren, g.parentId, g)
  for (const ws of m.wavesOf.values()) ws.sort((a, b) => a.order - b.order)
  return m
}

/** Pages for a scope: one property, or every property (portfolio). */
export function pagesIn(m: SearchModel, propertyId: string | null): readonly SearchPage[] {
  return propertyId ? m.pagesOf.get(propertyId) ?? [] : m.dataset.pages
}
export function clustersIn(m: SearchModel, propertyId: string | null): readonly KeywordCluster[] {
  return propertyId ? m.clustersOf.get(propertyId) ?? [] : m.dataset.clusters
}
export function keywordsIn(m: SearchModel, propertyId: string | null): readonly SearchKeyword[] {
  return propertyId ? m.keywordsOf.get(propertyId) ?? [] : m.dataset.keywords
}
export function wavesIn(m: SearchModel, propertyId: string | null): readonly LaunchWave[] {
  return propertyId ? m.wavesOf.get(propertyId) ?? [] : m.dataset.waves
}

/** Ancestors from root to the page's parent. Cycle-safe. */
export function ancestors(m: SearchModel, pageId: string): SearchPage[] {
  const out: SearchPage[] = []
  const seen = new Set<string>([pageId])
  let cur = m.page.get(pageId)?.parentId ?? null
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const p = m.page.get(cur)
    if (!p) break
    out.unshift(p)
    cur = p.parentId
  }
  return out
}

/** Geography ancestors, root (country) first. */
export function geoPath(m: SearchModel, geoId: string): SearchGeography[] {
  const out: SearchGeography[] = []
  const seen = new Set<string>()
  let cur: string | null = geoId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const g = m.geo.get(cur)
    if (!g) break
    out.unshift(g)
    cur = g.parentId
  }
  return out
}
