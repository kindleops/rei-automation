import { callBackend } from '../../../../lib/api/backendClient'
import { fetchPipelineFeed, fetchPipelineOverview, fetchPipelinePoints, type PipelineCommandCard, type PipelineCommandOverview } from '../../../../domain/pipeline/pipeline-command-api'
import { fetchCampaignsSurface } from '../../../campaign-command/campaigns.adapter'
import type { CampaignSummary } from '../../../campaign-command/campaigns.types'
import { fetchRegistry } from '../../../workflow-studio/desktop/lib/api'
import type { RegistryResponse } from '../../../workflow-studio/desktop/lib/types'
import { fetchHome as fetchEmailHome, type Home as EmailHome } from '../../../email-command/mobile/email-command-api'
import { fetchSignalCenter } from '../../../../modules/notifications/signals/signals-api'
import type { SignalCenterModel } from '../../../../modules/notifications/signals/signals-model'
import {
  loadHomeCalendar,
  loadHomeClosings,
  loadHomeInbox,
  loadHomeMessaging,
  loadHomePipeline,
  loadHomeQueue,
  summarizeCampaigns,
  type HomeCalendar,
  type HomeCampaigns,
  type HomeClosings,
  type HomeInbox,
  type HomeLoad,
  type HomeMessaging,
  type HomePipeline,
  type HomeQueue,
} from '../../home-signals'
import { fetchHomeMetrics, fetchMapActivity, fetchStudioActivity, type HomeMetrics, type HomeMetricsRange, type MapActivity, type MapActivityLens, type MapRange, type StudioActivity } from '../command/home-command-model'

/**
 * THE HOME SOURCES — every read a first-party widget makes, by key.
 *
 * Each is an existing canonical read endpoint the owning app already uses;
 * Home adds no new read model. Keys are what make reads shared: every widget
 * that needs `inbox` reads one request. `apps` are the rail routes whose
 * ledger events refresh the source early.
 */

export interface SourceDef<T> { key: string; load: (signal: AbortSignal) => Promise<T>; apps: readonly string[]; everyMs: number }

const unwrap = async <T,>(p: Promise<HomeLoad<T>>): Promise<T> => {
  const r = await p
  if (r.status === 'ready') return r.data
  throw new Error(r.status === 'unavailable' ? r.reason : 'Unavailable')
}

export interface CampaignBook { list: CampaignSummary[]; summary: HomeCampaigns; truncated: boolean }

export const SOURCES = {
  inbox: { key: 'inbox', load: (s) => unwrap(loadHomeInbox(s)), apps: ['/inbox'], everyMs: 45_000 } satisfies SourceDef<HomeInbox>,
  queue: { key: 'queue', load: () => unwrap(loadHomeQueue()), apps: ['/queue'], everyMs: 45_000 } satisfies SourceDef<HomeQueue>,
  messaging: { key: 'messaging', load: () => unwrap(loadHomeMessaging()), apps: ['/queue', '/inbox'], everyMs: 60_000 } satisfies SourceDef<HomeMessaging>,
  campaigns: {
    key: 'campaigns',
    load: async () => {
      const surface = await fetchCampaignsSurface()
      if (!surface.ok) throw new Error(surface.errorMessage ?? 'Campaigns unavailable')
      return { list: surface.data, summary: summarizeCampaigns(surface.data, Boolean(surface.degraded)), truncated: Boolean(surface.truncated) }
    },
    apps: ['/campaign-command'],
    everyMs: 120_000,
  } satisfies SourceDef<CampaignBook>,
  pipeline: { key: 'pipeline', load: () => unwrap(loadHomePipeline()), apps: ['/pipeline'], everyMs: 180_000 } satisfies SourceDef<HomePipeline>,
  pipelineOverview: { key: 'pipeline-overview', load: (s) => fetchPipelineOverview({ scope: 'active' }, s), apps: ['/pipeline'], everyMs: 180_000 } satisfies SourceDef<PipelineCommandOverview>,
  pipelineTop: {
    key: 'pipeline-top',
    load: async (s) => (await fetchPipelineFeed({ scope: 'active', view: 'all', sort: 'value', limit: 6 }, s)).rows.filter((c) => (c.money.value ?? 0) > 0),
    apps: ['/pipeline'],
    everyMs: 180_000,
  } satisfies SourceDef<PipelineCommandCard[]>,
  pipelinePoints: {
    key: 'pipeline-points',
    load: async (s) => (await fetchPipelinePoints({ scope: 'active' }, s)).points.map((p) => ({ lat: p.lat, lng: p.lng })),
    apps: ['/pipeline'],
    everyMs: 600_000,
  } satisfies SourceDef<Array<{ lat: number; lng: number }>>,
  closings: { key: 'closings', load: (s) => unwrap(loadHomeClosings(s)), apps: ['/closing-desk'], everyMs: 180_000 } satisfies SourceDef<HomeClosings>,
  calendar: { key: 'calendar', load: () => unwrap(loadHomeCalendar()), apps: [], everyMs: 300_000 } satisfies SourceDef<HomeCalendar>,
  activity: { key: 'activity', load: (s) => fetchStudioActivity({ hours: 24, limit: 90 }, s), apps: ['/inbox', '/queue', '/campaign-command', '/workflow-studio', '/closing-desk', '/pipeline'], everyMs: 30_000 } satisfies SourceDef<StudioActivity>,
  workflow: { key: 'workflow-registry', load: (s) => fetchRegistry(s), apps: ['/workflow-studio'], everyMs: 120_000 } satisfies SourceDef<RegistryResponse>,
  email: { key: 'email-home', load: (s) => fetchEmailHome({}, s), apps: ['/email-command'], everyMs: 120_000 } satisfies SourceDef<EmailHome>,
  signals: {
    key: 'signals',
    load: async () => {
      const r = await fetchSignalCenter()
      if (!r.ok) throw new Error(r.message)
      return r
    },
    apps: [],
    everyMs: 120_000,
  } satisfies SourceDef<SignalCenterModel>,
} as const

