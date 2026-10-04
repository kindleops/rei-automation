/**
 * The canonical URL / page registry (§25).
 *
 * One registry per property distinguishes four facts that are easy to blur:
 *   PLANNED URL   — the plan names it
 *   BUILT ROUTE   — the site's code serves it
 *   PUBLISHED URL — the production domain serves it
 *   INDEXED URL   — a connected Search Console reports it indexed
 * Each is recorded separately; none is inferred from another.
 *
 * `validateRegistry` is the guard for programmatic scale: duplicate routes,
 * accidental aliases (case / trailing slash / index variants), alias
 * collisions, conflicting canonicals, missing parents and orphans.
 */
import type { SearchModel } from './model'
import type { RegistryStage, SearchPage } from './types'

export function registryStage(p: SearchPage): RegistryStage {
  if (p.stage.indexed === true) return 'INDEXED_URL'
  if (p.stage.published) return 'PUBLISHED_URL'
  if (p.stage.builtRoute) return 'BUILT_ROUTE'
  return 'PLANNED_URL'
}

export const STAGE_LABEL: Record<RegistryStage, string> = {
  PLANNED_URL: 'Planned URL',
  BUILT_ROUTE: 'Built route',
  PUBLISHED_URL: 'Published URL',
  INDEXED_URL: 'Indexed URL',
}

/** Normalise a path the way the registry compares them. */
export function normalizePath(path: string): string {
  let p = (path || '/').trim()
  p = p.replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0]
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

/** The comparison key that exposes accidental aliases. */
export function aliasKey(path: string): string {
  return normalizePath(path).toLowerCase().replace(/\/index(\.html?)?$/, '').replace(/\.html?$/, '') || '/'
}

export type RegistryIssueKind =
  | 'DUPLICATE_ROUTE'
  | 'ACCIDENTAL_ALIAS'
  | 'ALIAS_COLLISION'
  | 'CONFLICTING_CANONICAL'
  | 'MISSING_PARENT'
  | 'PARENT_CYCLE'
  | 'ORPHAN'

export interface RegistryIssue {
  kind: RegistryIssueKind
  propertyId: string
  pageIds: string[]
  detail: string
}

/**
 * Orphan rule: a page with a built route must be reachable — an inbound
 * internal link from another page, or sitewide navigation recorded by the
 * source audit. A planned-only page is reported when nothing (not even a
 * planned link or a parent) points at it.
 */
export function isOrphan(m: SearchModel, p: SearchPage): boolean {
  if (p.parentId === null && (p.path === '/' || p.family === 'site-anchor')) return false
  if (m.navTargets.has(p.id)) return false
  const inbound = (m.linksIn.get(p.id) ?? []).some((l) => l.fromPageId !== p.id)
  if (inbound) return false
  if (!p.stage.builtRoute) return !p.parentId
  return true
}

export function validateRegistry(m: SearchModel, pages: readonly SearchPage[]): RegistryIssue[] {
  const issues: RegistryIssue[] = []
  const byProperty = new Map<string, SearchPage[]>()
  for (const p of pages) {
    const a = byProperty.get(p.propertyId)
    if (a) a.push(p)
    else byProperty.set(p.propertyId, [p])
  }
  for (const [propertyId, list] of byProperty) {
    const exact = new Map<string, SearchPage[]>()
    const loose = new Map<string, SearchPage[]>()
    for (const p of list) {
      const e = normalizePath(p.path)
      ;(exact.get(e) ?? exact.set(e, []).get(e)!).push(p)
      const k = aliasKey(p.path)
      ;(loose.get(k) ?? loose.set(k, []).get(k)!).push(p)
    }
    for (const [path, ps] of exact) if (ps.length > 1) {
      issues.push({ kind: 'DUPLICATE_ROUTE', propertyId, pageIds: ps.map((p) => p.id), detail: `${ps.length} registry entries claim ${path}.` })
    }
    for (const [key, ps] of loose) {
      const distinct = new Set(ps.map((p) => normalizePath(p.path)))
      if (distinct.size > 1) issues.push({ kind: 'ACCIDENTAL_ALIAS', propertyId, pageIds: ps.map((p) => p.id), detail: `${[...distinct].join(' and ')} differ only by case or suffix (${key}).` })
    }
    // alias claims: an alias may not be another page's path, nor claimed twice
    const aliasOwner = new Map<string, SearchPage>()
    for (const p of list) for (const a of p.aliases) {
      const k = aliasKey(a)
      const asPage = loose.get(k)?.find((x) => x.id !== p.id)
      if (asPage) issues.push({ kind: 'ALIAS_COLLISION', propertyId, pageIds: [p.id, asPage.id], detail: `${a} redirects to ${p.path} but is also a registered page.` })
      const prev = aliasOwner.get(k)
      if (prev && prev.id !== p.id) issues.push({ kind: 'ALIAS_COLLISION', propertyId, pageIds: [prev.id, p.id], detail: `${a} is claimed as an alias by two pages.` })
      aliasOwner.set(k, p)
    }
    // canonicals: self, or a registered page whose own canonical is itself
    for (const p of list) {
      if (!p.canonical) continue
      const c = normalizePath(p.canonical)
      if (c === normalizePath(p.path)) continue
      const target = exact.get(c)?.[0]
      if (!target) issues.push({ kind: 'CONFLICTING_CANONICAL', propertyId, pageIds: [p.id], detail: `${p.path} canonicalises to ${c}, which is not in the registry.` })
      else if (target.canonical && normalizePath(target.canonical) !== c) issues.push({ kind: 'CONFLICTING_CANONICAL', propertyId, pageIds: [p.id, target.id], detail: `${p.path} → ${c} → ${normalizePath(target.canonical)} is a canonical chain.` })
      else if (p.indexability === 'INDEX') issues.push({ kind: 'CONFLICTING_CANONICAL', propertyId, pageIds: [p.id, target.id], detail: `${p.path} is set to index but canonicalises to ${c}.` })
    }
    for (const p of list) {
      if (p.parentId && !m.page.has(p.parentId)) issues.push({ kind: 'MISSING_PARENT', propertyId, pageIds: [p.id], detail: `${p.path} names a parent that is not registered.` })
    }
    // cycles
    for (const p of list) {
      const seen = new Set<string>()
      let cur: string | null = p.id
      while (cur) {
        if (seen.has(cur)) { issues.push({ kind: 'PARENT_CYCLE', propertyId, pageIds: [...seen], detail: `${p.path} is its own ancestor.` }); break }
        seen.add(cur)
        cur = m.page.get(cur)?.parentId ?? null
      }
    }
    // reachability is only judged where the source recorded links for this property
    const hasLinkData = list.some((p) => (m.linksOut.get(p.id)?.length ?? 0) > 0 || m.navTargets.has(p.id))
    for (const p of list) if (hasLinkData && isOrphan(m, p)) {
      issues.push({ kind: 'ORPHAN', propertyId, pageIds: [p.id], detail: p.stage.builtRoute ? `${p.path} is built but nothing links to it.` : `${p.path} is planned with no parent and no planned inbound link.` })
    }
  }
  return issues
}
