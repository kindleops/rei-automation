/**
 * Intelligence Brief (§22) and the portfolio summary (§5).
 *
 * The pre-launch brief is computed from the plan. The post-launch sections
 * are declared now and render their unavailable reason until a provider
 * reports — they are never filled with placeholders.
 */
import type { SearchModel } from './model'
import { clustersIn, pagesIn, wavesIn } from './model'
import { connectionOf, searchMeasureGate, analyticsMeasureGate, type UnavailableReason } from './metrics'
import { intelligenceMode } from './lifecycle'
import { ownershipTable } from './ownership'
import { coverageGaps } from './geography'
import { registryStage } from './registry'
import type { ConnectionState, IntelligenceMode, LaunchWave, Opportunity, PageStatus, ProviderId, RegistryStage, SearchProperty } from './types'
import { PAGE_STATUS, REGISTRY_STAGE } from './types'

export const COMPLETE_STATUSES: ReadonlySet<PageStatus> = new Set(['READY', 'PUBLISHED', 'INDEXED'])
export const BLOCKED_STATUSES: ReadonlySet<PageStatus> = new Set(['NEEDS_WORK'])

export interface WaveReadiness {
  wave: LaunchWave
  pages: number
  ready: number
  byStatus: Record<PageStatus, number>
  /** the plan's own blockers plus derived ones */
  blockers: string[]
}

export function waveReadiness(m: SearchModel, w: LaunchWave): WaveReadiness {
  const pages = (m.pagesOf.get(w.propertyId) ?? []).filter((p) => p.launchWaveId === w.id)
  const byStatus = Object.fromEntries(PAGE_STATUS.map((s) => [s, 0])) as Record<PageStatus, number>
  for (const p of pages) byStatus[p.status] += 1
  const ready = pages.filter((p) => COMPLETE_STATUSES.has(p.status)).length
  const unmetDeps = w.dependsOn.map((id) => m.wave.get(id)).filter((d) => d && d.status !== 'LAUNCHED').map((d) => `Depends on ${d!.label}`)
  return { wave: w, pages: pages.length, ready, byStatus, blockers: [...w.blockers, ...unmetDeps] }
}

/** The next wave to launch: lowest order that has not launched. */
export function nextWave(m: SearchModel, propertyId: string | null): LaunchWave | null {
  const ws = [...wavesIn(m, propertyId)].filter((w) => w.status !== 'LAUNCHED').sort((a, b) => a.order - b.order || a.propertyId.localeCompare(b.propertyId))
  return ws[0] ?? null
}

export interface PreLaunchBrief {
  pagesTotal: number
  pagesCompleted: number
  pagesBlocked: number
  byStatus: Record<PageStatus, number>
  byStage: Record<RegistryStage, number>
  clustersTotal: number
  clustersWithoutPages: number
  largestGaps: Opportunity[]
  nextWave: WaveReadiness | null
  coverageGaps: number
}

export function preLaunchBrief(m: SearchModel, propertyId: string | null, opportunities: readonly Opportunity[]): PreLaunchBrief {
  const pages = pagesIn(m, propertyId)
  const byStatus = Object.fromEntries(PAGE_STATUS.map((s) => [s, 0])) as Record<PageStatus, number>
  const byStage = Object.fromEntries(REGISTRY_STAGE.map((s) => [s, 0])) as Record<RegistryStage, number>
  for (const p of pages) { byStatus[p.status] += 1; byStage[registryStage(p)] += 1 }
  const own = ownershipTable(m, propertyId)
  const nw = nextWave(m, propertyId)
  const gapRules = new Set(['cluster-without-page', 'incomplete-geography', 'competing-pages', 'duplicate-identity', 'wave-not-ready', 'registry-integrity'])
  return {
    pagesTotal: pages.length,
    pagesCompleted: pages.filter((p) => COMPLETE_STATUSES.has(p.status)).length,
    pagesBlocked: pages.filter((p) => BLOCKED_STATUSES.has(p.status)).length,
    byStatus, byStage,
    clustersTotal: clustersIn(m, propertyId).length,
    clustersWithoutPages: own.filter((r) => r.state === 'UNOWNED').length,
    largestGaps: opportunities.filter((o) => gapRules.has(o.ruleId) && (o.severity === 'BLOCKER' || o.severity === 'HIGH')).slice(0, 6),
    nextWave: nw ? waveReadiness(m, nw) : null,
    coverageGaps: coverageGaps(m, propertyId).length,
  }
}

