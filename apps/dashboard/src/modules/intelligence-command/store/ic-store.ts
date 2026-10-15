/**
 * INTELLIGENCE COMMAND STORE — one store for the full-screen app and the
 * composer overlay (one intelligence system, many surfaces).
 *
 * Conversations ARE the agent's ask threads (agent/ask/ask-store): the same
 * runs the dock shows, followed over the same SSE stream, re-read from the
 * same durable run by id. This store adds only what Intelligence Command
 * owns: the section, the composer (mode, draft, chips, ↑ history), the Act
 * entries (capability invocations → approvals), and the plane reads
 * (capabilities, approvals, missions, runtime status, shadow, Quick Scan
 * history, platform health). Every read keeps its own truthful failure.
 */
import { useSyncExternalStore } from 'react'
import { parseSlash, type MentionChip } from '../../agent/ask/ask-model'
import { activeThread, ask, getAsk, newThread, openThread, stopTurn } from '../../agent/ask/ask-store'
import { fetchLiveHistory, liveFailureCopy, type LiveHistoryRow } from '../../agent/runtime/live-transport'
import {
  createMission as createMissionCall, decideApproval, fetchCapabilities, fetchMissions, fetchPlatformHealth, fetchRuntimeStatus, fetchShadow, getApproval, invokeCapability, listApprovals,
  type CapabilityApproval, type CapabilityDescriptor, type InvokeOutcome, type PlaneFailure, type PlaneResult, type RuntimeMission, type RuntimeStatus, type ShadowPage,
} from '../api/ic-client'
import { decideMessage } from '../model/act-model'
import { EMPTY_HISTORY, PLAN_COMMAND, historyNext, historyPrev, pushHistory, type ComposerMode, type History } from '../model/composer-model'
import { EMPTY_CHIPS, addManual, clearManual, reconcile, removeChip, toMentionChips, type ChipState, type IcChip, type PageContext } from '../model/context-model'
import { DECIDE_CODE_LABEL } from '../../agent/approvals/approvals-transport'

export type Section = 'conversations' | 'shadow' | 'missions' | 'research' | 'findings' | 'approvals' | 'activity' | 'workforce' | 'health'
export const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'conversations', label: 'Conversations' },
  { id: 'missions', label: 'Missions' },
  { id: 'research', label: 'Research' },
  { id: 'findings', label: 'Findings' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'activity', label: 'Activity' },
  { id: 'workforce', label: 'Agent workforce' },
  { id: 'health', label: 'System health' },
]

export interface Load<T> { phase: 'idle' | 'loading' | 'ready' | 'failed'; data: T | null; failure: PlaneFailure | null; at: number | null }
const idle = <T>(): Load<T> => ({ phase: 'idle', data: null, failure: null, at: null })

export type ActPhase = 'invoking' | 'pending' | 'deciding' | 'executed' | 'denied' | 'refused' | 'failed' | 'done'
export interface ActEntry {
  id: string
  threadId: string | null
  capability_id: string
  title: string
  reason: string
  createdAt: number
  phase: ActPhase
  outcome: InvokeOutcome | null
  approval: CapabilityApproval | null
  failure: PlaneFailure | null
  note: string | null
}

export type InspectorTarget = { kind: 'turn'; threadId: string; turnId: string } | { kind: 'act'; id: string } | { kind: 'approval'; id: string } | { kind: 'mission'; id: string } | { kind: 'shadow'; id: string } | null

export interface IcState {
  section: Section
  overlay: boolean
  mode: ComposerMode
  draft: string
  chips: ChipState
  history: History
  /** composer mode per ask turn id (Ask vs Plan framing) */
  turnModes: Record<string, ComposerMode>
  acts: ActEntry[]
  inspector: InspectorTarget
  expanded: Record<string, boolean>
  focusTick: number
  capabilities: Load<CapabilityDescriptor[]>
  approvals: Load<CapabilityApproval[]>
  missions: Load<RuntimeMission[]>
  runtime: Load<RuntimeStatus>
  shadow: Load<ShadowPage>
  quickScans: Load<LiveHistoryRow[]>
  health: Load<InvokeOutcome>
  missionNote: string | null
}

