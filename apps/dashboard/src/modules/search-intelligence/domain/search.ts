/**
 * Command search over every Search Intelligence object (§28): pages (path,
 * title), clusters, keywords, geographies, launch waves, properties and
 * opportunities. In-memory, scored, capped — no network.
 */
import type { SearchModel } from './model'
import type { ObjectRef, Opportunity } from './types'

export interface SearchHit {
  ref: ObjectRef
  label: string
  detail: string
  propertyId: string | null
  score: number
}

interface Entry { ref: ObjectRef; label: string; detail: string; propertyId: string | null; hay: string }

export function buildSearchIndex(m: SearchModel, opportunities: readonly Opportunity[]): Entry[] {
  const e: Entry[] = []
  for (const p of m.dataset.properties) e.push({ ref: { kind: 'property', id: p.id }, label: p.brand, detail: p.domain, propertyId: p.id, hay: `${p.brand} ${p.domain}`.toLowerCase() })
  for (const p of m.dataset.pages) e.push({ ref: { kind: 'page', id: p.id }, label: p.path, detail: p.copy.title ?? p.family, propertyId: p.propertyId, hay: `${p.path} ${p.copy.title ?? ''} ${p.copy.h1 ?? ''} ${p.family}`.toLowerCase() })
  for (const c of m.dataset.clusters) e.push({ ref: { kind: 'cluster', id: c.id }, label: c.primaryKeyword ?? c.label, detail: `Cluster · ${c.label}`, propertyId: c.propertyId, hay: `${c.primaryKeyword ?? ''} ${c.label} ${c.parentTopic ?? ''}`.toLowerCase() })
  for (const k of m.dataset.keywords) e.push({ ref: { kind: 'keyword', id: k.id }, label: k.query, detail: 'Keyword', propertyId: k.propertyId, hay: k.query.toLowerCase() })
  for (const g of m.dataset.geographies) e.push({ ref: { kind: 'geography', id: g.id }, label: g.stateCode && g.kind !== 'STATE' ? `${g.name}, ${g.stateCode}` : g.name, detail: g.kind.toLowerCase(), propertyId: null, hay: `${g.name} ${g.code ?? ''} ${g.stateCode ?? ''}`.toLowerCase() })
  for (const w of m.dataset.waves) e.push({ ref: { kind: 'wave', id: w.id }, label: w.label, detail: 'Launch wave', propertyId: w.propertyId, hay: w.label.toLowerCase() })
  for (const o of opportunities) e.push({ ref: { kind: 'opportunity', id: o.id }, label: o.title, detail: 'Opportunity', propertyId: o.propertyId, hay: o.title.toLowerCase() })
  return e
}

const KIND_WEIGHT: Record<ObjectRef['kind'], number> = { property: 6, wave: 4, cluster: 4, geography: 3, page: 3, keyword: 2, opportunity: 1 }

export function searchObjects(index: readonly Entry[], query: string, scope: string | null, limit = 24): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const hits: SearchHit[] = []
  for (const e of index) {
    if (scope && e.propertyId && e.propertyId !== scope) continue
    let score = 0
    let all = true
    for (const t of terms) {
      const i = e.hay.indexOf(t)
      if (i < 0) { all = false; break }
      score += i === 0 ? 6 : e.hay[i - 1] === ' ' || e.hay[i - 1] === '/' || e.hay[i - 1] === '-' ? 4 : 1
    }
    if (!all) continue
    if (e.label.toLowerCase() === q) score += 10
    score += KIND_WEIGHT[e.ref.kind] - e.label.length / 200
    hits.push({ ref: e.ref, label: e.label, detail: e.detail, propertyId: e.propertyId, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
