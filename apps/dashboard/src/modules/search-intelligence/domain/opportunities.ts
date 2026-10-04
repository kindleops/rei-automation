/**
 * The Opportunities engine (§21) — deterministic rules, each with its reason.
 *
 * PRE_LAUNCH rules read the plan. LIVE rules read provider facts; with no
 * provider connected the MeasureStore is empty and they emit nothing — the
 * catalog still lists them, marked "waiting for Search Console", so the
 * operator can see what will run. No rule infers, predicts or estimates.
 */
import type { SearchModel } from './model'
import { pagesIn, wavesIn } from './model'
import { ownershipConflicts, type OwnershipConflictKind } from './ownership'
import { coverageGaps, gapLabel } from './geography'
import { validateRegistry } from './registry'
import type { KeywordMeasures, Opportunity, PageMeasures, RulePhase, SearchPage, Severity } from './types'

export interface RuleDef {
  id: string
  phase: RulePhase
  title: string
  /** what the rule checks, in one sentence */
  why: string
  /** provider facts the rule needs; empty for plan-only rules */
  needs: ReadonlyArray<'SEARCH_CONSOLE' | 'ANALYTICS' | 'LEADCOMMAND'>
}

export const RULES: readonly RuleDef[] = [
  { id: 'cluster-without-page', phase: 'PRE_LAUNCH', title: 'Cluster with no destination page', why: 'A planned keyword cluster must have one canonical owner page. If no page exists, the demand has nowhere to land.', needs: [] },
  { id: 'competing-pages', phase: 'PRE_LAUNCH', title: 'Pages competing for one cluster', why: 'Two pages that target the same cluster (for the same place) split their own signals. One must own it.', needs: [] },
  { id: 'duplicate-identity', phase: 'PRE_LAUNCH', title: 'Pages presenting as the same answer', why: 'Identical titles or H1s on two URLs of one property ask the engine to pick between them.', needs: [] },
  { id: 'conflicting-intent', phase: 'PRE_LAUNCH', title: 'Conflicting intents on one page', why: 'Learning and acting need opposite calls to action above the fold.', needs: [] },
  { id: 'page-overreach', phase: 'PRE_LAUNCH', title: 'Page targets too many clusters', why: 'A page asked to rank for many unrelated clusters ranks for none of them well.', needs: [] },
  { id: 'wrong-owner-link', phase: 'PRE_LAUNCH', title: 'Internal link points to the wrong owner', why: 'The anchor text names a cluster, but the link goes to a page that does not own it.', needs: [] },
  { id: 'orphaned-keyword', phase: 'PRE_LAUNCH', title: 'Orphaned planned keyword', why: 'A planned keyword that is in no cluster, or assigned to an unregistered page, cannot be owned.', needs: [] },
  { id: 'incomplete-geography', phase: 'PRE_LAUNCH', title: 'Incomplete geography', why: 'The plan names this place (for example, an operating state), but no page of the expected family covers it.', needs: [] },
  { id: 'coverage-dimension', phase: 'PRE_LAUNCH', title: 'Defined dimension not covered', why: 'The plan defines this dimension value (for example, a seller situation), but this branch has no page for it. This is coverage, not an instruction to build.', needs: [] },
  { id: 'orphan-page', phase: 'PRE_LAUNCH', title: 'Orphan page', why: 'A built page with no inbound internal link or navigation path cannot be discovered by crawling.', needs: [] },
  { id: 'missing-internal-links', phase: 'PRE_LAUNCH', title: 'Missing internal links', why: 'A built page has fewer than two distinct contextual inbound links. That is weak discovery and weak topical support.', needs: [] },
  { id: 'missing-metadata', phase: 'PRE_LAUNCH', title: 'Missing metadata', why: 'A built route has no title, H1 or meta description in its source registry.', needs: [] },
  { id: 'copy-not-approved', phase: 'PRE_LAUNCH', title: 'Launch-ready page without approved copy', why: 'The page passes its build gates, but no owner approval of its copy is recorded.', needs: [] },
  { id: 'wave-not-ready', phase: 'PRE_LAUNCH', title: 'Launch wave not ready', why: 'Some pages assigned to this wave are not READY yet.', needs: [] },
  { id: 'registry-integrity', phase: 'PRE_LAUNCH', title: 'Registry integrity', why: 'A duplicate route, an accidental alias, a conflicting canonical or a missing parent breaks the one-URL-per-page rule.', needs: [] },
  { id: 'striking-distance', phase: 'LIVE', title: 'Striking distance (position 5–20)', why: 'The query already ranks on page one or two with real impressions. Small improvements move clicks.', needs: ['SEARCH_CONSOLE'] },
  { id: 'low-ctr', phase: 'LIVE', title: 'High impressions, low CTR', why: 'The page is seen but not chosen. The title or snippet is the lever.', needs: ['SEARCH_CONSOLE'] },
  { id: 'ranking-loss', phase: 'LIVE', title: 'Ranking loss', why: 'Average position worsened between two reported windows.', needs: ['SEARCH_CONSOLE'] },
  { id: 'fast-gainer', phase: 'LIVE', title: 'Fast gainer', why: 'Average position improved sharply between two reported windows.', needs: ['SEARCH_CONSOLE'] },
  { id: 'no-ideal-landing', phase: 'LIVE', title: 'Keyword with no ideal landing page', why: 'The query earns impressions on a page that does not own its cluster.', needs: ['SEARCH_CONSOLE'] },
  { id: 'cannibalization', phase: 'LIVE', title: 'Cannibalization', why: 'Two or more pages earn impressions for the same query.', needs: ['SEARCH_CONSOLE'] },
  { id: 'internal-link-opportunity', phase: 'LIVE', title: 'Internal-link opportunity', why: 'A page that earns impressions does not link to the owner of a cluster it ranks for.', needs: ['SEARCH_CONSOLE'] },
  { id: 'declining-page', phase: 'LIVE', title: 'Declining page', why: 'Clicks fell across consecutive reported windows.', needs: ['SEARCH_CONSOLE'] },
]

