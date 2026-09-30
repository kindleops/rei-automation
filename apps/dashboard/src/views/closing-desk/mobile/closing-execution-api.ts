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
export interface RailStep { key: string; label: string; status: RailStatus; owner: Owner | null; detail: string; at: string | null; action: string | null; short?: string | null }
export interface Requirement { key: string; label: string; met: boolean; detail?: string | null; code?: string; owner?: Owner | null }
export interface Blocker { key: string; what: string; why: string; owner: Owner; ownerLabel: string; action: string }
/** Severity of an open item. Only blocking/overdue are blockers; the rest are open work. */
export type Severity = 'blocking' | 'overdue' | 'due_soon' | 'pending' | 'waiting' | 'resolved'
export type AttentionGroup = 'blocking' | 'overdue' | 'due_soon' | 'missing' | 'human_decision'
export interface Item { key: string; what: string; why: string | null; owner: Owner; ownerLabel: string | null; severity: Severity; group: AttentionGroup | null; action: string | null; requirement: string | null; requirements: string[] | null; at: string | null; dateOnly?: boolean; source: string | null }
/** The automation loop carrying an open step (the planner's own schedule). */
export interface Handling { category: string; key: string; label: string; why: string | null; party: string | null; sequence: number | null; at: string | null; queued: boolean; state: string; done: number; max: number | null; held: string | null }
export interface Ball { owner: Owner; ownerLabel: string | null; what: string; why: string | null; action: string | null; at: string | null; dateOnly?: boolean; blocker: boolean; source: string; waitingOn?: Owner | null; automation?: Handling | null; requirements?: string[] }
export interface Loop {
  category: string; key: string; label: string; why: string | null; party: string | null; state: string; reason: string | null
  done: number; max: number | null; next: { sequence: number; at: string } | null; escalateAt: string | null
  occupiedBy: { status: string; reason: string | null; at: string | null } | null
  inFlight: { sequence: number | null; status: string; at: string | null } | null
  latest: { sequence: number | null; status: string; reason: string | null; at: string | null; sentAt: string | null } | null
}
export interface ThreadRef { id: string | null; key: string | null; counterparty: string | null; email: string | null; lastAt: string | null; direction: string | null; preview: string | null; lastInboundAt: string | null; lastOutboundAt: string | null; needs: { code: string | null; reason: string | null } | null; takenOver: { by: string | null; at: string | null } | null }
export interface Cancellation { outcome: string; label: string; at: string | null; atSource: string | null; lastUpdatedAt: string | null; reason: string | null; actor: string | null; lastMilestone: { label: string; at: string } | null }
export type GroupKey = 'needs_you' | 'closing_today' | 'closing_soon' | 'waiting_seller' | 'waiting_buyer' | 'waiting_title' | 'waiting_lender' | 'system_handling' | 'ready' | 'closed' | 'cancelled'
export interface Runtime { automationEnabled: boolean | null; heartbeatAt: string | null; emailSendEnabled: boolean | null; emailSwitch?: { operator: boolean; deployment: boolean } }
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
  evidence?: string | null
  funding?: { status: string | null; fundedAmount: number | null; fundedAt: string | null; disbursedAmount: number | null; disbursedAt: string | null }
}
export interface ClosingDoc { key: string; label: string; party: string; status: string; source: string | null; reference: string | null; version?: number | null; at: string | null; requirement?: string | null }
export interface TimelineEvent { at: string; label: string; source: string; planned?: boolean; kind?: 'origin' | 'milestone' | 'event' | 'planned' | 'terminal' }
export type DeadlineState = 'upcoming' | 'due_today' | 'overdue' | 'satisfied' | 'cancelled' | 'superseded'
export interface Deadline extends When { key: string; label: string; met: boolean; overdue: boolean; field?: string; owner?: Owner; state?: DeadlineState; calendar?: { eventId: string; date: string } | null; supersededAt?: string | null; by?: string | null; reason?: string | null }

