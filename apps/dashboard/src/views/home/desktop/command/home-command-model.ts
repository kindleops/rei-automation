/**
 * HOME · COMMAND CENTER — the pure model under the desktop Home.
 *
 * Everything here turns a real read model into what Home draws: the market
 * heat grid, the machine feed grouped into executions, the money in play, the
 * system pulses and the composition mode. Nothing is estimated to fill a gap:
 * a source that is missing yields null and the surface says so or stays away.
 *
 * Sources (all existing, all read-only):
 *   useHomeSignals                inbox · queue · today's messaging · campaigns
 *                                 · pipeline counts · closings · markets
 *   /api/cockpit/analytics/performance   series, rates, funnel, automation,
 *                                 ZIP-level delivered/replied/failed/buyers,
 *                                 geolocated stage moves, offers, closings
 *   /api/cockpit/pipeline/command        totals and value by stage
 *   /api/cockpit/pipeline/command/points active deals with coordinates
 *   /api/cockpit/workflow-studio/activity  the cross-runtime machine feed
 */
import { callBackend } from '../../../../lib/api/backendClient'
import { US_DOTS, US_STATES, US_VIEWBOX } from '../../us-dot-matrix'
import type { AnalyticsPerformance } from '../../../../domain/analytics/analytics-performance-api'
import type { PipelineCommandOverview } from '../../../../domain/pipeline/pipeline-command-api'
import type { FocusItem, HomeCampaigns, HomeClosings, HomeInbox, HomeMessaging, HomePipeline, HomeQueue } from '../../home-signals'
import type { SystemTone } from '../../useHomeSignals'

// ── The machine feed ────────────────────────────────────────────────────────

export interface StudioActivityItem {
  id: string
  at: string
  workflow: string
  workflow_name: string
  studio?: boolean
  kind: string
  tone: string
  title: string
  detail: string | null
  subject: { name: string | null; address: string | null; thread_key?: string | null }
  link: string | null
  run_id?: string | null
}

export interface StudioActivity {
  items: StudioActivityItem[]
  pulse: { last_hour: number; last_24h: number }
  degraded: string[]
  generatedAt: string | null
}