export const RULE = new Map(RULES.map((r) => [r.id, r]))

const CONFLICT_RULE: Record<OwnershipConflictKind, { rule: string; severity: Severity }> = {
  CLUSTER_WITHOUT_PAGE: { rule: 'cluster-without-page', severity: 'HIGH' },
  COMPETING_PAGES: { rule: 'competing-pages', severity: 'HIGH' },
  DUPLICATE_PAGE_IDENTITY: { rule: 'duplicate-identity', severity: 'HIGH' },
  CONFLICTING_INTENT: { rule: 'conflicting-intent', severity: 'MEDIUM' },
  PAGE_OVERREACH: { rule: 'page-overreach', severity: 'MEDIUM' },
  LINK_TO_WRONG_OWNER: { rule: 'wrong-owner-link', severity: 'MEDIUM' },
  ORPHANED_KEYWORD: { rule: 'orphaned-keyword', severity: 'LOW' },
  FOREIGN_TOPIC_IMPRESSIONS: { rule: 'no-ideal-landing', severity: 'HIGH' },
}

const mk = (o: Omit<Opportunity, 'why'> & { why?: string }): Opportunity => ({ ...o, why: o.why ?? RULE.get(o.ruleId)?.why ?? '' })

/** Inputs a live rule reads. Empty in V1 by construction. */
export interface LiveFacts {
  page: ReadonlyMap<string, PageMeasures & { previousClicks?: number | null }>
  keyword: ReadonlyMap<string, KeywordMeasures>
  /** query × page facts, the grain cannibalisation needs */
  queryPage: ReadonlyArray<{ keywordId: string; pageId: string; impressions: number; clicks: number; position: number | null; through: string }>
}

export const STRIKING = { minPosition: 5, maxPosition: 20, minImpressions: 100 }
export const LOW_CTR = { minImpressions: 500, maxCtr: 0.01 }
export const MOVE = { positions: 3 }

