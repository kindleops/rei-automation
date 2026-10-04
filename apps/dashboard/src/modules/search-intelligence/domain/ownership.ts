/**
 * Keyword → page ownership (§9): one canonical owner page per meaningful
 * cluster, and mechanical detection of every way that breaks.
 *
 * Templated (geographic) clusters — "{state} real estate investing",
 * "wholesale real estate {market}" — are owned per geography: four metro
 * pages for four metros are one owner each, not four competitors. Two pages
 * for the SAME geography in a templated cluster are competitors.
 */
import type { SearchModel } from './model'
import { clustersIn, keywordsIn, pagesIn } from './model'
import type { KeywordCluster, SearchPage } from './types'

export type OwnershipConflictKind =
  | 'CLUSTER_WITHOUT_PAGE'
  | 'COMPETING_PAGES'
  | 'CONFLICTING_INTENT'
  | 'ORPHANED_KEYWORD'
  | 'PAGE_OVERREACH'
  | 'LINK_TO_WRONG_OWNER'
  | 'DUPLICATE_PAGE_IDENTITY'
  /** needs Search Console: a page receives impressions for a topic another page owns */
  | 'FOREIGN_TOPIC_IMPRESSIONS'

export interface OwnershipConflict {
  kind: OwnershipConflictKind
  propertyId: string
  clusterIds: string[]
  pageIds: string[]
  keywordIds: string[]
  /** the sentence the UI shows */
  message: string
}

export const OVERREACH_LIMIT = 3

export const isTemplated = (c: KeywordCluster) => /\{[a-z]+\}/.test(c.primaryKeyword ?? '') || c.geoLevel !== null

const geoKey = (p: SearchPage) => [...p.geographyIds].sort().join('|') || '∅'

/** The resolved canonical owner for a cluster (non-templated), or null. */
export function canonicalOwner(m: SearchModel, c: KeywordCluster): SearchPage | null {
  if (c.ownerPageId && m.page.has(c.ownerPageId)) return m.page.get(c.ownerPageId)!
  const primaries = m.primaryPagesOf.get(c.id) ?? []
  return primaries.length === 1 ? primaries[0] : null
}

/** Coarse intent families; two families on one page need opposite calls to action. */
export function intentFamily(intent: string | null | undefined): string | null {
  if (!intent) return null
  const i = intent.toLowerCase()
  if (/navigational/.test(i)) return 'navigational'
  if (/education|informational|guide|question|learn|help-center|resource/.test(i)) return 'informational'
  if (/transactional|conversion|marketplace|supply|demand|acquisition|direct-sale|we buy|sell my|cash-sale|capital|provider/.test(i)) return 'transactional'
  if (/commercial|comparative|category|investigation|trust|proof/.test(i)) return 'commercial'
  if (/local/.test(i)) return 'transactional'
  return null
}