const KEY = 'lc.ic.v1'
const HISTORY_KEY = 'lc.ic.history.v1'

const INITIAL: IcState = {
  section: 'conversations', overlay: false, mode: 'ask', draft: '', chips: EMPTY_CHIPS, history: EMPTY_HISTORY, turnModes: {}, acts: [], inspector: null, expanded: {}, focusTick: 0,
  capabilities: idle(), approvals: idle(), missions: idle(), runtime: idle(), shadow: idle(), quickScans: idle(), health: idle(), missionNote: null,
}

let state: IcState = INITIAL
let hydrated = false
const listeners = new Set<() => void>()

function persist() {
  try {
    const { section, mode, turnModes, acts } = state
    window.sessionStorage.setItem(KEY, JSON.stringify({ v: 1, section, mode, turnModes, acts: acts.slice(0, 40) }))
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.items))
  } catch { /* private mode */ }
}

function hydrate() {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(KEY) || 'null') as Partial<IcState> & { v?: number } | null
    const items = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]') as unknown
    if (raw?.v === 1) {
      // an act that was in flight when the page went away is re-read from the server below, never assumed
      state = { ...state, section: raw.section ?? state.section, mode: raw.mode ?? 'ask', turnModes: raw.turnModes ?? {}, acts: (raw.acts ?? []).map((a) => (a.phase === 'invoking' || a.phase === 'deciding' ? { ...a, phase: a.approval ? 'pending' : 'failed', note: a.approval ? 'Re-reading the approval after a reload.' : 'The page reloaded before the server answered; nothing is assumed.' } : a)) }
    }
    if (Array.isArray(items)) state = { ...state, history: { ...EMPTY_HISTORY, items: items.map(String).slice(0, 50) } }
  } catch { /* corrupt → clean */ }
  for (const a of state.acts) if (a.approval && a.phase === 'pending') void refreshAct(a.id)
}