export function liveOpportunities(m: SearchModel, facts: LiveFacts, propertyId: string | null): Opportunity[] {
  const out: Opportunity[] = []
  const inScope = (pid: string) => !propertyId || pid === propertyId
  for (const [kid, f] of facts.keyword) {
    const k = m.keyword.get(kid)
    if (!k || !inScope(k.propertyId) || f.provider !== 'SEARCH_CONSOLE') continue
    const ev = [{ label: 'Impressions', value: String(f.impressions) }, { label: 'Clicks', value: String(f.clicks) }, { label: 'Avg position', value: f.position == null ? '—' : f.position.toFixed(1) }, { label: 'Data through', value: f.through }]
    if (f.position != null && f.position >= STRIKING.minPosition && f.position <= STRIKING.maxPosition && f.impressions >= STRIKING.minImpressions) {
      out.push(mk({ id: `striking-distance:${kid}`, ruleId: 'striking-distance', propertyId: k.propertyId, phase: 'LIVE', severity: 'MEDIUM', title: `“${k.query}” is in striking distance`, evidence: ev, subject: { kind: 'keyword', id: kid }, related: k.assignedPageId ? [{ kind: 'page', id: k.assignedPageId }] : [] }))
    }
    if (f.impressions >= LOW_CTR.minImpressions && f.impressions > 0 && f.clicks / f.impressions < LOW_CTR.maxCtr) {
      out.push(mk({ id: `low-ctr:${kid}`, ruleId: 'low-ctr', propertyId: k.propertyId, phase: 'LIVE', severity: 'MEDIUM', title: `“${k.query}” is seen but rarely chosen`, evidence: [...ev, { label: 'CTR', value: `${((f.clicks / f.impressions) * 100).toFixed(2)}%` }], subject: { kind: 'keyword', id: kid }, related: [] }))
    }
    if (f.position != null && f.previousPosition != null) {
      const d = f.position - f.previousPosition
      if (d >= MOVE.positions) out.push(mk({ id: `ranking-loss:${kid}`, ruleId: 'ranking-loss', propertyId: k.propertyId, phase: 'LIVE', severity: 'HIGH', title: `“${k.query}” lost ${d.toFixed(1)} positions`, evidence: [...ev, { label: 'Previous position', value: f.previousPosition.toFixed(1) }], subject: { kind: 'keyword', id: kid }, related: [] }))
      if (d <= -MOVE.positions) out.push(mk({ id: `fast-gainer:${kid}`, ruleId: 'fast-gainer', propertyId: k.propertyId, phase: 'LIVE', severity: 'LOW', title: `“${k.query}” gained ${(-d).toFixed(1)} positions`, evidence: [...ev, { label: 'Previous position', value: f.previousPosition.toFixed(1) }], subject: { kind: 'keyword', id: kid }, related: [] }))
    }
  }
  // query × page grain
  const byKeyword = new Map<string, LiveFacts['queryPage'][number][]>()
  for (const r of facts.queryPage) (byKeyword.get(r.keywordId) ?? byKeyword.set(r.keywordId, []).get(r.keywordId)!).push(r)
  for (const [kid, rows] of byKeyword) {
    const k = m.keyword.get(kid)
    if (!k || !inScope(k.propertyId)) continue
    const earning = rows.filter((r) => r.impressions > 0)
    if (earning.length > 1) out.push(mk({ id: `cannibalization:${kid}`, ruleId: 'cannibalization', propertyId: k.propertyId, phase: 'LIVE', severity: 'HIGH', title: `${earning.length} pages earn impressions for “${k.query}”`, evidence: earning.map((r) => ({ label: m.page.get(r.pageId)?.path ?? r.pageId, value: `${r.impressions} impr` })), subject: { kind: 'keyword', id: kid }, related: earning.map((r) => ({ kind: 'page' as const, id: r.pageId })) }))
    const c = k.clusterId ? m.cluster.get(k.clusterId) : null
    const owner = c?.ownerPageId ?? null
    for (const r of earning) if (owner && r.pageId !== owner) {
      out.push(mk({ id: `no-ideal-landing:${kid}:${r.pageId}`, ruleId: 'no-ideal-landing', propertyId: k.propertyId, phase: 'LIVE', severity: 'MEDIUM', title: `This page receives impressions for a topic owned by another page`, evidence: [{ label: 'Query', value: k.query }, { label: 'Page', value: m.page.get(r.pageId)?.path ?? r.pageId }, { label: 'Owner', value: m.page.get(owner)?.path ?? owner }, { label: 'Impressions', value: String(r.impressions) }], subject: { kind: 'page', id: r.pageId }, related: [{ kind: 'page', id: owner }, { kind: 'keyword', id: kid }] }))
      const linksToOwner = (m.linksOut.get(r.pageId) ?? []).some((l) => l.toPageId === owner)
      if (!linksToOwner) out.push(mk({ id: `internal-link-opportunity:${r.pageId}:${owner}`, ruleId: 'internal-link-opportunity', propertyId: k.propertyId, phase: 'LIVE', severity: 'LOW', title: `Link ${m.page.get(r.pageId)?.path ?? r.pageId} to the owner of “${k.query}”`, evidence: [{ label: 'Owner', value: m.page.get(owner)?.path ?? owner }], subject: { kind: 'page', id: r.pageId }, related: [{ kind: 'page', id: owner }] }))
    }
  }
  for (const [pid, f] of facts.page) {
    const p = m.page.get(pid)
    if (!p || !inScope(p.propertyId) || f.previousClicks == null) continue
    if (f.previousClicks > 0 && f.clicks < f.previousClicks * 0.7) {
      out.push(mk({ id: `declining-page:${pid}`, ruleId: 'declining-page', propertyId: p.propertyId, phase: 'LIVE', severity: 'MEDIUM', title: `${p.path} is declining`, evidence: [{ label: 'Clicks', value: String(f.clicks) }, { label: 'Previous window', value: String(f.previousClicks) }, { label: 'Data through', value: f.through }], subject: { kind: 'page', id: pid }, related: [] }))
    }
  }
  return out
}

