/**
 * ASK STORE — threads of research questions for this browser session.
 *
 * A thread is a list of turns; each turn is ONE server run (POST /ask). The
 * durable truth is the agent store on the server: a turn keeps only its
 * run_id plus the last snapshot for an instant re-render, and is re-read from
 * GET /ask/:run_id when opened or while it runs. The step timeline grows as
 * the server writes audit rows (poll ~1.2s); the answer arrives when the run
 * ends and is revealed progressively (instant under reduced motion).
 *
 * Stop: the research route has no cancel endpoint, so Stop detaches this
 * client from the run (the server run ends inside its own caps: ≤ 4 min,
 * ≤ $2.50); Resume re-attaches. This is said in the UI, not hidden.
 */
import { useSyncExternalStore } from 'react'
import { composeAsk, isBlockingFailure, isTerminalRun, threadTitle, type AskFailure, type AskRun, type AskStatus, type MentionChip, type SlashCommand, type SlashId } from './ask-model'
import { fetchAskRun, fetchAskStatus, postAsk } from './ask-transport'

export type TurnPhase = 'sending' | 'running' | 'done' | 'stopped' | 'failed'
export interface AskTurn {
  id: string
  runId: string | null
  text: string
  command: SlashId | null
  chips: MentionChip[]
  question: string
  notes: string[]
  sentAt: number
  phase: TurnPhase
  failure: AskFailure | null
  run: AskRun | null
  /** the answer arrived in this page session (reveal it) */
  fresh?: boolean
}
export interface AskThread { id: string; title: string; createdAt: number; updatedAt: number; turns: AskTurn[] }

export interface StatusSlot { phase: 'idle' | 'loading' | 'ready' | 'failed'; data: AskStatus | null; failure: AskFailure | null; at: number | null }

export interface AskState {
  status: StatusSlot
  threads: AskThread[]
  activeThreadId: string | null
  view: 'thread' | 'history'
  palette: boolean
  /** composer chips (explicit mentions) */
  chips: MentionChip[]
  /** auto-attached chip keys the operator removed (until the selection changes) */
  dismissedAuto: string[]
  /** display labels learned from typeahead (property id → address) */
  labels: Record<string, string>
  /** bumps when a composer should take focus */
  focus: { tick: number; target: 'dock' | 'palette' }
}

const KEY = 'lc.agent.ask.v1'
const MAX_THREADS = 30
const MAX_TURNS = 20

const INITIAL: AskState = { status: { phase: 'idle', data: null, failure: null, at: null }, threads: [], activeThreadId: null, view: 'thread', palette: false, chips: [], dismissedAuto: [], labels: {}, focus: { tick: 0, target: 'dock' } }

let state: AskState = INITIAL
let hydrated = false
const listeners = new Set<() => void>()
const loops = new Map<string, { stop: boolean; ctl: AbortController | null }>()

function persist() {
  try {
    const { threads, activeThreadId, chips, labels } = state
    window.sessionStorage.setItem(KEY, JSON.stringify({ v: 1, threads: threads.slice(0, MAX_THREADS), activeThreadId, chips, labels }))
  } catch { /* private mode / quota */ }
}

function hydrate() {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(KEY) || 'null') as { v?: number; threads?: AskThread[]; activeThreadId?: string | null; chips?: MentionChip[]; labels?: Record<string, string> } | null
    if (raw?.v === 1) {
      const threads = (raw.threads ?? []).map((t) => ({ ...t, turns: t.turns.map((u) => ({ ...u, fresh: false, phase: u.phase === 'sending' ? ('failed' as const) : u.phase, failure: u.phase === 'sending' ? { kind: 'unavailable' as const, status: 0, code: 'INTERRUPTED', message: 'The page reloaded before the server answered.' } : u.failure })) }))
      state = { ...state, threads, activeThreadId: raw.activeThreadId ?? null, chips: raw.chips ?? [], labels: raw.labels ?? {} }
    }
  } catch { /* corrupt → start clean */ }
  // re-attach to runs that were still running
  for (const t of state.threads) for (const u of t.turns) if (u.phase === 'running' && u.runId) poll(t.id, u.id, u.runId)
}

