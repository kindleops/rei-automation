/**
 * PIPELINE COMMAND — client for /api/cockpit/pipeline/command/*.
 *
 * Read-only. The server decides stage (canonical), lane (whose move it is,
 * from evidence), stall (against the stage's own clock) and movement (real
 * history, test/certification rows excluded). The UI renders; it never
 * re-derives lifecycle truth and never moves a stage.
 */
import { callBackend } from '../../lib/api/backendClient'

export type LaneKey = 'system' | 'seller' | 'operator' | 'external' | 'blocked' | 'dormant' | 'complete' | 'closed_out'

export type PipelineLane = { key: LaneKey; label: string; detail: string | null; since: string | null; reason?: string }
export type PipelineStall = { key: string; label: string } | null

export type PipelineCommandCard = {
  id: string
  stage: string
  stageIndex: number | null
  stageLabel: string
  group: string | null
  status: string
  lane: PipelineLane
  stall: PipelineStall
  urgency: number
  daysInStage: number | null
  seller: string | null
  sellerSource: string | null
  address: string | null
  city: string | null
  state: string | null
  market: string | null
  propertyType: string | null
  units: number | null
  propertyId: string | null
  masterOwnerId: string | null
  threadKey: string | null
  temperature: string | null
  hot: boolean
  intent: string | null
  intentLabel: string | null
  lastActivityAt: string | null
  lastInboundAt: string | null
  lastMessage: string | null
  lastMessageAt: string | null
  lastDirection: string | null
  money: { asking: number | null; offer: number | null; counter: number | null; value: number | null; equity: number | null; contractPrice: number | null; buyerPrice: number | null }
  closing: { status: string | null; contract: string | null; title: string | null; disposition: string | null; date: string | null; hasBuyer: boolean; emd: number | null } | null
  createdAt: string | null
}

export type PipelineStageSummary = {
  code: string
  index: number
  short: string
  label: string
  group: string
  count: number
  working: number
  dormant: number
  attention: number
  stalled: number
  movedToday: number
  value: number | null
}

export type PipelineMovement = {
  id: string
  opportunityId: string
  at: string
  kind: 'advance' | 'regress' | 'price' | 'offer' | 'counter' | 'created' | 'exit' | 'reply'
  title: string
  detail: string | null
  address: string | null
  seller: string | null
  stage: string
  stageIndex: number | null
  fromStage?: string
  toStage?: string
}

export type PipelineCommandOverview = {
  scope: string
  generatedAt: string
  capped: boolean
  totals: {
    opportunities: number
    working: number
    dormant: number
    automated: number
    closedOut: number
    value: number | null
    valued: number
    asking: number | null
    offersOut: number
    movedToday: number
    attention: number
    stalled: number
    closed: number
  }
  stages: PipelineStageSummary[]
  groups: Array<{ key: string; label: string; stages: string[]; count: number }>
  lanes: Partial<Record<LaneKey | 'gated', number>>
  stalled: { total: number; by: Record<string, number> }
  attentionTop: PipelineCommandCard[]
  movement: PipelineMovement[]
  thresholds: { dormantDays: number; stageMaxDays: Record<string, number>; sellerSilenceDays: Record<string, number>; operatorWaitHours: number; systemOverdueHours: number }
}

export type PipelineCommandFeed = { view: string; sort: string; total: number; capped: boolean; rows: PipelineCommandCard[]; nextCursor: number | null }

export type PipelineStoryBeat = { at: string; kind: string; title: string; detail: string | null; stage?: string | null; lane?: LaneKey; intent?: string | null }