export const EMPTY_LIVE: LiveFacts = { page: new Map(), keyword: new Map(), queryPage: [] }

const SEVERITY_RANK: Record<Severity, number> = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

export function preLaunchOpportunities(m: SearchModel, propertyId: string | null): Opportunity[] {
  const out: Opportunity[] = []
  const pages = pagesIn(m, propertyId) as SearchPage[]

  for (const c of ownershipConflicts(m, propertyId)) {
    const r = CONFLICT_RULE[c.kind]
    const subject = c.clusterIds[0] && c.kind !== 'DUPLICATE_PAGE_IDENTITY' && c.kind !== 'CONFLICTING_INTENT' && c.kind !== 'PAGE_OVERREACH'
      ? { kind: 'cluster' as const, id: c.clusterIds[0] }
      : c.pageIds[0] ? { kind: 'page' as const, id: c.pageIds[0] } : c.keywordIds[0] ? { kind: 'keyword' as const, id: c.keywordIds[0] } : { kind: 'property' as const, id: c.propertyId }
    const cluster = c.clusterIds[0] ? m.cluster.get(c.clusterIds[0]) : null
    const wave = cluster?.wave ? m.wave.get(cluster.wave) : null
    const severity: Severity = c.kind === 'CLUSTER_WITHOUT_PAGE' && cluster && !cluster.primaryKeyword ? 'LOW' : r.severity
    out.push(mk({
      id: `${r.rule}:${[...c.clusterIds, ...c.pageIds, ...c.keywordIds].join('+')}`, ruleId: r.rule, propertyId: c.propertyId, phase: 'PRE_LAUNCH', severity,
      title: c.message,
      evidence: [
        ...(cluster ? [{ label: 'Cluster', value: cluster.primaryKeyword ?? cluster.label }] : []),
        ...c.pageIds.slice(0, 4).map((id) => ({ label: 'Page', value: m.page.get(id)?.path ?? id })),
        ...(wave ? [{ label: 'Wave', value: wave.label }] : []),
        ...(cluster ? [{ label: 'Source', value: cluster.provenance.label }] : []),
      ],
      subject, related: [...c.pageIds.map((id) => ({ kind: 'page' as const, id })), ...c.clusterIds.slice(1).map((id) => ({ kind: 'cluster' as const, id }))],
    }))
  }

  // one opportunity per (property, expectation): the geography list is the evidence, the map shows each place
  const geoGaps: Array<Extract<ReturnType<typeof coverageGaps>[number], { kind: 'GEO_WITHOUT_PAGE' }>> = []
  for (const g of coverageGaps(m, propertyId)) {
    if (g.kind === 'OWNER_NOT_REGISTERED') continue // reported as cluster-without-page
    const label = gapLabel(m, g)
    if (g.kind === 'GEO_WITHOUT_PAGE') {
      geoGaps.push(g)
    } else {
      out.push(mk({
        id: `coverage-dimension:${g.id}`, ruleId: 'coverage-dimension', propertyId: g.propertyId, phase: 'PRE_LAUNCH', severity: 'LOW', title: label,
        evidence: [{ label: 'Dimension', value: g.expectation.label }, { label: 'Value', value: g.value.label }, { label: 'Source', value: g.expectation.source.label }],
        subject: { kind: 'page', id: g.parentPageId }, related: [],
      }))
    }
  }

  const byExpectation = new Map<string, typeof geoGaps>()
  for (const g of geoGaps) (byExpectation.get(g.expectation.id) ?? byExpectation.set(g.expectation.id, []).get(g.expectation.id)!).push(g)
  for (const [xid, gs] of byExpectation) {
    const x = gs[0].expectation
    const total = x.kind === 'geo-family' ? x.geographyIds.length : gs.length
    const names = gs.map((g) => m.geo.get(g.geographyId)?.name ?? g.geographyId)
    const legacyHere = gs.reduce((n, g) => n + ((m.pagesAtGeo.get(g.geographyId) ?? []).some((p) => p.propertyId === g.propertyId) ? 1 : 0), 0)
    out.push(mk({
      id: `incomplete-geography:${xid}`, ruleId: 'incomplete-geography', propertyId: gs[0].propertyId, phase: 'PRE_LAUNCH', severity: 'MEDIUM',
      title: `${gs.length} of ${total} places have no ${gs[0].family.replace(/-/g, ' ')} page`,
      evidence: [
        { label: 'Expectation', value: x.label }, { label: 'Source', value: x.source.label },
        { label: 'Places', value: names.slice(0, 12).join(', ') + (names.length > 12 ? ` +${names.length - 12}` : '') },
        ...(legacyHere ? [{ label: 'Covered by another family', value: `${legacyHere} of these have an older page in another family` }] : []),
      ],
      subject: { kind: 'property', id: gs[0].propertyId }, related: gs.map((g) => ({ kind: 'geography' as const, id: g.geographyId })),
    }))
  }

  for (const iss of validateRegistry(m, pages)) {
    if (iss.kind === 'ORPHAN') {
      const p = m.page.get(iss.pageIds[0])!
      out.push(mk({ id: `orphan-page:${p.id}`, ruleId: 'orphan-page', propertyId: p.propertyId, phase: 'PRE_LAUNCH', severity: p.stage.builtRoute ? 'HIGH' : 'LOW', title: iss.detail, evidence: [{ label: 'Status', value: p.status }, { label: 'Inbound links', value: String((m.linksIn.get(p.id) ?? []).length) }], subject: { kind: 'page', id: p.id }, related: [] }))
    } else {
      out.push(mk({ id: `registry-integrity:${iss.kind}:${iss.pageIds.join('+')}`, ruleId: 'registry-integrity', propertyId: iss.propertyId, phase: 'PRE_LAUNCH', severity: iss.kind === 'DUPLICATE_ROUTE' || iss.kind === 'PARENT_CYCLE' ? 'BLOCKER' : 'HIGH', title: iss.detail, evidence: [{ label: 'Check', value: iss.kind.replace(/_/g, ' ').toLowerCase() }], subject: { kind: 'page', id: iss.pageIds[0] }, related: iss.pageIds.slice(1).map((id) => ({ kind: 'page' as const, id })) }))
    }
  }

  // contextual-link coverage is only judged where the source recorded a content-link audit
  const audited = new Set<string>()
  for (const l of m.dataset.links) if (l.kind === 'content') { const pid = m.page.get(l.fromPageId)?.propertyId; if (pid) audited.add(pid) }
  const weakHeld = new Map<string, SearchPage[]>()
  const unapproved = new Map<string, SearchPage[]>()
  for (const p of pages) {
    if (!p.stage.builtRoute) continue
    const contextual = new Set((m.linksIn.get(p.id) ?? []).filter((l) => l.kind === 'content').map((l) => l.fromPageId))
    contextual.delete(p.id)
    if (audited.has(p.propertyId) && contextual.size < 2 && p.path !== '/') {
      if (p.status === 'READY') {
        out.push(mk({ id: `missing-internal-links:${p.id}`, ruleId: 'missing-internal-links', propertyId: p.propertyId, phase: 'PRE_LAUNCH', severity: 'MEDIUM', title: `${p.path} has ${contextual.size} contextual inbound link${contextual.size === 1 ? '' : 's'}`, evidence: [{ label: 'Distinct contextual sources', value: String(contextual.size) }, { label: 'Status', value: p.status }], subject: { kind: 'page', id: p.id }, related: [...contextual].map((id) => ({ kind: 'page' as const, id })) }))
      } else (weakHeld.get(p.propertyId) ?? weakHeld.set(p.propertyId, []).get(p.propertyId)!).push(p)
    }
    const missing = [!p.copy.title && 'title', !p.copy.h1 && 'H1', !p.copy.meta && 'meta description'].filter(Boolean) as string[]
    if (missing.length) {
      out.push(mk({ id: `missing-metadata:${p.id}`, ruleId: 'missing-metadata', propertyId: p.propertyId, phase: 'PRE_LAUNCH', severity: 'MEDIUM', title: `${p.path} has no ${missing.join(', ')} in its source registry`, evidence: [{ label: 'Missing', value: missing.join(', ') }, { label: 'Copy', value: 'Not approved' }], subject: { kind: 'page', id: p.id }, related: [] }))
    }
    if ((p.status === 'READY' || p.status === 'QA') && p.copy.state !== 'APPROVED') (unapproved.get(p.propertyId) ?? unapproved.set(p.propertyId, []).get(p.propertyId)!).push(p)
  }
  for (const [pid, ps] of weakHeld) {
    out.push(mk({ id: `missing-internal-links:held:${pid}`, ruleId: 'missing-internal-links', propertyId: pid, phase: 'PRE_LAUNCH', severity: 'LOW', title: `${ps.length} held pages have fewer than two contextual inbound links`, evidence: [{ label: 'Pages', value: String(ps.length) }, { label: 'Examples', value: ps.slice(0, 4).map((p) => p.path).join(', ') }], subject: { kind: 'property', id: pid }, related: ps.map((p) => ({ kind: 'page' as const, id: p.id })) }))
  }
  for (const [pid, ps] of unapproved) {
    const ready = ps.filter((p) => p.status === 'READY').length
    out.push(mk({
      id: `copy-not-approved:${pid}`, ruleId: 'copy-not-approved', propertyId: pid, phase: 'PRE_LAUNCH', severity: ready ? 'BLOCKER' : 'MEDIUM',
      title: `${ps.length} launch-track pages have no recorded copy approval`,
      evidence: [{ label: 'READY', value: String(ready) }, { label: 'QA', value: String(ps.length - ready) }, { label: 'Copy', value: 'Copy is in the source repository, with no approval recorded' }, { label: 'Source', value: ps[0].source.label }],
      subject: { kind: 'property', id: pid }, related: ps.map((p) => ({ kind: 'page' as const, id: p.id })),
    }))
  }

  for (const w of wavesIn(m, propertyId)) {
    const wp = pages.filter((p) => p.launchWaveId === w.id)
    const notReady = wp.filter((p) => !['READY', 'PUBLISHED', 'INDEXED'].includes(p.status))
    if (wp.length && notReady.length) {
      const by = new Map<string, number>()
      for (const p of notReady) by.set(p.status, (by.get(p.status) ?? 0) + 1)
      out.push(mk({ id: `wave-not-ready:${w.id}`, ruleId: 'wave-not-ready', propertyId: w.propertyId, phase: 'PRE_LAUNCH', severity: 'HIGH', title: `${w.label}: ${notReady.length} of ${wp.length} pages not launch-ready`, evidence: [...[...by.entries()].map(([s, n]) => ({ label: s.replace(/_/g, ' '), value: String(n) })), ...w.blockers.slice(0, 2).map((b) => ({ label: 'Named blocker', value: b }))], subject: { kind: 'wave', id: w.id }, related: [] }))
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.ruleId.localeCompare(b.ruleId) || a.title.localeCompare(b.title))
}

export function allOpportunities(m: SearchModel, propertyId: string | null, live: LiveFacts = EMPTY_LIVE): Opportunity[] {
  return [...preLaunchOpportunities(m, propertyId), ...liveOpportunities(m, live, propertyId)]
}