/** Post-launch sections — the frame exists; the reason says why it is empty. */
export const POST_LAUNCH_SECTIONS = ['Movers', 'Lost visibility', 'New queries', 'Indexing issues', 'Conversion changes', 'Geographic opportunities'] as const

export function postLaunchState(m: SearchModel, propertyId: string | null): Array<{ section: (typeof POST_LAUNCH_SECTIONS)[number]; reason: UnavailableReason | null }> {
  const props = propertyId ? [m.property.get(propertyId)!] : m.dataset.properties
  const gate = (fn: (p: SearchProperty) => UnavailableReason | null): UnavailableReason | null => {
    const reasons = props.map(fn)
    return reasons.every((r) => r !== null) ? reasons[0] : null
  }
  const search = gate((p) => searchMeasureGate(p, m.dataset.connections))
  const analytics = gate((p) => analyticsMeasureGate(p, m.dataset.connections))
  return POST_LAUNCH_SECTIONS.map((section) => ({ section, reason: section === 'Conversion changes' ? analytics : search }))
}

/* ── portfolio ──────────────────────────────────────────────────────────── */

export interface PropertySummary {
  property: SearchProperty
  mode: IntelligenceMode
  pagesPlanned: number
  pagesBuilt: number
  pagesReady: number
  pagesPublished: number
  /** null = unknown until Search Console reports */
  pagesIndexed: number | null
  clusters: number
  clustersOwned: number
  keywords: number
  geographies: number
  waves: number
  /** READY pages in the next wave over its pages, 0..1, null when no wave */
  launchReadiness: number | null
  connections: Record<ProviderId, ConnectionState>
  /** newest provider data-through date, or null */
  dataFreshness: string | null
  /** the snapshot capture date of the plan */
  planCapturedAt: string | null
  opportunities: { blocker: number; high: number; total: number }
}

export function propertySummary(m: SearchModel, p: SearchProperty, opportunities: readonly Opportunity[]): PropertySummary {
  const pages = m.pagesOf.get(p.id) ?? []
  const own = ownershipTable(m, p.id)
  const nw = nextWave(m, p.id)
  const r = nw ? waveReadiness(m, nw) : null
  const providers: ProviderId[] = ['SEARCH_CONSOLE', 'GA4', 'FIRST_PARTY', 'CLOUDFLARE', 'EXTERNAL_RESEARCH', 'LEADCOMMAND']
  const connections = Object.fromEntries(providers.map((pr) => [pr, connectionOf(m.dataset.connections, p.id, pr)?.state ?? 'NOT_CONFIGURED'])) as Record<ProviderId, ConnectionState>
  const through = m.dataset.connections.filter((c) => c.propertyId === p.id && c.dataThrough).map((c) => c.dataThrough!).sort().pop() ?? null
  const ops = opportunities.filter((o) => o.propertyId === p.id)
  const geos = new Set(pages.flatMap((x) => x.geographyIds))
  const indexedKnown = pages.some((x) => x.stage.indexed !== null)
  return {
    property: p, mode: intelligenceMode(p),
    pagesPlanned: pages.length, pagesBuilt: pages.filter((x) => x.stage.builtRoute).length,
    pagesReady: pages.filter((x) => COMPLETE_STATUSES.has(x.status)).length, pagesPublished: pages.filter((x) => x.stage.published).length,
    pagesIndexed: indexedKnown ? pages.filter((x) => x.stage.indexed === true).length : null,
    clusters: own.length, clustersOwned: own.filter((x) => x.state !== 'UNOWNED').length, keywords: (m.keywordsOf.get(p.id) ?? []).length,
    geographies: geos.size, waves: (m.wavesOf.get(p.id) ?? []).length,
    launchReadiness: r && r.pages ? r.ready / r.pages : null,
    connections, dataFreshness: through, planCapturedAt: p.sources[0]?.capturedAt ?? null,
    opportunities: { blocker: ops.filter((o) => o.severity === 'BLOCKER').length, high: ops.filter((o) => o.severity === 'HIGH').length, total: ops.length },
  }
}