export interface Closing {
  id: string
  opportunityId: string | null
  propertyId: string | null
  masterOwnerId: string | null
  threadKey: string | null
  property: { address: string | null; line: string | null; city: string | null; state: string | null; zip: string | null; tz: string | null; tzConfident: boolean; addressSource?: 'closing_case' | 'property' | null }
  seller: { name: string | null; signerEmail: string | null }
  stage: { key: string; code: string; label: string; opportunityStage: string | null; diverged: boolean } | null
  terminal: boolean
  closed: boolean
  ready: boolean
  state: { key: string; label: string; tone: Tone }
  closing: (When & { confirmed: boolean; daysOut: number | null; past: boolean; source?: string | null; confirmedAt?: string | null; state?: DeadlineState; calendar?: { eventId: string; date: string } }) | null
  rowId?: string | null
  market?: string | null
  group?: GroupKey
  proximity?: { key: 'passed' | 'today' | 'tomorrow' | 'soon' | 'scheduled'; label: string } | null
  readiness?: { met: number; total: number }
  items?: Item[]
  ball?: Ball | null
  cancellation?: Cancellation | null
  deadlineHistory?: Deadline[]
  rail: RailStep[]
  requirements: Requirement[]
  blockers: Blocker[]
  next: { what: string; owner: Owner; ownerLabel: string | null; action: string | null; blocker: boolean } | null
  buyer: {
    id: string | null; offerId: string | null; name: string | null; selected: boolean; selectedAt: string | null
    committed: boolean; committedAt: string | null; commitmentStatus: string | null; offerStatus: string | null
    strategy: string | null; price: number | null; closingDate: string | null
    pof: { status: string | null; verifiedAt: string | null; expiresAt: string | null }
    agreement: { id: string | null; type: string | null; status: string | null; version: number | null; executedAt: string | null; sentAt: string | null; provider?: string | null; envelope?: string | null } | null
    selectedBy?: string | null
    commitmentType?: string | null
    thread?: ThreadRef | null
  } | null
  emd: { buyer: EmdLine | null; contract: EmdLine | null }
  title: {
    company: string | null; email: string | null; routeStatus: string | null; routeMarket: string | null; status: string | null; introSentAt: string | null; openedAt: string | null; commitmentDue: When | null; clearToClose: boolean; escrowFile: string | null
    contact?: string | null; selectedAt?: string | null; acknowledgedAt?: string | null; acknowledgedSource?: string | null; commitmentReceivedAt?: string | null; commitmentEvidence?: string | null
    ctc?: { at: string | null; source: string | null; evidence: string | null; actor: string | null } | null; legacyCtcFlag?: boolean; openIssues?: number; thread?: ThreadRef | null
  }
  contract: { status: string | null; executedAt: string | null; sentAt: string | null; signer: string | null; price: number | null; earnestMoney: number | null; envelope: string | null; acceptedAt?: string | null; effectiveAt?: string | null; docusignStatus?: string | null; inspectionDeadline?: When | null }
  money: {
    estimated: Partial<Record<'contractPrice' | 'buyerPrice' | 'assignmentFee' | 'closingCosts' | 'titleFees' | 'grossRevenue', Valued | null>>
    actual: { legs: SettlementLeg[]; assignmentFee: number | null; closingCosts: number | null; otherCosts: number | null; netProceeds: number | null; sellerAmount?: number | null; buyerAmount?: number | null } | null
    expectedFeeVsActual: { expected: number; actual: number | null } | null
    comparison?: Array<{ key: string; label: string; expected: number | null; actual: number | null; variance: number | null }>
    pendingSettlement?: Array<{ id: string | null; leg: string | null; status: string | null; funding: string | null; statementType: string | null; statementRef: string | null; provider: string | null }>
    statementReceived?: boolean
  }
  documents: ClosingDoc[]
  timeline: TimelineEvent[]
  deadlines: Deadline[]
  titleIssues?: Array<{ id: string; type: string; description: string | null; status: string; owner: string | null; source: string | null; evidence: string | null; openedAt: string | null; resolvedAt: string | null; label?: string; notes?: string | null; openedBy?: string | null; resolvedBy?: string | null; resolution?: string | null }>
  automation?: {
    paused: boolean; pausedReason: string | null; escalations: Array<{ category: string; at: string | null; message: string | null; reason?: string | null; active?: boolean }>; pendingEmails: number
    emails: Array<{ action: string; category: string; sequence: number; status: string; recipientRole: string; requestedAt: string | null; sentAt: string | null; reason: string | null; id?: string | null; label?: string; dueAt?: string | null; claimedAt?: string | null; delivery?: string | null; queueId?: string | null }>
    pausedAt?: string | null; pausedBy?: string | null; runtime?: Runtime & { heartbeatStale: boolean | null }; held?: string | null; state?: string; handling?: Handling | null; loops?: Loop[]
    interventions?: Array<{ type: string; actor: string | null; at: string | null; reason: string | null }>; workflow?: { key: string; runId: string | null }
  }
  terminalOutcome?: string | null
  finalize?: { ok: boolean; code: string; missing: string[]; blockers: Array<{ code: string; message: string; owner: string }> } | null
  updatedAt: string | null
  lastActivityAt: string | null
}