export function ownershipConflicts(m: SearchModel, propertyId: string | null): OwnershipConflict[] {
  const out: OwnershipConflict[] = []
  const clusters = clustersIn(m, propertyId)
  const pages = pagesIn(m, propertyId)

  for (const c of clusters) {
    const primaries = m.primaryPagesOf.get(c.id) ?? []
    const owner = canonicalOwner(m, c)
    // 1 — no destination page
    if (!owner && primaries.length === 0) {
      out.push({
        kind: 'CLUSTER_WITHOUT_PAGE', propertyId: c.propertyId, clusterIds: [c.id], pageIds: [], keywordIds: (m.keywordsOfCluster.get(c.id) ?? []).map((k) => k.id),
        message: c.ownerRef ? `This keyword cluster has no destination page — the plan names “${c.ownerRef}”, which is not registered.` : 'This keyword cluster has no destination page.',
      })
    }
    // 2 — competing pages (per geography when templated)
    const groups = new Map<string, SearchPage[]>()
    for (const p of primaries) {
      const k = isTemplated(c) ? geoKey(p) : '*'
      ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(p)
    }
    for (const g of groups.values()) if (g.length > 1) {
      out.push({ kind: 'COMPETING_PAGES', propertyId: c.propertyId, clusterIds: [c.id], pageIds: g.map((p) => p.id), keywordIds: [], message: `${g.length} pages compete for this topic.` })
    }
    // owner named by the plan differs from the page that claims it as primary
    if (c.ownerPageId && primaries.length === 1 && primaries[0].id !== c.ownerPageId && m.page.has(c.ownerPageId) && !isTemplated(c)) {
      out.push({ kind: 'COMPETING_PAGES', propertyId: c.propertyId, clusterIds: [c.id], pageIds: [c.ownerPageId, primaries[0].id], keywordIds: [], message: `The plan names ${m.page.get(c.ownerPageId)!.path} as owner, but ${primaries[0].path} claims the cluster.` })
    }
  }

  // 3 — conflicting intents on one page; 5 — overreach
  for (const p of pages) {
    const owned = [p.primaryClusterId, ...p.secondaryClusterIds].filter((x): x is string => !!x).map((id) => m.cluster.get(id)).filter((x): x is KeywordCluster => !!x)
    // Learning and acting need opposite calls to action above the fold. Commercial and
    // transactional are one funnel; navigational is a placeholder for pages another lane owns.
    const fams = new Set<string>()
    for (const f of [intentFamily(p.intent), ...owned.map((c) => intentFamily(c.intent))]) if (f && f !== 'navigational') fams.add(f)
    if (owned.length > 0 && fams.has('informational') && (fams.has('transactional') || fams.has('commercial'))) {
      out.push({ kind: 'CONFLICTING_INTENT', propertyId: p.propertyId, clusterIds: owned.map((c) => c.id), pageIds: [p.id], keywordIds: [], message: `${p.path} is asked to serve informational and ${fams.has('transactional') ? 'transactional' : 'commercial'} intent.` })
    }
    if (owned.length > OVERREACH_LIMIT) {
      out.push({ kind: 'PAGE_OVERREACH', propertyId: p.propertyId, clusterIds: owned.map((c) => c.id), pageIds: [p.id], keywordIds: [], message: `${p.path} targets ${owned.length} clusters (limit ${OVERREACH_LIMIT}).` })
    }
  }

  // 4 — orphaned planned keywords: no cluster, or nowhere to land
  for (const k of keywordsIn(m, propertyId)) {
    const c = k.clusterId ? m.cluster.get(k.clusterId) : null
    // a keyword a page owns directly (no cluster) is page-owned, not orphaned
    if (!c && !(k.assignedPageId && m.page.has(k.assignedPageId))) out.push({ kind: 'ORPHANED_KEYWORD', propertyId: k.propertyId, clusterIds: [], pageIds: [], keywordIds: [k.id], message: `“${k.query}” belongs to no cluster and no page.` })
    else if (!c) continue
    else if (!k.assignedPageId && !canonicalOwner(m, c) && !(m.primaryPagesOf.get(c.id) ?? []).length) {
      // reported once per cluster under CLUSTER_WITHOUT_PAGE; a keyword with an explicit, unregistered target is its own orphan
    } else if (k.assignedPageId && !m.page.has(k.assignedPageId)) {
      out.push({ kind: 'ORPHANED_KEYWORD', propertyId: k.propertyId, clusterIds: [c.id], pageIds: [], keywordIds: [k.id], message: `“${k.query}” is assigned to a page that is not registered.` })
    }
  }

  // 6 — internal links whose anchor speaks to a cluster but point away from its owner
  for (const p of pages) for (const l of m.linksOut.get(p.id) ?? []) {
    if (!l.anchorClusterId) continue
    const c = m.cluster.get(l.anchorClusterId)
    if (!c || isTemplated(c)) continue
    const owner = canonicalOwner(m, c)
    if (owner && owner.id !== l.toPageId) {
      const to = m.page.get(l.toPageId)
      out.push({ kind: 'LINK_TO_WRONG_OWNER', propertyId: p.propertyId, clusterIds: [c.id], pageIds: [p.id, l.toPageId, owner.id], keywordIds: [], message: `${p.path} links “${c.primaryKeyword ?? c.label}” to ${to?.path ?? l.toPageId}; the owner is ${owner.path}.` })
    }
  }

  // identical titles or H1s on two pages of one property = two pages presenting as the same answer
  const titleMap = new Map<string, SearchPage[]>()
  for (const p of pages) {
    for (const t of [p.copy.title, p.copy.h1]) {
      if (!t) continue
      const key = `${p.propertyId}::${t.trim().toLowerCase()}`
      const a = titleMap.get(key) ?? titleMap.set(key, []).get(key)!
      if (!a.includes(p)) a.push(p)
    }
  }
  const reported = new Set<string>()
  for (const [key, ps] of titleMap) if (ps.length > 1) {
    const sig = ps.map((p) => p.id).sort().join('|')
    if (reported.has(sig)) continue
    reported.add(sig)
    out.push({ kind: 'DUPLICATE_PAGE_IDENTITY', propertyId: ps[0].propertyId, clusterIds: [], pageIds: ps.map((p) => p.id), keywordIds: [], message: `${ps.length} pages share the title or H1 “${key.split('::')[1]}”.` })
  }

  // 7 — FOREIGN_TOPIC_IMPRESSIONS needs query × page facts from Search Console; none exist (MeasureStore is empty) → nothing emitted.
  return out
}

export interface OwnershipRow {
  cluster: KeywordCluster
  owner: SearchPage | null
  primaries: SearchPage[]
  supporting: SearchPage[]
  keywords: number
  state: 'OWNED' | 'CONTESTED' | 'UNOWNED' | 'TEMPLATED'
}

export function ownershipTable(m: SearchModel, propertyId: string | null): OwnershipRow[] {
  return clustersIn(m, propertyId).map((c) => {
    const primaries = m.primaryPagesOf.get(c.id) ?? []
    const owner = canonicalOwner(m, c)
    const templated = isTemplated(c)
    const contested = templated
      ? (() => { const s = new Set<string>(); for (const p of primaries) { const k = geoKey(p); if (s.has(k)) return true; s.add(k) } return false })()
      : primaries.length > 1
    return {
      cluster: c, owner, primaries, supporting: m.supportPagesOf.get(c.id) ?? [], keywords: (m.keywordsOfCluster.get(c.id) ?? []).length,
      state: contested ? 'CONTESTED' : templated && primaries.length ? 'TEMPLATED' : owner || primaries.length ? 'OWNED' : 'UNOWNED',
    }
  })
}
