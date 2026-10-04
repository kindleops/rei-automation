/**
 * Search geography (§12): coverage of PLANS at state → county/metro → city.
 *
 * Before launch only two facts exist per place: pages planned and pages
 * built/ready. Published and indexed coverage are recorded separately and
 * stay empty until the site is live and Search Console reports. Nothing here
 * is a measure of traffic.
 */
import type { SearchModel } from './model'
import { geoPath, pagesIn } from './model'
import { canonicalOwner } from './ownership'
import type { CoverageExpectation, KeywordCluster, SearchGeography, SearchPage } from './types'

export interface GeoCoverage {
  geo: SearchGeography
  /** pages targeting this place or any place inside it */
  planned: number
  built: number
  ready: number
  published: number
  /** null until Search Console reports index status */
  indexed: number | null
  /** pages targeting exactly this place */
  direct: SearchPage[]
  properties: string[]
}

const READYISH = new Set(['READY', 'PUBLISHED', 'INDEXED'])

export function geoCoverage(m: SearchModel, propertyId: string | null): Map<string, GeoCoverage> {
  const out = new Map<string, GeoCoverage>()
  const get = (g: SearchGeography) => {
    let c = out.get(g.id)
    if (!c) { c = { geo: g, planned: 0, built: 0, ready: 0, published: 0, indexed: null, direct: [], properties: [] }; out.set(g.id, c) }
    return c
  }
  for (const p of pagesIn(m, propertyId)) {
    const counted = new Set<string>()
    for (const gid of p.geographyIds) {
      const path = geoPath(m, gid)
      if (!path.length) continue
      get(path[path.length - 1]).direct.push(p)
      for (const g of path) {
        if (counted.has(g.id)) continue
        counted.add(g.id)
        const c = get(g)
        c.planned += 1
        if (p.stage.builtRoute) c.built += 1
        if (READYISH.has(p.status)) c.ready += 1
        if (p.stage.published) c.published += 1
        if (p.stage.indexed === true) c.indexed = (c.indexed ?? 0) + 1
        if (!c.properties.includes(p.propertyId)) c.properties.push(p.propertyId)
      }
    }
  }
  return out
}

/** Completion share of a place, 0..1 — READY pages over planned pages (an architecture measure). */
export const completion = (c: GeoCoverage) => (c.planned ? c.ready / c.planned : 0)

/** Drill children of a geography that carry plans in scope, largest first. */
export function drillChildren(m: SearchModel, cov: Map<string, GeoCoverage>, geoId: string): GeoCoverage[] {
  return (m.geoChildren.get(geoId) ?? []).map((g) => cov.get(g.id)).filter((c): c is GeoCoverage => !!c).sort((a, b) => b.planned - a.planned || a.geo.name.localeCompare(b.geo.name))
}

/* ── coverage gaps ──────────────────────────────────────────────────────── */

export type CoverageGap =
  | { kind: 'GEO_WITHOUT_PAGE'; id: string; propertyId: string; expectation: CoverageExpectation; geographyId: string; family: string }
  | { kind: 'DIMENSION_WITHOUT_PAGE'; id: string; propertyId: string; expectation: CoverageExpectation; parentPageId: string; value: { key: string; slug: string; label: string }; family: string }
  | { kind: 'OWNER_NOT_REGISTERED'; id: string; propertyId: string; clusterId: string; ownerRef: string }

export function coverageGaps(m: SearchModel, propertyId: string | null): CoverageGap[] {
  const out: CoverageGap[] = []
  const props = propertyId ? [m.property.get(propertyId)].filter((p) => !!p) : m.dataset.properties
  for (const prop of props) {
    if (!prop) continue
    const pages = m.pagesOf.get(prop.id) ?? []
    for (const x of prop.expectations) {
      if (x.kind === 'geo-family') {
        for (const gid of x.geographyIds) {
          const has = pages.some((p) => p.family === x.family && p.geographyIds.includes(gid))
          if (!has) out.push({ kind: 'GEO_WITHOUT_PAGE', id: `${x.id}:${gid}`, propertyId: prop.id, expectation: x, geographyId: gid, family: x.family })
        }
      } else {
        for (const parent of pages.filter((p) => p.family === x.parentFamily)) {
          const kids = (m.children.get(parent.id) ?? []).filter((c) => c.family === x.family)
          for (const v of x.values) {
            if (!kids.some((k) => k.path.endsWith(`/${v.slug}`))) out.push({ kind: 'DIMENSION_WITHOUT_PAGE', id: `${x.id}:${parent.id}:${v.key}`, propertyId: prop.id, expectation: x, parentPageId: parent.id, value: v, family: x.family })
          }
        }
      }
    }
    for (const c of m.clustersOf.get(prop.id) ?? []) {
      if (c.ownerRef && !canonicalOwner(m, c) && !(m.primaryPagesOf.get(c.id) ?? []).length && !c.ownerRef.includes('{')) {
        out.push({ kind: 'OWNER_NOT_REGISTERED', id: `gap:${c.id}`, propertyId: prop.id, clusterId: c.id, ownerRef: c.ownerRef })
      }
    }
  }
  return out
}

export function gapLabel(m: SearchModel, g: CoverageGap): string {
  if (g.kind === 'GEO_WITHOUT_PAGE') return `${m.geo.get(g.geographyId)?.name ?? g.geographyId} — no ${g.family.replace(/-/g, ' ')} page`
  if (g.kind === 'DIMENSION_WITHOUT_PAGE') return `${m.page.get(g.parentPageId)?.path ?? g.parentPageId} — no “${g.value.label}” page`
  const c: KeywordCluster | undefined = m.cluster.get(g.clusterId)
  return `${g.ownerRef} — owner of “${c?.primaryKeyword ?? c?.label ?? g.clusterId}” is not registered`
}
