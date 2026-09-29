import { callBackend } from '../../../lib/api/backendClient'

/**
 * CLOSING EXECUTION — client contract for /api/cockpit/closing-desk/execution.
 * The server derives every state, blocker, owner and number
 * (apps/api/src/lib/domain/closings/closing-execution-model.js); this file only
 * types them. Demo data (?demo=1) is the same derivation run over raw scenario
 * rows, loaded lazily and always labelled — a failed read NEVER falls back to it.
 */

export type Owner = 'you' | 'seller' | 'buyer' | 'title' | 'lender' | 'system'
export type RailStatus = 'complete' | 'active' | 'waiting' | 'blocked' | 'not_started'
export type Tone = 'blocked' | 'attention' | 'external' | 'active' | 'ready' | 'closed' | 'terminated'

export interface When { at: string; date: string; time: string | null; tz: string | null }
export interface RailStep { key: string; label: string; status: RailStatus; owner: Owner | null; detail: string; at: string | null; action: string | null }
export interface Requirement { key: string; label: string; met: boolean; detail?: string | null }
export interface Blocker { key: string; what: string; why: string; owner: Owner; ownerLabel: string; action: string }
export interface EmdLine {
  kind: 'buyer' | 'contract'; required: boolean; amount: number | null
  state: 'not_required' | 'verified' | 'received' | 'failed' | 'disputed' | 'refunded' | 'overdue' | 'due' | 'required'
  due: When | null; dueSoon: boolean
  receipt: { id: string | null; status: string | null; receivedAt: string | null; verifiedAt: string | null; verifiedBy: string | null; method: string | null; evidence: string | null; escrow: string | null; reference: string | null; source: string | null } | null
}
export interface Valued { value: number; basis: string }
export interface SettlementLeg {
  id: string | null; leg: string | null; strategy: string | null; closedAt: string | null; provider: string | null
  sellerAmount: number | null; buyerAmount: number | null; assignmentFee: number | null; closingCosts: number | null; otherCosts: number | null; netProceeds: number | null
  statementType: string | null; statementRef: string | null; verifiedBy: string | null; verifiedAt: string | null; method: string | null
  recording: { status: string | null; at: string | null; instrument: string | null; jurisdiction: string | null }
  exception: { kind: string; at: string | null; note: string | null } | null
}
export interface ClosingDoc { key: string; label: string; party: string; status: string; source: string | null; reference: string | null; version?: number | null; at: string | null }
export interface TimelineEvent { at: string; label: string; source: string; planned?: boolean }
export interface Deadline extends When { key: string; label: string; met: boolean; overdue: boolean }

export interface Closing {
  id: string
  opportunityId: string | null
  propertyId: string | null
  masterOwnerId: string | null
  threadKey: string | null
  property: { address: string | null; line: string | null; city: string | null; state: string | null; zip: string | null; tz: string | null; tzConfident: boolean }
  seller: { name: string | null; signerEmail: string | null }
  stage: { key: string; code: string; label: string; opportunityStage: string | null; diverged: boolean } | null
  terminal: boolean
  closed: boolean
  ready: boolean
  state: { key: string; label: string; tone: Tone }
  closing: (When & { confirmed: boolean; daysOut: number | null; past: boolean }) | null
  rail: RailStep[]
  requirements: Requirement[]
  blockers: Blocker[]
  next: { what: string; owner: Owner; ownerLabel: string | null; action: string | null; blocker: boolean } | null
  buyer: {
    id: string | null; offerId: string | null; name: string | null; selected: boolean; selectedAt: string | null
    committed: boolean; committedAt: string | null; commitmentStatus: string | null; offerStatus: string | null
    strategy: string | null; price: number | null; closingDate: string | null
    pof: { status: string | null; verifiedAt: string | null; expiresAt: string | null }
    agreement: { id: string | null; type: string | null; status: string | null; version: number | null; executedAt: string | null; sentAt: string | null } | null
  } | null
  emd: { buyer: EmdLine | null; contract: EmdLine | null }
  title: { company: string | null; email: string | null; routeStatus: string | null; routeMarket: string | null; status: string | null; introSentAt: string | null; openedAt: string | null; commitmentDue: When | null; clearToClose: boolean; escrowFile: string | null }
  contract: { status: string | null; executedAt: string | null; sentAt: string | null; signer: string | null; price: number | null; earnestMoney: number | null; envelope: string | null }
  money: {
    estimated: Partial<Record<'contractPrice' | 'buyerPrice' | 'assignmentFee' | 'closingCosts' | 'titleFees' | 'grossRevenue', Valued | null>>
    actual: { legs: SettlementLeg[]; assignmentFee: number | null; closingCosts: number | null; otherCosts: number | null; netProceeds: number | null } | null
    expectedFeeVsActual: { expected: number; actual: number | null } | null
  }
  documents: ClosingDoc[]
  timeline: TimelineEvent[]
  deadlines: Deadline[]
  updatedAt: string | null
  lastActivityAt: string | null
}

export interface Portfolio {
  items: Closing[]
  summary: { counts: { active: number; needsYou: number; waitingExternal: number; ready: number; closed: number; cancelled: number }; nextClosing: { id: string; address: string | null; closing: Closing['closing']; state: Closing['state'] } | null }
  degraded: Array<{ source: string; error: string }>
  sort: string
  recentDays: number
  generatedAt: string
}
export interface ActivityItem { id: string; type: string; actor: string | null; source: string | null; detail: Record<string, unknown>; at: string }
export interface Room { closing: Closing; activity: ActivityItem[]; activityMore: boolean; degraded: Array<{ source: string; error: string }> }

const BASE = '/api/cockpit/closing-desk/execution'

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<{ ok: boolean; data: T; error?: string }>(path, { signal, timeoutMs: 30_000 })
  // callBackend reports ok for any parsed body — the envelope's own ok decides.
  if (!res.ok) throw new Error((res as { error?: string }).error || 'closing_desk_unavailable')
  if (!res.data?.ok || !res.data.data) throw new Error(res.data?.error || 'closing_desk_unavailable')
  return res.data.data
}

export const fetchPortfolio = (sort: string, signal?: AbortSignal) => read<Portfolio>(`${BASE}?sort=${encodeURIComponent(sort)}`, signal)
export const fetchRoom = (id: string, before?: string | null, signal?: AbortSignal) =>
  read<Room>(`${BASE}/${encodeURIComponent(id)}${before ? `?activity_before=${encodeURIComponent(before)}` : ''}`, signal)

/* ── demo (labelled, lazy, never a fallback) ── */
interface DemoFile { now: string; portfolio: Portfolio; activity: Record<string, ActivityItem[]> }
let demoCache: Promise<DemoFile> | null = null
const loadDemo = () => (demoCache ??= import('./closing-demo.generated.json').then((m) => (m.default ?? m) as unknown as DemoFile))
export const isDemoMode = () => {
  try { const q = new URLSearchParams(window.location.search); return q.get('demo') === '1' || q.get('fixture') === '1' } catch { return false }
}
export async function fetchDemoPortfolio(): Promise<Portfolio> { return (await loadDemo()).portfolio }
export async function fetchDemoRoom(id: string): Promise<Room> {
  const demo = await loadDemo()
  const closing = demo.portfolio.items.find((x) => x.id === id)
  if (!closing) throw new Error('closing_not_found')
  return { closing, activity: demo.activity[id] ?? [], activityMore: false, degraded: [] }
}
export const demoNow = async () => Date.parse((await loadDemo()).now)