export async function fetchStudioActivity({ hours = 24, limit = 90 }: { hours?: number; limit?: number } = {}, signal?: AbortSignal): Promise<StudioActivity> {
  const res = await callBackend<{ ok?: boolean; items?: StudioActivityItem[]; pulse?: StudioActivity['pulse']; degraded?: string[]; generated_at?: string; message?: string }>(
    `/api/cockpit/workflow-studio/activity?hours=${hours}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(res.error || 'activity_unavailable')
  const body = res.data
  if (!body || body.ok === false || !Array.isArray(body.items)) throw new Error(body?.message || 'activity_unavailable')
  return {
    items: body.items,
    pulse: body.pulse ?? { last_hour: 0, last_24h: 0 },
    degraded: Array.isArray(body.degraded) ? body.degraded : [],
    generatedAt: body.generated_at ?? null,
  }
}

export type FeedLane = 'seller' | 'campaign' | 'orchestrator' | 'closing'

export const FEED_LANES: Array<{ key: FeedLane | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'seller', label: 'Sellers' },
  { key: 'campaign', label: 'Campaigns' },
  { key: 'orchestrator', label: 'Workflows' },
  { key: 'closing', label: 'Closings' },
]

export function laneOf(item: Pick<StudioActivityItem, 'workflow' | 'studio'>): FeedLane {
  if (item.workflow === 'campaign_execution') return 'campaign'
  if (item.workflow === 'closing_execution') return 'closing'
  if (item.workflow === 'seller_inbound' && !item.studio) return 'seller'
  return 'orchestrator'
}

export type FeedTone = 'good' | 'info' | 'attention' | 'bad' | 'quiet'

/** The feed speaks five tones; the services speak a few more. */
export function feedTone(tone: string, kind: string): FeedTone {
  if (kind === 'failed' || tone === 'bad') return 'bad'
  if (kind === 'attention' || tone === 'gold') return 'attention'
  if (kind === 'held' || tone === 'muted') return 'quiet'
  if (tone === 'good') return 'good'
  return 'info'
}

export interface FeedGroup {
  id: string
  lane: FeedLane
  workflowName: string
  /** Newest step first in `steps`; the group sorts by its newest step. */
  at: string
  startedAt: string
  title: string
  subject: { name: string | null; address: string | null }
  /** The conversation this moment belongs to, when it belongs to one. */
  threadKey: string | null
  link: string | null
  tone: FeedTone
  steps: Array<{ id: string; at: string; title: string; detail: string | null; tone: FeedTone }>
}

const TONE_RANK: Record<FeedTone, number> = { bad: 4, attention: 3, good: 2, info: 1, quiet: 0 }
const GROUP_WINDOW_MS = 30 * 60_000

/**
 * One row per execution, not per log line: a seller reply that was classified,
 * moved a stage, scheduled a follow-up and sent a reply reads as one moment
 * with its steps, the way the machine experienced it. Steps join a group by
 * the conversation (thread) or the run they belong to, inside a 30-minute
 * window; campaign send batches and closing events stand alone.
 */
export function groupActivity(items: StudioActivityItem[]): FeedGroup[] {
  const sorted = [...items].filter((i) => Number.isFinite(Date.parse(i.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const groups: FeedGroup[] = []
  const open = new Map<string, FeedGroup>()
  for (const item of sorted) {
    const lane = laneOf(item)
    const thread = item.subject?.thread_key || null
    const key = lane === 'campaign' || lane === 'closing'
      ? null
      : thread ? `t:${thread}` : item.run_id ? `r:${item.run_id}` : null
    const tone = feedTone(item.tone, item.kind)
    const step = { id: item.id, at: item.at, title: item.title, detail: item.detail, tone }
    const existing = key ? open.get(key) : undefined
    if (existing && Date.parse(existing.startedAt) - Date.parse(item.at) <= GROUP_WINDOW_MS) {
      existing.steps.push(step)
      existing.startedAt = item.at
      if (TONE_RANK[tone] > TONE_RANK[existing.tone]) existing.tone = tone
      if (!existing.subject.name && item.subject?.name) existing.subject.name = item.subject.name
      if (!existing.subject.address && item.subject?.address) existing.subject.address = item.subject.address
      if (!existing.link && item.link) existing.link = item.link
      if (!existing.threadKey && thread) existing.threadKey = thread
      continue
    }
    const group: FeedGroup = {
      id: `g:${item.id}`,
      lane,
      workflowName: item.workflow_name,
      at: item.at,
      startedAt: item.at,
      title: item.title,
      subject: { name: item.subject?.name ?? null, address: item.subject?.address ?? null },
      threadKey: thread,
      link: item.link,
      tone,
      steps: [step],
    }
    groups.push(group)
    if (key) open.set(key, group)
  }
  return groups
}

// ── Composition mode ────────────────────────────────────────────────────────

export type HomeMode = 'incident' | 'busy' | 'normal' | 'quiet'

/**
 * How Home arranges itself. Incident: the engine needs intervention or several
 * critical items are open, so Focus takes the stage. Busy: the machine is
 * moving fast or a lot is waiting. Quiet: nothing needs the operator and the
 * machine is idle, so Focus folds away and the map and feed get the room.
 */
export function resolveHomeMode(input: { system: SystemTone; critical: number; high: number; lastHour: number | null }): HomeMode {
  if (input.system === 'bad' || input.critical >= 3) return 'incident'
  if ((input.lastHour ?? 0) >= 25 || input.critical + input.high >= 6) return 'busy'
  if (input.critical === 0 && input.high === 0 && (input.lastHour ?? 0) <= 2) return 'quiet'
  return 'normal'
}

export interface FocusSummary {
  critical: number
  high: number
  total: number
  groups: Array<{ app: string; items: FocusItem[]; tone: FocusItem['tone'] }>
}

const FOCUS_TONE_RANK: Record<FocusItem['tone'], number> = { critical: 3, high: 2, opportunity: 1, normal: 0 }

/** Focus items grouped by the app that owns them, most severe group first. */
export function summarizeFocus(items: FocusItem[]): FocusSummary {
  const byApp = new Map<string, FocusItem[]>()
  for (const item of [...items].sort((a, b) => b.weight - a.weight)) {
    const list = byApp.get(item.app) ?? []
    list.push(item)
    byApp.set(item.app, list)
  }
  const groups = [...byApp.entries()].map(([app, list]) => ({
    app,
    items: list,
    tone: list.reduce<FocusItem['tone']>((worst, i) => (FOCUS_TONE_RANK[i.tone] > FOCUS_TONE_RANK[worst] ? i.tone : worst), 'normal'),
  }))
  groups.sort((a, b) => FOCUS_TONE_RANK[b.tone] - FOCUS_TONE_RANK[a.tone] || b.items[0].weight - a.items[0].weight)
  return {
    critical: items.filter((i) => i.tone === 'critical').length,
    high: items.filter((i) => i.tone === 'high').length,
    total: items.length,
    groups,
  }
}

// ── Albers USA (the projection the dot matrix was drawn in) ────────────────

const RAD = Math.PI / 180

function conicEqualArea(phi0: number, phi1: number) {
  const sy0 = Math.sin(phi0)
  const n = (sy0 + Math.sin(phi1)) / 2
  const c = 1 + sy0 * (2 * n - sy0)
  const r0 = Math.sqrt(c) / n
  return (lambda: number, phi: number): [number, number] => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n
    const x = lambda * n
    return [r * Math.sin(x), r0 - r * Math.cos(x)]
  }
}

function conic(opts: { parallels: [number, number]; rotate: number; center: [number, number]; scale: number; translate: [number, number] }) {
  const raw = conicEqualArea(opts.parallels[0] * RAD, opts.parallels[1] * RAD)
  const [cx, cy] = raw(opts.center[0] * RAD, opts.center[1] * RAD)
  const dx = opts.translate[0] - opts.scale * cx
  const dy = opts.translate[1] + opts.scale * cy
  return (lng: number, lat: number): [number, number] => {
    let lambda = (lng + opts.rotate) * RAD
    if (lambda > Math.PI) lambda -= 2 * Math.PI
    else if (lambda < -Math.PI) lambda += 2 * Math.PI
    const [x, y] = raw(lambda, lat * RAD)
    return [dx + opts.scale * x, dy - opts.scale * y]
  }
}

// d3.geoAlbersUsa().scale(1300).translate([487.5, 305]) — us-atlas states-albers-10m.
const K = 1300
const T: [number, number] = [487.5, 305]
const LOWER48 = conic({ parallels: [29.5, 45.5], rotate: 96, center: [-0.6, 38.7], scale: K, translate: T })
const ALASKA = conic({ parallels: [55, 65], rotate: 154, center: [-2, 58.5], scale: K * 0.35, translate: [T[0] - 0.307 * K, T[1] + 0.201 * K] })
const HAWAII = conic({ parallels: [8, 18], rotate: 157, center: [-3, 19.9], scale: K, translate: [T[0] - 0.205 * K, T[1] + 0.212 * K] })

/** [x, y] in the dot matrix's viewBox, or null outside the US. */
export function projectAlbersUsa(lng: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lat >= 50 && (lng <= -129 || lng >= 170)) return ALASKA(lng >= 170 ? lng - 360 : lng, lat)
  if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) return HAWAII(lng, lat)
  if (lat < 24 || lat > 50 || lng < -125.5 || lng > -66) return null
  return LOWER48(lng, lat)
}

// ── The dot grid ────────────────────────────────────────────────────────────

export interface Dot { x: number; y: number; state: number }

const SPACING = 11.5
let DOTS: Dot[] | null = null
let HASH: Map<string, number[]> | null = null

export function homeDots(): Dot[] {
  if (DOTS) return DOTS
  const out: Dot[] = []
  for (let i = 0; i < US_DOTS.length; i += 3) out.push({ x: US_DOTS[i] / 10, y: US_DOTS[i + 1] / 10, state: US_DOTS[i + 2] })
  DOTS = out
  return out
}

const cellKey = (x: number, y: number) => `${Math.floor(x / SPACING)}:${Math.floor(y / SPACING)}`

function dotHash(): Map<string, number[]> {
  if (HASH) return HASH
  const map = new Map<string, number[]>()
  homeDots().forEach((d, i) => {
    const k = cellKey(d.x, d.y)
    const list = map.get(k) ?? []
    list.push(i)
    map.set(k, list)
  })
  HASH = map
  return map
}

function dotsNear(x: number, y: number, radius: number): Array<{ i: number; d2: number }> {
  const hash = dotHash()
  const dots = homeDots()
  const span = Math.ceil(radius / SPACING)
  const cx = Math.floor(x / SPACING)
  const cy = Math.floor(y / SPACING)
  const out: Array<{ i: number; d2: number }> = []
  for (let gx = cx - span; gx <= cx + span; gx += 1) {
    for (let gy = cy - span; gy <= cy + span; gy += 1) {
      for (const i of hash.get(`${gx}:${gy}`) ?? []) {
        const d2 = (dots[i].x - x) ** 2 + (dots[i].y - y) ** 2
        if (d2 <= radius * radius) out.push({ i, d2 })
      }
    }
  }
  return out
}

/** The dot a projected point belongs to (coastal points snap to the shore). */
export function nearestDot(x: number, y: number): number | null {
  const near = dotsNear(x, y, SPACING * 3)
  if (!near.length) return null
  return near.reduce((best, d) => (d.d2 < best.d2 ? d : best)).i
}

export interface HeatPoint { lat: number; lng: number; w: number }

export interface HeatField {
  /** Display intensity 0..1 per dot (diffused, gamma-corrected). */
  level: Float32Array
  /** Raw total per state index, for hover and ranking. */
  byState: Map<number, number>
  /** Points that fell outside the map (none are dropped silently). */
  unplaced: number
  total: number
  peak: number
}

/**
 * Points → a heat surface on the dot grid: each point's weight lands on its
 * dot and spreads to neighbours with a Gaussian falloff, so a dense market
 * reads as a glowing region rather than a lone pixel. Totals per state are
 * kept raw (no diffusion) for the numbers shown on hover.
 */
export function heatField(points: HeatPoint[], { sigma = SPACING * 1.15, reach = SPACING * 2.6 } = {}): HeatField {
  const dots = homeDots()
  const level = new Float32Array(dots.length)
  const byState = new Map<number, number>()
  let unplaced = 0
  let total = 0
  for (const p of points) {
    const w = Number(p.w)
    if (!Number.isFinite(w) || w <= 0) continue
    const xy = projectAlbersUsa(p.lng, p.lat)
    const home = xy ? nearestDot(xy[0], xy[1]) : null
    if (xy == null || home == null) { unplaced += 1; continue }
    total += w
    const state = dots[home].state
    byState.set(state, (byState.get(state) ?? 0) + w)
    for (const { i, d2 } of dotsNear(dots[home].x, dots[home].y, reach)) {
      level[i] += w * Math.exp(-d2 / (2 * sigma * sigma))
    }
  }
  let peak = 0
  for (let i = 0; i < level.length; i += 1) if (level[i] > peak) peak = level[i]
  if (peak > 0) for (let i = 0; i < level.length; i += 1) level[i] = Math.sqrt(level[i] / peak)
  return { level, byState, unplaced, total, peak }
}

export const stateName = (index: number) => US_STATES[index]?.name ?? null
export const stateAbbr = (index: number) => US_STATES[index]?.abbr ?? null
export const HOME_MAP_VIEWBOX = US_VIEWBOX

// ── Map layers (each one a real metric with a real location) ────────────────

export type MapLayerId = 'replies' | 'delivered' | 'failed' | 'moves' | 'offers' | 'deals' | 'buyers'

export interface MapLayer {
  id: MapLayerId
  label: string
  unit: string
  /** What the number means, said once. */
  definition: string
  hue: string
  /** Range-bound layers follow the time selector; deal locations are current. */
  ranged: boolean
}

export const MAP_LAYERS: MapLayer[] = [
  { id: 'replies', label: 'Seller replies', unit: 'replies', definition: 'Seller replies in the period, by the ZIP of the property they were about.', hue: '#5ac8fa', ranged: true },
  { id: 'delivered', label: 'Deliveries', unit: 'delivered', definition: 'Messages delivered to sellers in the period, by property ZIP.', hue: '#34d399', ranged: true },
  { id: 'moves', label: 'Stage moves', unit: 'moves', definition: 'Deals that moved stage in the period, at the property.', hue: '#a78bfa', ranged: true },
  { id: 'offers', label: 'Offers', unit: 'offers', definition: 'Offers made in the period, at the property.', hue: '#fbbf24', ranged: true },
  { id: 'deals', label: 'Active deals', unit: 'deals', definition: 'Live opportunities in the pipeline right now, at the property.', hue: '#f472b6', ranged: false },
  { id: 'buyers', label: 'Buyer demand', unit: 'purchases', definition: 'Recorded purchases by identified cash buyers in the period, by ZIP.', hue: '#fb923c', ranged: true },
  { id: 'failed', label: 'Failed sends', unit: 'failed', definition: 'Sends that failed in the period, by property ZIP — where delivery needs attention.', hue: '#ff5b6c', ranged: true },
]

const placed = (lat: unknown, lng: unknown) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(lat) !== 0 && Number(lng) !== 0

export function layerPoints(layer: MapLayerId, src: { performance: AnalyticsPerformance | null; deals: Array<{ lat: number; lng: number }> | null }): HeatPoint[] | null {
  const perf = src.performance
  if (layer === 'deals') return src.deals ? src.deals.filter((p) => placed(p.lat, p.lng)).map((p) => ({ lat: p.lat, lng: p.lng, w: 1 })) : null
  if (!perf) return null
  const zips = perf.zips ?? []
  const fromZips = (pick: (z: AnalyticsPerformance['zips'][number]) => number) =>
    zips.filter((z) => placed(z.lat, z.lng)).map((z) => ({ lat: Number(z.lat), lng: Number(z.lng), w: pick(z) }))
  switch (layer) {
    case 'replies': return fromZips((z) => z.replied)
    case 'delivered': return fromZips((z) => z.delivered)
    case 'failed': return fromZips((z) => z.failed)
    case 'buyers': return fromZips((z) => z.buyerPurchases)
    case 'moves': return (perf.cohorts?.transitions ?? []).filter((t) => placed(t.lat, t.lng)).map((t) => ({ lat: Number(t.lat), lng: Number(t.lng), w: 1 }))
    case 'offers': return (perf.deals?.offers ?? []).filter((o) => placed(o.lat, o.lng)).map((o) => ({ lat: Number(o.lat), lng: Number(o.lng), w: 1 }))
    default: return null
  }
}

/** Top places for a layer: markets when the source names them, else states. */
export function layerLeaders(layer: MapLayerId, src: { performance: AnalyticsPerformance | null }, field: HeatField, limit = 5): Array<{ label: string; value: number }> {
  const perf = src.performance
  if (perf && (layer === 'replies' || layer === 'delivered' || layer === 'failed' || layer === 'buyers')) {
    const pick = { replies: 'replied', delivered: 'delivered', failed: 'failed', buyers: 'buyerPurchases' } as const
    const byMarket = new Map<string, number>()
    for (const z of perf.zips ?? []) {
      const market = z.market || null
      const v = Number(z[pick[layer]]) || 0
      if (!market || v <= 0) continue
      byMarket.set(market, (byMarket.get(market) ?? 0) + v)
    }
    if (byMarket.size) {
      const nameOf = new Map((perf.markets ?? []).map((m) => [m.id, m.name]))
      return [...byMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, value]) => ({ label: nameOf.get(id) || id, value }))
    }
  }
  return [...field.byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, value]) => ({ label: stateName(i) ?? 'Unknown', value }))
}

// ── Money ───────────────────────────────────────────────────────────────────

export interface MoneyModel {
  /** Estimated property value across live opportunities (null when none valued). */
  value: number | null
  valued: number
  opportunities: number
  asking: number | null
  offersOut: number
  movedToday: number
  /** Value by stage group, in lifecycle order, only groups holding value or deals. */
  bands: Array<{ key: string; label: string; count: number; value: number | null }>
}

export function moneyModel(overview: PipelineCommandOverview | null): MoneyModel | null {
  if (!overview) return null
  const groupOf = new Map<string, string>()
  for (const g of overview.groups) for (const s of g.stages) groupOf.set(s, g.key)
  const bands = overview.groups.map((g) => {
    const stages = overview.stages.filter((s) => groupOf.get(s.code) === g.key)
    const value = stages.reduce((sum, s) => sum + (s.value ?? 0), 0)
    return { key: g.key, label: g.label, count: stages.reduce((n, s) => n + s.count, 0), value: value > 0 ? value : null }
  }).filter((b) => b.count > 0 || b.value)
  return {
    value: overview.totals.value,
    valued: overview.totals.valued,
    opportunities: overview.totals.opportunities,
    asking: overview.totals.asking,
    offersOut: overview.totals.offersOut,
    movedToday: overview.totals.movedToday,
    bands,
  }
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

// ── Telemetry and system pulses ─────────────────────────────────────────────

export interface Telemetry {
  key: string
  label: string
  value: number | null
  display?: string
  tone?: 'good' | 'warn' | 'bad' | 'accent'
  hint: string
  path: string
}

export function heroTelemetry(src: {
  focus: FocusSummary | null
  inbox: HomeInbox | null
  messaging: HomeMessaging | null
  queue: HomeQueue | null
  campaigns: HomeCampaigns | null
  pipeline: HomePipeline | null
  overview: PipelineCommandOverview | null
}): Telemetry[] {
  const { focus, messaging, queue, campaigns, pipeline, overview } = src
  const out: Telemetry[] = []
  if (focus) out.push({ key: 'need', label: 'need you', value: focus.critical + focus.high, tone: focus.critical ? 'bad' : focus.high ? 'warn' : 'good', hint: 'Critical and high-priority items across Inbox, Queue, Campaigns, Pipeline and Closings.', path: '/inbox' })
  if (messaging) out.push({ key: 'replies', label: 'replies today', value: messaging.replies, tone: 'accent', hint: 'Seller replies received today.', path: '/inbox' })
  if (campaigns) out.push({ key: 'campaigns', label: 'campaigns live', value: campaigns.live, hint: 'Campaigns running now (active, activating, limited or queued).', path: '/campaign-command' })
  const deals = overview?.totals.opportunities ?? pipeline?.active ?? null
  if (deals !== null) out.push({ key: 'deals', label: 'active deals', value: deals, hint: 'Live opportunities in the pipeline.', path: '/pipeline' })
  if (overview && overview.totals.value) out.push({ key: 'value', label: 'est. value in play', value: overview.totals.value, display: money(overview.totals.value), hint: `Estimated property value across ${overview.totals.valued} of ${overview.totals.opportunities} live deals that carry a valuation.`, path: '/pipeline' })
  if (queue) {
    out.push({ key: 'sent', label: 'sent today', value: queue.sentToday, hint: 'Messages the engine sent today.', path: '/queue' })
    out.push({ key: 'delivered', label: 'delivered', value: queue.deliveredToday, tone: 'good', hint: 'Carrier-confirmed deliveries today.', path: '/queue' })
    out.push({ key: 'failed', label: 'failed', value: queue.failedToday, tone: queue.failedToday > 0 ? 'bad' : undefined, hint: 'Sends that failed today.', path: '/queue' })
  }
  return out
}

export interface SystemPulse {
  key: string
  app: string
  path: string
  tone: 'good' | 'warn' | 'bad' | 'idle'
  /** Metrics in reading order; null values are dropped, never zero-filled. */
  metrics: Array<{ label: string; value: number | null; tone?: 'warn' | 'bad' | 'good' }>
}

export function systemPulses(src: {
  overview: PipelineCommandOverview | null
  campaigns: HomeCampaigns | null
  queue: HomeQueue | null
  closings: HomeClosings | null
  inbox: HomeInbox | null
  performance: AnalyticsPerformance | null
}): SystemPulse[] {
  const out: SystemPulse[] = []
  const { overview, campaigns, queue, closings, inbox, performance } = src
  if (inbox) {
    out.push({
      key: 'inbox', app: 'Inbox', path: '/inbox',
      tone: (inbox.priority ?? 0) > 0 ? 'warn' : 'good',
      metrics: [
        { label: 'new replies', value: inbox.newReplies },
        { label: 'priority', value: inbox.priority, tone: (inbox.priority ?? 0) > 0 ? 'warn' : undefined },
      ],
    })
  }
  if (overview) {
    const t = overview.totals
    out.push({
      key: 'pipeline', app: 'Pipeline', path: '/pipeline',
      tone: t.attention > 0 ? 'warn' : 'good',
      metrics: [
        { label: 'active', value: t.opportunities },
        { label: 'machine-handled', value: t.automated },
        { label: 'exceptions', value: t.attention, tone: t.attention > 0 ? 'warn' : undefined },
        { label: 'moving today', value: t.movedToday, tone: t.movedToday > 0 ? 'good' : undefined },
      ],
    })
  }
  if (campaigns) {
    out.push({
      key: 'campaigns', app: 'Campaigns', path: '/campaign-command',
      tone: campaigns.attention.length ? 'warn' : campaigns.live ? 'good' : 'idle',
      metrics: [
        { label: 'live', value: campaigns.live },
        { label: 'paused', value: campaigns.paused },
        { label: 'ready targets', value: campaigns.readyTargets },
      ],
    })
  }
  if (queue) {
    out.push({
      key: 'queue', app: 'Queue', path: '/queue',
      tone: queue.status === 'critical' ? 'bad' : queue.failedToday > 0 || queue.status === 'warning' ? 'warn' : 'good',
      metrics: [
        { label: 'sent today', value: queue.sentToday },
        { label: 'in flight', value: queue.inFlight },
        { label: 'failed', value: queue.failedToday, tone: queue.failedToday > 0 ? 'bad' : undefined },
      ],
    })
  }
  if (performance) {
    const a = performance.automation
    out.push({
      key: 'automation', app: 'Workflow Studio', path: '/workflow-studio',
      tone: a.failed > 0 ? 'bad' : a.needsReview > 0 || a.heldByGate > 0 ? 'warn' : a.runs ? 'good' : 'idle',
      metrics: [
        { label: 'runs', value: a.runs },
        { label: 'held by a gate', value: a.heldByGate, tone: a.heldByGate > 0 ? 'warn' : undefined },
        { label: 'need review', value: a.needsReview, tone: a.needsReview > 0 ? 'warn' : undefined },
        { label: 'failed', value: a.failed, tone: a.failed > 0 ? 'bad' : undefined },
      ],
    })
  }
  if (closings) {
    out.push({
      key: 'closings', app: 'Closing Desk', path: '/closing-desk',
      tone: (closings.actionRequired ?? 0) > 0 || (closings.titleBlocked ?? 0) > 0 ? 'warn' : (closings.underContract ?? 0) > 0 ? 'good' : 'idle',
      metrics: [
        { label: 'under contract', value: closings.underContract },
        { label: 'need you', value: closings.actionRequired, tone: (closings.actionRequired ?? 0) > 0 ? 'warn' : undefined },
        { label: 'closing this week', value: closings.closingsThisWeek },
      ],
    })
  }
  return out
    .map((p) => ({ ...p, metrics: p.metrics.filter((m) => m.value !== null && m.value !== undefined) }))
    .filter((p) => p.metrics.length > 0)
}

/** "LeadCommand is running across 5 markets" — markets with real sends in the period. */
export function activeMarketCount(performance: AnalyticsPerformance | null): number | null {
  if (!performance) return null
  const n = (performance.markets ?? []).filter((m) => (Number(m.cur?.delivered) || 0) + (Number(m.cur?.sent) || 0) > 0).length
  return n || null
}