/**
 * Period figures (and optionally the active markets) — one request per
 * distinct (range, market, markets). Never the Analytics bundle: its single
 * statement exceeds PostgREST's 8s timeout in production.
 */
export function homeMetricsSource(range: HomeMetricsRange, market: string | null = null, markets = false): SourceDef<HomeMetrics> {
  return {
    key: `home-metrics:${range}:${market ?? '*'}${markets ? ':markets' : ''}`,
    load: (s) => fetchHomeMetrics({ range, market, markets }, s),
    apps: ['/queue', '/inbox', '/pipeline'],
    everyMs: range === 'today' ? 120_000 : 300_000,
  }
}

/**
 * The Map widget's lens for a period — its own narrow read, never the
 * Analytics bundle (which timed out in production and blanked the map).
 */
export function mapActivitySource(lens: MapActivityLens, range: MapRange): SourceDef<MapActivity> {
  return {
    key: `map-activity:${lens}:${range}`,
    load: (s) => fetchMapActivity({ lens, range }, s),
    apps: lens === 'replies' ? ['/inbox'] : lens === 'delivered' || lens === 'failed' ? ['/queue'] : lens === 'moves' || lens === 'offers' ? ['/pipeline'] : [],
    everyMs: range === 'today' ? 120_000 : 300_000,
  }
}

/* ── Home instruments (/api/cockpit/home/instruments) — one narrow cached read per app ── */

export interface DealInstrument {
  active: number; scored: number; unscored: number; review: number; lowConfidence: number; offersAwaiting: number
  tiers: Record<string, number>
  reviewItems: DealItem[]; lowItems: DealItem[]
  offers: Array<{ id: string; propertyId: string | null; opportunityId: string | null; price: number | null; status: string; sentAt: string | null }>
  rules: { lowConfidence: string; review: string }
}
export interface DealItem { opportunityId: string; propertyId: string | null; threadKey: string | null; masterOwnerId: string | null; address: string | null; market: string | null; stage: string | null; tier: string | null; confidence: number | null; valuationConfidence: number | null; recommendedOffer: number | null }
export interface CompsInstrument {
  newestSale: string | null; freshnessDays: number | null; sales30: number; sales90: number; /** all recorded sales in 90 days, priced or not (activity) */ activity90: number; source: string
  recent: Array<{ id: string; propertyId: string | null; address: string | null; city: string | null; state: string | null; soldOn: string; price: number | null; ppsf: number | null; type: string | null; units: number | null; lat: number | null; lng: number | null }>
  activeMarkets: Array<{ market: string; deals: number; comps90: number }>
}
export interface BuyersInstrument {
  activeDeals: number; dealsWithMatches: number; candidates: number; contacted: number; privacy: string
  strongest: Array<{ opportunityId: string | null; propertyId: string; threadKey: string | null; address: string | null; market: string | null; candidates: number; bestScore: number | null; bestGrade: string | null; bestBuyerType: string | null }>
  demand: Array<{ market: string; deals: number; sales90: number; investorPurchases90: number }>
}
export interface EntityInstrument { owners: number | null; ownersEstimated: boolean; connected: Array<{ id: string; name: string; kind: string | null; properties: number; value: number | null; markets: string[] }>; changes: null }
export interface QueueInstrument {
  held: number; heldCapped: boolean; reasons: Array<{ code: string; count: number }>
  senders: { total: number; active: number; cooling: number; flagged: number; remainingToday: number; dailyCapacity: number }
  numbers: Array<{ phone: string; label: string | null; market: string | null; state: string; health: string | null; limit: number | null; sent: number; remaining: number }>
  note: string
}
type InstrumentKind = 'deal' | 'comps' | 'buyers' | 'entity' | 'queue'
interface InstrumentMap { deal: DealInstrument; comps: CompsInstrument; buyers: BuyersInstrument; entity: EntityInstrument; queue: QueueInstrument }

const INSTRUMENT_APPS: Record<InstrumentKind, readonly string[]> = { deal: ['/pipeline'], comps: [], buyers: [], entity: [], queue: ['/queue'] }
const INSTRUMENT_EVERY: Record<InstrumentKind, number> = { deal: 180_000, comps: 600_000, buyers: 600_000, entity: 900_000, queue: 60_000 }

export function instrumentSource<K extends InstrumentKind>(kind: K): SourceDef<InstrumentMap[K]> {
  return {
    key: `instrument:${kind}`,
    load: async (signal) => {
      const res = await callBackend<{ ok: boolean; data?: InstrumentMap[K]; message?: string }>(`/api/cockpit/home/instruments?kind=${kind}`, { signal, timeoutMs: 30_000 })
      if (!res.ok) throw new Error(res.message || 'unavailable')
      if (!res.data?.ok || !res.data.data) throw new Error(res.data?.message || 'unavailable')
      return res.data.data
    },
    apps: INSTRUMENT_APPS[kind],
    everyMs: INSTRUMENT_EVERY[kind],
  }
}