function set(patch: Partial<IcState> | ((s: IcState) => Partial<IcState>), save = true) {
  hydrate()
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  if (save) persist()
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => { hydrate(); return state }
export const useIc = (): IcState => useSyncExternalStore(subscribe, snapshot, () => INITIAL)
export const getIc = snapshot

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/* ── navigation + overlay ──────────────────────────────────────────────── */

export function setSection(section: Section) { set({ section }) }
export function setOverlay(on: boolean) { set((s) => ({ overlay: on, focusTick: on ? s.focusTick + 1 : s.focusTick }), false) }
export function toggleOverlay() { setOverlay(!getIc().overlay) }
export function focusComposer() { set((s) => ({ focusTick: s.focusTick + 1 }), false) }
export function inspect(target: InspectorTarget) { set({ inspector: target }, false) }
export function toggleExpanded(key: string) { set((s) => ({ expanded: { ...s.expanded, [key]: !s.expanded[key] } }), false) }

/* ── composer ─────────────────────────────────────────────────────────── */

export function setMode(mode: ComposerMode) { set({ mode }) }
export function setDraft(draft: string) { set((s) => ({ draft, history: s.history.cursor === null ? s.history : s.history }), false) }
export function syncContext(page: PageContext) {
  const s = getIc()
  const next = reconcile(s.chips, page, s.draft.trim().length > 0)
  if (next !== s.chips) set({ chips: next }, false)
}
export function dropChip(page: PageContext, chip: IcChip) { set((s) => ({ chips: removeChip(s.chips, page, chip) }), false) }
export function mentionChip(chip: IcChip) { set((s) => ({ chips: addManual(s.chips, chip) }), false) }
export function historyUp() { const s = getIc(); const r = historyPrev(s.history, s.draft); set({ history: r.h, draft: r.text }, false) }
export function historyDown() { const s = getIc(); const r = historyNext(s.history, s.draft); set({ history: r.h, draft: r.text }, false) }

/**
 * Ask / Plan: one real research run through the shared ask store. Returns
 * the turn id (the run id arrives when the server accepts it).
 */
export function sendQuestion(chips: IcChip[], opts: { text?: string; mode?: Exclude<ComposerMode, 'act'> } = {}): string | null {
  const s = getIc()
  const text = (opts.text ?? s.draft).trim()
  const mode = opts.mode ?? (s.mode === 'act' ? 'ask' : s.mode)
  const slash = parseSlash(text)
  const command = mode === 'plan' ? PLAN_COMMAND : slash.command
  const body = mode === 'plan' ? text : slash.command ? slash.rest : text
  if (!body.trim() && !command) return null
  const mentions: MentionChip[] = toMentionChips(chips)
  void ask({ text: body, command, chips: mentions })
  // ask() appends the turn synchronously before awaiting the POST
  const turn = activeThread(getAsk())?.turns.at(-1) ?? null
  set((st) => ({
    draft: opts.text !== undefined ? st.draft : '',
    history: pushHistory(st.history, text),
    chips: clearManual(st.chips),
    turnModes: turn ? { ...st.turnModes, [turn.id]: mode } : st.turnModes,
    section: 'conversations',
    inspector: turn ? { kind: 'turn', threadId: activeThread(getAsk())!.id, turnId: turn.id } : st.inspector,
  }))
  return turn?.id ?? null
}

export function retryTurn(threadId: string, turnId: string) {
  const t = getAsk().threads.find((x) => x.id === threadId)
  const u = t?.turns.find((x) => x.id === turnId)
  if (!t || !u) return
  if (getAsk().activeThreadId !== threadId) openThread(threadId)
  const mode = getIc().turnModes[turnId] === 'plan' ? 'plan' : 'ask'
  const command = mode === 'plan' ? PLAN_COMMAND : u.command ? parseSlash(`/${u.command} `).command : null
  void ask({ text: u.text, command, chips: u.chips })
  const turn = activeThread(getAsk())?.turns.at(-1) ?? null
  if (turn && turn.id !== turnId) set((st) => ({ turnModes: { ...st.turnModes, [turn.id]: mode }, inspector: { kind: 'turn', threadId, turnId: turn.id } }))
}

export const cancelTurn = (threadId: string, turnId: string) => stopTurn(threadId, turnId)
export function startNewConversation() { newThread(); set((s) => ({ section: 'conversations', inspector: null, chips: clearManual(s.chips), focusTick: s.focusTick + 1 })) }
export function openConversation(id: string) { openThread(id); set({ section: 'conversations', inspector: null }) }

/* ── loads ─────────────────────────────────────────────────────────────── */

type LoadKey = 'capabilities' | 'approvals' | 'missions' | 'runtime' | 'shadow' | 'health'
const inflight = new Map<string, Promise<void>>()
function load<K extends LoadKey>(key: K, fn: () => Promise<PlaneResult<NonNullable<IcState[K]['data']>>>): Promise<void> {
  const prior = inflight.get(key)
  if (prior) return prior
  set((s) => ({ [key]: { ...s[key], phase: s[key].data ? s[key].phase : 'loading' } }) as Partial<IcState>, false)
  const p = (async () => {
    const r = await fn()
    set(() => ({ [key]: r.ok ? { phase: 'ready', data: r.data, failure: null, at: Date.now() } : { phase: 'failed', data: null, failure: r, at: Date.now() } }) as Partial<IcState>, false)
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export const refreshCapabilities = () => load('capabilities', () => fetchCapabilities())
export const refreshApprovals = () => load('approvals', () => listApprovals('pending'))
export const refreshMissions = () => Promise.all([load('missions', () => fetchMissions()), load('runtime', () => fetchRuntimeStatus())]).then(() => undefined)
export const refreshShadow = () => load('shadow', () => fetchShadow(50))
export const refreshHealth = () => load('health', () => fetchPlatformHealth())

export async function refreshQuickScans() {
  set((s) => ({ quickScans: { ...s.quickScans, phase: s.quickScans.data ? s.quickScans.phase : 'loading' } }), false)
  const r = await fetchLiveHistory()
  set({ quickScans: r.ok ? { phase: 'ready', data: r.data, failure: null, at: Date.now() } : { phase: 'failed', data: null, failure: { ok: false, state: r.status === 404 ? 'not_enabled' : 'error', status: r.status, code: r.code, message: liveFailureCopy(r), next: r.status === 404 ? 'Quick Scan history needs AGENT_LIVE_ROUTES=1 (production: the pilot flags + AGENT_STORE=postgres).' : null }, at: Date.now() } }, false)
}

/** Queue a persistent runtime mission through missions.create (only kinds with a server handler). */
export async function createMission(kind: string) {
  set({ missionNote: null }, false)
  const r = await createMissionCall(kind)
  const note = !r.ok ? r.message
    : r.data.ok ? `Queued ${kind} · job ${String((r.data.result as { job_id?: string } | null)?.job_id ?? '—')}${r.data.status === 'replayed' ? ' (already queued this hour)' : ''}`
    : `Refused: ${r.data.code ?? r.data.status}`
  set({ missionNote: note }, false)
  void refreshMissions()
}

/* ── Act: capability → approval → decide ──────────────────────────────── */

function patchAct(id: string, patch: Partial<ActEntry>) { set((s) => ({ acts: s.acts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })) }

export async function proposeAct(input: { capability_id: string; title: string; input: Record<string, unknown>; reason: string }): Promise<string> {
  const threadId = getAsk().activeThreadId
  const entry: ActEntry = { id: uid('act'), threadId, capability_id: input.capability_id, title: input.title, reason: input.reason, createdAt: Date.now(), phase: 'invoking', outcome: null, approval: null, failure: null, note: null }
  set((s) => ({ acts: [entry, ...s.acts].slice(0, 40), inspector: { kind: 'act', id: entry.id }, section: 'conversations', draft: '', history: pushHistory(s.history, input.reason) }))
  const r = await invokeCapability(input.capability_id, input.input)
  if (!r.ok) { patchAct(entry.id, { phase: 'failed', failure: r, note: r.message }); return entry.id }
  const o = r.data
  if (o.status === 'approval_pending' && o.approval_id) {
    patchAct(entry.id, { outcome: o, phase: 'pending', note: o.deduped ? 'The identical proposal was already pending — this is that approval.' : null })
    const a = await getApproval(o.approval_id)
    if (a.ok) patchAct(entry.id, { approval: a.data })
    else patchAct(entry.id, { note: `The approval was created but could not be read back (${a.code}).` })
    void refreshApprovals()
  } else if (o.ok) patchAct(entry.id, { outcome: o, phase: 'done' })
  else patchAct(entry.id, { outcome: o, phase: 'refused', note: `Refused by the server: ${o.code ?? o.status}` })
  return entry.id
}

export async function refreshAct(id: string) {
  const a = getIc().acts.find((x) => x.id === id)
  if (!a?.approval) return
  const r = await getApproval(a.approval.approval_id)
  if (r.ok) patchAct(id, { approval: r.data, phase: r.data.state === 'pending' ? 'pending' : r.data.state === 'executed' ? 'executed' : r.data.state === 'denied' ? 'denied' : a.phase === 'deciding' ? 'pending' : 'refused' })
}

/**
 * Decide EXACTLY the approval that was rendered: its approval_id and the
 * payload_hash the server issued for it. The result shown is the server's.
 */
export async function decide(approval: CapabilityApproval, decision: 'approve' | 'deny', actId: string | null = null): Promise<string> {
  if (actId) patchAct(actId, { phase: 'deciding' })
  const r = await decideApproval({ approval_id: approval.approval_id, payload_hash: approval.payload_hash }, decision)
  const note = r.ok ? decideMessage(decision, r.data, DECIDE_CODE_LABEL) : r.message
  if (actId) {
    patchAct(actId, { note, phase: !r.ok ? 'pending' : r.data.code ? 'pending' : decision === 'deny' ? 'denied' : r.data.ok ? 'executed' : 'refused' })
    await refreshAct(actId)
    patchAct(actId, { note })
  }
  void refreshApprovals()
  return note
}

/* ── presence inputs ──────────────────────────────────────────────────── */

export function pendingCount(s: IcState = snapshot()): number | null {
  return s.approvals.phase === 'ready' ? s.approvals.data?.length ?? 0 : null
}

/** test hook */
export function __resetIc() { state = INITIAL; hydrated = true; inflight.clear() }