function set(patch: Partial<AskState> | ((s: AskState) => Partial<AskState>), save = true) {
  hydrate()
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  if (save) persist()
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => { hydrate(); return state }
export function useAsk(): AskState { return useSyncExternalStore(subscribe, snapshot, () => INITIAL) }
export const getAsk = snapshot

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function patchTurn(threadId: string, turnId: string, patch: Partial<AskTurn>) {
  set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, updatedAt: Date.now(), turns: t.turns.map((u) => (u.id === turnId ? { ...u, ...patch } : u)) } : t)) }))
}

/* ── status (models, caps, spend) ───────────────────────────────────────── */

let statusInflight: Promise<void> | null = null
export function refreshStatus(): Promise<void> {
  if (statusInflight) return statusInflight
  set((s) => ({ status: { ...s.status, phase: s.status.data ? s.status.phase : 'loading' } }), false)
  statusInflight = (async () => {
    const r = await fetchAskStatus()
    if (r.ok) set({ status: { phase: 'ready', data: r.data, failure: null, at: Date.now() } }, false)
    else set((s) => ({ status: { phase: 'failed', data: isBlockingFailure(r.failure) ? null : s.status.data, failure: r.failure, at: Date.now() } }), false)
  })().finally(() => { statusInflight = null })
  return statusInflight
}

/* ── threads ────────────────────────────────────────────────────────────── */

export function activeThread(s: AskState = snapshot()): AskThread | null {
  return s.threads.find((t) => t.id === s.activeThreadId) ?? null
}
export function newThread() { set({ activeThreadId: null, view: 'thread', chips: [] }); requestFocus() }
export function openThread(id: string) {
  set({ activeThreadId: id, view: 'thread' })
  // re-read finished turns from the durable store (answers may have landed after a stop)
  const t = activeThread()
  for (const u of t?.turns ?? []) if (u.runId && (u.phase === 'stopped' || !u.run || !isTerminalRun(u.run))) void refreshTurn(t!.id, u.id)
}
export function showHistory(on: boolean) { set({ view: on ? 'history' : 'thread' }, false) }
export function deleteThread(id: string) { set((s) => ({ threads: s.threads.filter((t) => t.id !== id), activeThreadId: s.activeThreadId === id ? null : s.activeThreadId })) }

export function setChips(chips: MentionChip[]) { set({ chips }) }
export function dismissAuto(key: string) { set((s) => ({ dismissedAuto: [...new Set([...s.dismissedAuto, key])] }), false) }
export function resetDismissedAuto() { if (state.dismissedAuto.length) set({ dismissedAuto: [] }, false) }
export function learnLabels(map: Record<string, string>) { set((s) => ({ labels: { ...s.labels, ...map } })) }

export function setPalette(on: boolean) { set((s) => ({ palette: on, focus: on ? { tick: s.focus.tick + 1, target: 'palette' } : s.focus }), false) }
export function requestFocus(target: 'dock' | 'palette' = 'dock') { set((s) => ({ focus: { tick: s.focus.tick + 1, target } }), false) }

/* ── asking ─────────────────────────────────────────────────────────────── */