export type PipelineDealStory = {
  card: PipelineCommandCard
  story: PipelineStoryBeat[]
  conversation: {
    threadKey: string | null
    lastInbound: { at: string; body: string; intent: string | null } | null
    lastOutbound: { created_at: string; message_body: string | null } | null
    messages: number
    inbound: number
  }
  negotiation: {
    asking: number | null
    offer: number | null
    counter: number | null
    recommended: number | null
    gap: number | null
    offers: Array<{ id: string; version: number | null; direction: string | null; price: number | null; status: string | null; sentAt: string | null; acceptedAt: string | null }>
  }
  decision: {
    aos: number | null; tier: string | null; confidence: number | null; strategy: string | null
    offer: number | null; floor: number | null; valueLow: number | null; valueMid: number | null; valueHigh: number | null
    assignmentFee: number | null; computedAt: string | null
  } | null
  disposition: { matched: number; aGrade: number; packagesSent: number; interested: number; selected: string | null; top: Array<{ name: string; grade: string | null; score: number | null; status: string | null }> }
  closing: PipelineCommandCard['closing']
}

export type PipelineCommandParams = {
  scope?: 'active' | 'closed' | 'dead' | 'suppressed' | 'all'
  q?: string
  market?: string
  property_type?: string
  temperature?: string
  /** 'lens' (desktop Pipeline): nurture deals leave the main view into feed view=nurture; overview totals.nurture counts them */
  nurture?: 'lens'
}

const BASE = '/api/cockpit/pipeline/command'

function qs(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v))
  return out.toString()
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<{ ok: boolean; data: T; message?: string }>(path, { signal })
  if (!res.ok) {
    // Keep the server's code (e.g. `opportunity_not_found`) so callers can
    // tell "gone" from "failed".
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.message || res.error || 'pipeline_command_failed')
  }
  if (!res.data?.data) throw new Error('pipeline_command_empty')
  return res.data.data
}

export const fetchPipelineOverview = (params: PipelineCommandParams, signal?: AbortSignal) =>
  get<PipelineCommandOverview>(`${BASE}?${qs(params)}`, signal)

export const fetchPipelineFeed = (params: PipelineCommandParams & { view?: string; sort?: string; cursor?: number; limit?: number }, signal?: AbortSignal) =>
  get<PipelineCommandFeed>(`${BASE}/feed?${qs(params)}`, signal)

export const fetchPipelinePoints = (params: PipelineCommandParams & { view?: string }, signal?: AbortSignal) =>
  get<{ total: number; points: Array<{ id: string; lat: number; lng: number; label: string | null }> }>(`${BASE}/points?${qs(params)}`, signal)

export const fetchPipelineDealStory = (id: string, signal?: AbortSignal) =>
  get<PipelineDealStory>(`${BASE}/story/${encodeURIComponent(id)}`, signal)

/** Stage → accent. Cool early, cobalt negotiation, violet contract, aqua dispo, gold closing. */
export const STAGE_TONE: Record<string, string> = {
  ownership_confirmation: 'var(--plc-s-early)',
  offer_interest: 'var(--plc-s-early)',
  asking_price: 'var(--plc-s-qualify)',
  property_condition: 'var(--plc-s-qualify)',
  offer: 'var(--plc-s-negotiate)',
  formal_contract: 'var(--plc-s-contract)',
  disposition: 'var(--plc-s-dispo)',
  under_contract: 'var(--plc-s-closing)',
  prepared_to_close: 'var(--plc-s-closing)',
  closed: 'var(--plc-s-closed)',
}

export const LANE_META: Record<LaneKey, { label: string; tone: string; icon: string }> = {
  system: { label: 'Automation', tone: 'var(--plc-l-system)', icon: 'cpu' },
  seller: { label: 'On seller', tone: 'var(--plc-l-seller)', icon: 'clock' },
  operator: { label: 'Needs you', tone: 'var(--plc-l-operator)', icon: 'user' },
  external: { label: 'Outside party', tone: 'var(--plc-l-external)', icon: 'briefcase' },
  blocked: { label: 'Blocked', tone: 'var(--plc-l-blocked)', icon: 'alert' },
  dormant: { label: 'Dormant', tone: 'var(--plc-l-dormant)', icon: 'moon' },
  complete: { label: 'Closed', tone: 'var(--plc-l-complete)', icon: 'check' },
  closed_out: { label: 'Closed out', tone: 'var(--plc-l-dormant)', icon: 'x' },
}

export function compactMoney(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

export function relTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