export interface AttentionEntry { closingId: string; address: string | null; key: string; what: string; why: string | null; owner: Owner; severity: Severity; requirement: string | null; requirements: string[] | null; at: string | null; dateOnly?: boolean }
export interface Portfolio {
  items: Closing[]
  summary: {
    counts: { active: number; needsYou: number; waitingExternal: number; ready: number; closed: number; cancelled: number; closingToday?: number; closingSoon?: number; systemHandling?: number; blocked?: number }
    nextClosing: { id: string; address: string | null; closing: Closing['closing']; state: Closing['state'] } | null
    groups?: Array<{ key: GroupKey; label: string; count: number }>
    attention?: Record<AttentionGroup, AttentionEntry[]>
  }
  runtime?: Runtime | null
  view?: 'full' | 'summary'
  degraded: Array<{ source: string; error: string }>
  sort: string
  recentDays: number
  generatedAt: string
}
/** The portfolio row the desktop navigation reads (view=summary). The room loads the full Closing. */
export type ClosingRow = Pick<Closing, 'id' | 'opportunityId' | 'propertyId' | 'masterOwnerId' | 'threadKey' | 'property' | 'stage' | 'terminal' | 'closed' | 'ready' | 'state' | 'closing' | 'updatedAt' | 'lastActivityAt'> & {
  rowId?: string | null; market?: string | null; group?: GroupKey; proximity?: Closing['proximity']; readiness?: { met: number; total: number }
  seller: { name: string | null }; buyer: { name: string | null; selected: boolean; committed: boolean } | null; title: { company: string | null; escrowFile: string | null }
  requirements: Array<{ key: string; label: string; met: boolean }>
  items?: Array<Pick<Item, 'key' | 'what' | 'owner' | 'severity' | 'group' | 'requirement' | 'requirements' | 'at' | 'dateOnly'>>
  ball?: (Pick<Ball, 'owner' | 'ownerLabel' | 'what' | 'why' | 'at'> & { waitingOn: Owner | null; automation: Pick<Handling, 'label' | 'sequence' | 'at' | 'why' | 'held'> | null }) | null
  money?: { expectedFee: number | null; actualNet: number | null; actualFee: number | null; closedAt: string | null }
  cancellation?: Cancellation | null
  automation?: { paused: boolean; held: string | null }
}
export interface PortfolioRows extends Omit<Portfolio, 'items'> { items: ClosingRow[] }
export interface StoredFile { id: string; filename: string | null; contentType: string | null; size: number | null; docType: string | null; review: string | null; stored: boolean; routedToCase: boolean; party: string | null; at: string | null; previewUrl: string | null }
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
/** Desktop navigation: the portfolio row projection (the room loads each closing by id). */
export const fetchPortfolioRows = (sort: string, signal?: AbortSignal) => read<PortfolioRows>(`${BASE}?sort=${encodeURIComponent(sort)}&view=summary`, signal)
/** Stored files for one closing (lazy — the Documents section asks when opened). */
export const fetchStoredFiles = (id: string, signal?: AbortSignal) => read<{ closingCaseId: string; files: StoredFile[]; degraded: Array<{ source: string; error: string }> }>(`${BASE}/${encodeURIComponent(id)}/documents`, signal)
export const fetchRoom = (id: string, before?: string | null, signal?: AbortSignal) =>
  read<Room>(`${BASE}/${encodeURIComponent(id)}${before ? `?activity_before=${encodeURIComponent(before)}` : ''}`, signal)

/* ── demo (labelled, lazy, never a fallback) ── */
interface DemoFile { now: string; portfolio: Portfolio; activity: Record<string, ActivityItem[]>; runtime?: Runtime }
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

/* ── writes: one authoritative server action each (closing-authority.js) ── */
export interface ActionResult { ok: boolean; code?: string; message?: string; blockers?: Array<{ code: string; message?: string; owner?: string }>; missing?: string[]; [k: string]: unknown }

export async function postClosingAction(id: string, action: string, fields: Record<string, unknown> = {}): Promise<ActionResult> {
  const res = await callBackend<{ ok: boolean; data: ActionResult }>(`${BASE}/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action, ...fields }),
    timeoutMs: 30_000,
  })
  if (!res.ok) {
    // A refused action (422) carries its structured reason in the upstream body.
    const body = (res.upstream as { data?: ActionResult } | undefined)?.data
    return body ?? { ok: false, code: 'REQUEST_FAILED', message: res.message || res.error || 'The server did not accept this action' }
  }
  return res.data?.data ?? { ok: false, code: 'EMPTY_RESPONSE' }
}