export async function ask(input: { text: string; command: SlashCommand | null; chips: MentionChip[] }): Promise<void> {
  hydrate()
  let thread = activeThread()
  const prev = thread?.turns[thread.turns.length - 1] ?? null
  const req = composeAsk({ text: input.text, command: input.command, chips: input.chips, previousQuestion: prev ? prev.text || prev.question : null })
  if (!req.question.trim()) return
  const turn: AskTurn = { id: uid('turn'), runId: null, text: input.text.trim(), command: input.command?.id ?? null, chips: input.chips, question: req.question, notes: req.notes, sentAt: Date.now(), phase: 'sending', failure: null, run: null }
  if (!thread) {
    thread = { id: uid('thr'), title: threadTitle(input.text, turn.command, input.chips), createdAt: Date.now(), updatedAt: Date.now(), turns: [] }
    const t = thread
    set((s) => ({ threads: [t, ...s.threads].slice(0, MAX_THREADS), activeThreadId: t.id }))
  }
  const threadId = thread.id
  set((s) => ({ view: 'thread', threads: s.threads.map((t) => (t.id === threadId ? { ...t, updatedAt: Date.now(), turns: [...t.turns, turn].slice(-MAX_TURNS) } : t)) }))
  const r = await postAsk(req.question, req.context)
  if (!r.ok) {
    patchTurn(threadId, turn.id, { phase: 'failed', failure: r.failure })
    if (isBlockingFailure(r.failure)) set({ status: { phase: 'failed', data: null, failure: r.failure, at: Date.now() } }, false)
    return
  }
  patchTurn(threadId, turn.id, { runId: r.data.run_id, phase: 'running' })
  poll(threadId, turn.id, r.data.run_id)
}

async function refreshTurn(threadId: string, turnId: string) {
  const u = state.threads.find((t) => t.id === threadId)?.turns.find((x) => x.id === turnId)
  if (!u?.runId) return
  const r = await fetchAskRun(u.runId)
  if (!r.ok) return
  const terminal = isTerminalRun(r.data)
  patchTurn(threadId, turnId, { run: r.data, ...(terminal && u.phase !== 'done' ? { phase: 'done', fresh: false } : {}) })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function poll(threadId: string, turnId: string, runId: string) {
  const prior = loops.get(turnId)
  if (prior) prior.stop = true
  const loop = { stop: false, ctl: null as AbortController | null }
  loops.set(turnId, loop)
  void (async () => {
    const t0 = Date.now()
    let misses = 0
    while (!loop.stop) {
      loop.ctl = new AbortController()
      const r = await fetchAskRun(runId, loop.ctl.signal)
      if (loop.stop) break
      if (r.ok) {
        misses = 0
        if (isTerminalRun(r.data)) {
          patchTurn(threadId, turnId, { run: r.data, phase: 'done', fresh: true })
          void refreshStatus()
          break
        }
        patchTurn(threadId, turnId, { run: r.data })
      } else {
        misses += 1
        if (isBlockingFailure(r.failure) || r.failure.code === 'RUN_NOT_FOUND' || misses >= 8) {
          patchTurn(threadId, turnId, { phase: 'failed', failure: r.failure })
          break
        }
      }
      // 4.5 min: past the server's own 4-minute run timeout — stop watching
      if (Date.now() - t0 > 270_000) { patchTurn(threadId, turnId, { phase: 'stopped' }); break }
      await sleep(Date.now() - t0 < 20_000 ? 1200 : 2500)
    }
    if (loops.get(turnId) === loop) loops.delete(turnId)
  })()
}

/** Stop watching (there is no server cancel for research runs; the run ends inside its caps). */
export function stopTurn(threadId: string, turnId: string) {
  const l = loops.get(turnId)
  if (l) { l.stop = true; l.ctl?.abort() }
  patchTurn(threadId, turnId, { phase: 'stopped' })
}
export function resumeTurn(threadId: string, turnId: string) {
  const u = state.threads.find((t) => t.id === threadId)?.turns.find((x) => x.id === turnId)
  if (!u?.runId) return
  patchTurn(threadId, turnId, { phase: 'running' })
  poll(threadId, turnId, u.runId)
}
export function markRevealed(threadId: string, turnId: string) { patchTurn(threadId, turnId, { fresh: false }) }

export const runningTurn = (s: AskState = snapshot()): { thread: AskThread; turn: AskTurn } | null => {
  for (const t of s.threads) for (const u of t.turns) if (u.phase === 'running' || u.phase === 'sending') return { thread: t, turn: u }
  return null
}

/** test hook */
export function __resetAsk() { for (const l of loops.values()) l.stop = true; loops.clear(); state = INITIAL; hydrated = true }
