/**
 * AGENT STORE — runs, their event logs, and the dock / workspace UI state.
 *
 * Two transports, one view half:
 *
 *  · FIXTURE (S2, SIMULATED) — each run is an authored scenario (fixtures/)
 *    whose events become visible at their recorded offset from the run's
 *    start. Operator controls are appended to the record and the fixture
 *    "server" re-derives the log (fixture-kit applyControls).
 *
 *  · LIVE (S3, READ-ONLY) — the run is created by the server (Quick Scan,
 *    $0, AI off). The client holds a cursor (the last applied event_id) and
 *    long-polls `events?after=<cursor>` (live-transport.ts). Events are
 *    applied exactly once, in event_id order. The log is cached in
 *    sessionStorage so a reload re-renders instantly from cache, then the
 *    server snapshot is checked and the stream resumes from the cursor —
 *    nothing is replayed twice and nothing is invented while offline.
 *
 * Both feed the same pure reducers (model/), so a live row and a fixture row
 * render through the same components — the only difference the UI shows is
 * the provenance label (LIVE · READ-ONLY vs SIMULATED), which is derived from
 * the record mode and re-checked against the events (`fixture: true` events
 * are refused on the live channel).
 *
 * Persistence: run records + UI live in sessionStorage (survive navigation
 * and reload); dock width / panel sizes are per-device prefs in localStorage.
 */
import { useSyncExternalStore } from 'react'
import type { AgentEvent, ResearchDepth, RunKind } from '../contracts/contracts'
import { applyControls, materialize, lastT, type FixtureControl, type ScenarioId, type SyntheticProperty } from '../fixtures/fixture-kit'
import { FIXTURES_AVAILABLE, getScenario, hasScenario } from '../fixtures'
import { applyResearchEvent, emptyResearch, isTerminal, type ResearchView } from '../model/research-model'
import { applyRunEvent, emptyRun, runIsTerminal, type RunView } from '../model/run-model'
import { toSourceRef, type SourceRef } from '../model/evidence-class'
import {
  confirmQuickScan, fetchEvents, fetchLiveHistory, fetchSnapshot, liveFailureCopy, preflightQuickScan, probeLive, requestLiveCancel,
  type LiveCapability, type LivePreflight, type LiveSourceDescriptor, type LiveToolDescriptor,
} from './live-transport'

/* ── records ─────────────────────────────────────────────────────────── */

export type RunMode = 'fixture' | 'live'

/** Transport state of a live run — shown verbatim (never as research progress). */
export type LiveStatus = 'starting' | 'connecting' | 'streaming' | 'reconnecting' | 'complete' | 'lost' | 'refused' | 'failed_to_start'

export interface LiveMeta {
  /** the server's run id (null until POST returns) */
  serverRunId: string | null
  status: LiveStatus
  error: string | null
  /** last applied event_id — the replay cursor */
  cursor: number
  propertyIds: string[]
  addresses: Array<string | null>
  originApp: string | null
  originLabel: string | null
  sources: LiveSourceDescriptor[]
  tools: LiveToolDescriptor[]
  retries: number
  lastContactAt: number | null
  clientRequestId: string
  /** a cancel was posted; the UI waits for run.cancelled / job.cancelled */
  cancelPosted: boolean
}

export interface RunRecord {
  runId: string
  mode: RunMode
  scenarioId: ScenarioId | null
  startWall: number
  controls: FixtureControl[]
  operatorText: string | null
  parentRunId: string | null
  createdAt: number
  eventIdBase: number
  /** dev/capture only: hold playback at this offset */
  frozenT: number | null
  handledIntents: number[]
  live: LiveMeta | null
}

export type DockMode = 'closed' | 'open' | 'spine'
export type WorkspaceLayout = 'cover' | 'beside' | 'fullscreen'
export type CenterTab = 'activity' | 'sources' | 'brief'
export type InspectorTab = 'property' | 'evidence' | 'cost'

/** What a run's view was showing — restored when the operator comes back to it. */
export interface RunUiMemory { focusPropertyId: string | null; centerTab: CenterTab; inspectorTab: InspectorTab; selectedSourceKey: string | null; selectedFindingId: string | null }

/** The mission preflight being composed (nothing runs until Launch). */
export type Preflight =
  | {
    kind: 'live-quick'; propertyIds: string[]; addresses: Array<string | null>; originApp: string | null; originLabel: string | null
    /** the server's draft (POST …/quick-scan/preflight) — what Launch confirms, exactly */
    status: 'loading' | 'ready' | 'error' | 'launching'; server: LivePreflight | null; error: string | null
  }
  | null

export interface AgentUi {
  dock: DockMode
  dockWidth: number
  composer: string
  wsOpen: boolean
  wsLayout: WorkspaceLayout
  leftW: number
  rightW: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  centerTab: CenterTab
  inspectorTab: InspectorTab
  activeRunId: string | null
  dockRunId: string | null
  focusPropertyId: string | null
  selectedSourceKey: string | null
  selectedFindingId: string | null
  /** a confirmation sheet for cancel, by run */
  confirmCancel: string | null
  /** the batch pre-run draft (null = not composing) */
  batchDraft: { count: number; depth: 'quick' | 'deep' | 'diligence' } | null
  preflight: Preflight
  runUi: Record<string, RunUiMemory>
}

const RUNS_KEY = 'lc.agent.runs.v2'
const UI_KEY = 'lc.agent.ui.session.v2'
const PREFS_KEY = 'lc.agent.prefs.v1'
const LOG_KEY = (runId: string) => `lc.agent.live.log.v1.${runId}`
const LOG_CAP = 4000

const DEFAULT_UI: AgentUi = {
  dock: 'closed', dockWidth: 420, composer: '', wsOpen: false, wsLayout: 'cover', leftW: 296, rightW: 404, leftCollapsed: false, rightCollapsed: false,
  centerTab: 'activity', inspectorTab: 'property', activeRunId: null, dockRunId: null, focusPropertyId: null, selectedSourceKey: null, selectedFindingId: null, confirmCancel: null, batchDraft: null,
  preflight: null, runUi: {},
}
const PREF_KEYS = ['dockWidth', 'leftW', 'rightW', 'leftCollapsed', 'rightCollapsed'] as const

function readJson<T>(storage: 'local' | 'session', key: string): T | null {
  try { const s = storage === 'local' ? window.localStorage : window.sessionStorage; const v = s.getItem(key); return v ? (JSON.parse(v) as T) : null } catch { return null }
}
function writeJson(storage: 'local' | 'session', key: string, value: unknown) {
  try { const s = storage === 'local' ? window.localStorage : window.sessionStorage; s.setItem(key, JSON.stringify(value)) } catch { /* private mode / quota */ }
}
function removeKey(key: string) { try { window.sessionStorage.removeItem(key) } catch { /* ignore */ } }

/* ── state ───────────────────────────────────────────────────────────── */

interface Derived { key: string; events: AgentEvent[]; end: number }
interface ViewSlot { count: number; research: ResearchView | null; run: RunView | null; key: string }

let runs: RunRecord[] = []
let ui: AgentUi = DEFAULT_UI
const derived = new Map<string, Derived>()
const views = new Map<string, ViewSlot>()
/** live run logs (event_id ascending, deduplicated) */
const liveLogs = new Map<string, AgentEvent[]>()
/** events at or below this id were replayed on hydration (no arrival animation) */
const arrivalFloor = new Map<string, number>()
let version = 0
let timer: ReturnType<typeof setInterval> | null = null
let hydrated = false
const listeners = new Set<() => void>()
const emit = () => { version += 1; listeners.forEach((l) => l()) }

function persist() {
  writeJson('session', RUNS_KEY, runs)
  const sessionUi: Partial<AgentUi> = { ...ui }
  delete sessionUi.confirmCancel
  writeJson('session', UI_KEY, sessionUi)
  const prefs: Partial<AgentUi> = {}
  for (const k of PREF_KEYS) (prefs as Record<string, unknown>)[k] = ui[k]
  writeJson('local', PREFS_KEY, prefs)
}

let logWrite: ReturnType<typeof setTimeout> | null = null
const dirtyLogs = new Set<string>()
function persistLog(runId: string) {
  dirtyLogs.add(runId)
  if (logWrite) return
  logWrite = setTimeout(() => {
    logWrite = null
    for (const id of dirtyLogs) writeJson('session', LOG_KEY(id), (liveLogs.get(id) ?? []).slice(-LOG_CAP))
    dirtyLogs.clear()
  }, 250)
}

function normalizeRecord(r: Partial<RunRecord>): RunRecord | null {
  if (!r || !r.runId) return null
  const mode: RunMode = r.mode === 'live' ? 'live' : 'fixture'
  if (mode === 'fixture' && (!r.scenarioId || !hasScenario(r.scenarioId))) return null
  return {
    runId: r.runId, mode, scenarioId: r.scenarioId ?? null, startWall: r.startWall ?? Date.now(), controls: r.controls ?? [], operatorText: r.operatorText ?? null,
    parentRunId: r.parentRunId ?? null, createdAt: r.createdAt ?? Date.now(), eventIdBase: r.eventIdBase ?? 0, frozenT: r.frozenT ?? null, handledIntents: r.handledIntents ?? [], live: mode === 'live' ? (r.live ?? null) : null,
  }
}

function hydrate() {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  runs = (readJson<Array<Partial<RunRecord>>>('session', RUNS_KEY) ?? []).map(normalizeRecord).filter((r): r is RunRecord => Boolean(r))
  ui = { ...DEFAULT_UI, ...(readJson<Partial<AgentUi>>('local', PREFS_KEY) ?? {}), ...(readJson<Partial<AgentUi>>('session', UI_KEY) ?? {}), confirmCancel: null }
  if (!ui.runUi || typeof ui.runUi !== 'object') ui = { ...ui, runUi: {} }
  for (const r of runs) {
    if (r.mode === 'live') {
      const cached = (readJson<AgentEvent[]>('session', LOG_KEY(r.runId)) ?? []).filter((e) => e && !e.fixture)
      liveLogs.set(r.runId, cached)
      // a reload resumes from what was actually applied, never past it
      if (r.live) r.live = { ...r.live, cursor: cached.length ? cached[cached.length - 1].event_id : 0, status: r.live.status === 'starting' ? 'failed_to_start' : r.live.status, error: r.live.status === 'starting' ? 'The page reloaded before the server confirmed the run.' : r.live.error }
    }
    const slot = advance(r)
    // everything already visible at load is history, replayed instantly
    arrivalFloor.set(r.runId, slot ? lastEventId(slot) : 0)
  }
  ensureTimer()
  for (const r of runs) if (r.mode === 'live') ensureLive(r.runId)
  // a preflight open at reload is re-drafted; a launch in flight is found again through server history
  const pf = ui.preflight
  if (pf?.status === 'loading' || pf?.status === 'ready') queueMicrotask(() => { void requestPreflight() })
  else if (pf?.status === 'launching') { ui = { ...ui, preflight: { ...pf, status: 'error', error: 'The page reloaded while launching — the run, if it started, is listed under History.' } }; queueMicrotask(() => { void attachServerHistory() }) }
}

const lastEventId = (slot: ViewSlot) => slot.research?.last_event_id ?? slot.run?.last_event_id ?? 0

function derive(r: RunRecord): Derived {
  if (r.mode === 'live') {
    const events = liveLogs.get(r.runId) ?? []
    return { key: 'live', events, end: 0 }
  }
  const key = JSON.stringify(r.controls)
  const cur = derived.get(r.runId)
  if (cur && cur.key === key) return cur
  const scenario = getScenario(r.scenarioId!)
  const draft = applyControls(scenario, r.controls).map((e) =>
    e.type === 'message.operator' && r.operatorText ? { ...e, payload: { ...e.payload, text: r.operatorText } } : e)
  const next = { key, events: materialize(draft, r.runId, r.startWall, r.eventIdBase), end: lastT(draft) }
  derived.set(r.runId, next)
  return next
}

export const nowT = (r: RunRecord) => (r.frozenT !== null ? r.frozenT : Date.now() - r.startWall)

const kindOf = (r: RunRecord): RunKind => (r.mode === 'live' ? 'research' : getScenario(r.scenarioId!).kind)

/** Bring a run's view up to the events visible now. Returns the slot. */
function advance(r: RunRecord): ViewSlot | null {
  const d = derive(r)
  let count = 0
  if (r.mode === 'live') count = d.events.length
  else {
    const t = nowT(r)
    while (count < d.events.length && (d.events[count].fixture_t_ms ?? 0) <= t) count += 1
  }
  let slot = views.get(r.runId)
  const kind = kindOf(r)
  if (!slot || slot.key !== d.key || count < slot.count) {
    slot = { count: 0, key: d.key, research: kind === 'research' ? emptyResearch(r.runId) : null, run: kind === 'research' ? null : emptyRun(r.runId) }
  }
  if (count === slot.count) { views.set(r.runId, slot); return slot }
  let research = slot.research
  let run = slot.run
  for (let i = slot.count; i < count; i += 1) {
    const e = d.events[i]
    if (research) research = applyResearchEvent(research, e)
    if (run) {
      run = applyRunEvent(run, e)
      if (r.mode === 'fixture' && e.type === 'ui.intent' && !r.handledIntents.includes(e.event_id)) onIntent(r, e)
    }
  }
  slot = { count, key: d.key, research, run }
  views.set(r.runId, slot)
  return slot
}

function onIntent(r: RunRecord, e: AgentEvent) {
  r.handledIntents = [...r.handledIntents, e.event_id]
  const params = (e.payload.params ?? {}) as { scenario?: ScenarioId }
  if (e.payload.intent === 'open_research' && params.scenario) {
    // deferred: never mutate the store from inside a reduction pass
    queueMicrotask(() => { startRun(params.scenario!, { parentRunId: r.runId, open: 'workspace' }) })
  }
}

function playing(): boolean {
  return runs.some((r) => r.mode === 'fixture' && r.frozenT === null && (views.get(r.runId)?.count ?? 0) < derive(r).events.length)
}

function tick() {
  let changed = false
  for (const r of runs) {
    if (r.mode !== 'fixture') continue
    const before = views.get(r.runId)
    const after = advance(r)
    if (after !== before) changed = true
  }
  if (changed) emit()
  if (!playing() && timer) { clearInterval(timer); timer = null }
}

function ensureTimer() {
  if (timer || typeof window === 'undefined') return
  if (!playing()) return
  timer = setInterval(tick, 90)
}

/* ── per-run UI memory (seamless switching, state preserved) ─────────── */

function memoryOf(u: AgentUi): RunUiMemory {
  return { focusPropertyId: u.focusPropertyId, centerTab: u.centerTab, inspectorTab: u.inspectorTab, selectedSourceKey: u.selectedSourceKey, selectedFindingId: u.selectedFindingId }
}
const FRESH_MEMORY: RunUiMemory = { focusPropertyId: null, centerTab: 'activity', inspectorTab: 'property', selectedSourceKey: null, selectedFindingId: null }

/** Switch the workspace to a run, saving what the current run was showing and restoring the next one's. */
export function selectRun(runId: string | null, extra: Partial<AgentUi> = {}) {
  hydrate()
  const runUi = { ...ui.runUi }
  if (ui.activeRunId) runUi[ui.activeRunId] = memoryOf(ui)
  const next = runId ? runUi[runId] ?? FRESH_MEMORY : FRESH_MEMORY
  ui = { ...ui, ...next, runUi, activeRunId: runId, preflight: null, confirmCancel: null, ...extra }
  persist(); emit()
}

/* ── fixture commands ────────────────────────────────────────────────── */

let seq = 0
export function startRun(scenarioId: ScenarioId, opts: { operatorText?: string | null; parentRunId?: string | null; open?: 'workspace' | 'dock' | null } = {}): string {
  hydrate()
  if (!FIXTURES_AVAILABLE) return ''
  seq += 1
  const now = Date.now()
  const runId = `fx-run-${scenarioId}-${now.toString(36)}-${seq}`
  const rec: RunRecord = { runId, mode: 'fixture', scenarioId, startWall: now, controls: [], operatorText: opts.operatorText ?? null, parentRunId: opts.parentRunId ?? null, createdAt: now, eventIdBase: (runs.length + 1) * 100_000, frozenT: null, handledIntents: [], live: null }
  runs = [rec, ...runs]
  arrivalFloor.set(runId, 0)
  const kind = getScenario(scenarioId).kind
  if (kind === 'research') {
    advance(rec)
    selectRun(runId, { batchDraft: null, ...(opts.open === 'workspace' ? { wsOpen: true } : {}) })
  } else {
    ui = { ...ui, dockRunId: runId, ...(opts.open === 'workspace' ? { wsOpen: true } : {}) }
    if (opts.open === 'workspace') selectRun(runId)
    advance(rec)
  }
  persist()
  ensureTimer()
  emit()
  return runId
}

export function controlRun(runId: string, control: FixtureControl['kind'], extra: Record<string, string> = {}) {
  const r = runs.find((x) => x.runId === runId)
  if (!r) return
  if (r.mode === 'live') {
    if (control === 'cancel') void cancelLive(runId)
    return
  }
  const t = Math.round(nowT(r))
  r.controls = [...r.controls, { kind: control, t, ...extra } as FixtureControl]
  advance(r)
  persist()
  ensureTimer()
  emit()
}

export function removeRun(runId: string) {
  const r = runs.find((x) => x.runId === runId)
  if (r?.mode === 'live') { stopLive(runId); liveLogs.delete(runId); removeKey(LOG_KEY(runId)) }
  runs = runs.filter((x) => x.runId !== runId)
  derived.delete(runId); views.delete(runId); arrivalFloor.delete(runId)
  const runUi = { ...ui.runUi }; delete runUi[runId]
  ui = { ...ui, runUi }
  if (ui.activeRunId === runId) ui = { ...ui, ...FRESH_MEMORY, activeRunId: runs.find((x) => kindOf(x) === 'research')?.runId ?? null }
  if (ui.dockRunId === runId) ui = { ...ui, dockRunId: null }
  persist(); emit()
}

export function setUi(patch: Partial<AgentUi> | ((cur: AgentUi) => Partial<AgentUi>)) {
  hydrate()
  const next = typeof patch === 'function' ? patch(ui) : patch
  ui = { ...ui, ...next }
  persist()
  emit()
}

/** Dev/capture: move a fixture run's clock to `t` (and optionally hold it there). */
export function seekRun(runId: string, t: number, hold = false) {
  const r = runs.find((x) => x.runId === runId)
  if (!r || r.mode !== 'fixture') return
  if (hold) r.frozenT = t
  else { r.frozenT = null; r.startWall = Date.now() - t; derived.delete(runId); views.delete(runId) }
  advance(r); persist(); ensureTimer(); emit()
}

export function resetAgent() {
  for (const r of runs) if (r.mode === 'live') { stopLive(r.runId); removeKey(LOG_KEY(r.runId)) }
  runs = []; derived.clear(); views.clear(); arrivalFloor.clear(); liveLogs.clear()
  ui = { ...DEFAULT_UI, dockWidth: ui.dockWidth, leftW: ui.leftW, rightW: ui.rightW }
  persist(); emit()
}

/* ── live: capability ────────────────────────────────────────────────── */

export interface CapabilityState { status: 'unknown' | 'checking' | 'available' | 'unavailable'; data: LiveCapability | null; reason: string | null; checkedAt: number | null }
let capability: CapabilityState = { status: 'unknown', data: null, reason: null, checkedAt: null }

export async function refreshLiveCapability(): Promise<CapabilityState> {
  if (capability.status === 'checking') return capability
  capability = { ...capability, status: 'checking' }
  emit()
  const res = await probeLive()
  capability = res.ok
    ? (res.data.live && res.data.quick_scan
      ? { status: 'available', data: res.data, reason: null, checkedAt: Date.now() }
      : { status: 'unavailable', data: res.data, reason: res.data.reason ?? 'Live Quick Scan is switched off on this API.', checkedAt: Date.now() })
    : { status: 'unavailable', data: null, reason: liveFailureCopy(res), checkedAt: Date.now() }
  emit()
  return capability
}
export function getCapability(): CapabilityState { return capability }
export function useLiveCapability(): CapabilityState { useAgentVersion(); return capability }

/* ── live: runs ──────────────────────────────────────────────────────── */

export function openLivePreflight(input: { propertyIds: string[]; addresses: Array<string | null>; originApp: string | null; originLabel: string | null }) {
  hydrate()
  const runUi = { ...ui.runUi }
  if (ui.activeRunId) runUi[ui.activeRunId] = memoryOf(ui)
  ui = { ...ui, runUi, wsOpen: true, preflight: { kind: 'live-quick', ...input, status: 'loading', server: null, error: null }, confirmCancel: null }
  persist(); emit()
  if (capability.status === 'unknown' || capability.status === 'unavailable') void refreshLiveCapability()
  void requestPreflight()
}

/** Ask the server to draft the job for the exact selection (nothing executes). */
export async function requestPreflight() {
  const pf = ui.preflight
  if (!pf) return
  const ids = pf.propertyIds
  ui = { ...ui, preflight: { ...pf, status: 'loading', error: null } }
  emit()
  const res = await preflightQuickScan(ids)
  const cur = ui.preflight
  if (!cur || cur.propertyIds.join('|') !== ids.join('|')) return // superseded
  ui = { ...ui, preflight: res.ok ? { ...cur, status: 'ready', server: res.data, error: null } : { ...cur, status: 'error', server: null, error: liveFailureCopy(res) } }
  persist(); emit()
}

/** Dismiss the preflight. A server draft is cancelled so it never lingers as a pending job. */
export function dismissPreflight() {
  const pf = ui.preflight
  ui = { ...ui, preflight: null }
  persist(); emit()
  if (pf?.server?.run_id) void requestLiveCancel(pf.server.run_id)
}

/** Confirm the previewed scope (scope hash must match) and follow the run. Returns the local run id. */
export async function launchLiveQuickScan(): Promise<string | null> {
  hydrate()
  const pf = ui.preflight
  if (!pf || pf.kind !== 'live-quick' || pf.status !== 'ready' || !pf.server?.can_run) return null
  const server = pf.server
  ui = { ...ui, preflight: { ...pf, status: 'launching' } }
  emit()
  const res = await confirmQuickScan(server.job_id, server.scope_hash)
  if (!res.ok) {
    const cur = ui.preflight
    if (cur) ui = { ...ui, preflight: { ...cur, status: 'error', error: liveFailureCopy(res) } }
    persist(); emit()
    return null
  }
  seq += 1
  const now = Date.now()
  const runId = `live-${now.toString(36)}-${seq}`
  const rec: RunRecord = {
    runId, mode: 'live', scenarioId: null, startWall: now, controls: [], operatorText: null, parentRunId: null, createdAt: now, eventIdBase: 0, frozenT: null, handledIntents: [],
    live: { serverRunId: res.data.run_id, status: 'connecting', error: null, cursor: 0, propertyIds: server.property_ids.length ? server.property_ids : pf.propertyIds, addresses: (server.property_ids.length ? server.property_ids : pf.propertyIds).map((id) => pf.addresses[pf.propertyIds.indexOf(id)] ?? null), originApp: pf.originApp, originLabel: pf.originLabel, sources: server.sources, tools: server.tools, retries: 0, lastContactAt: null, clientRequestId: server.job_id, cancelPosted: false },
  }
  runs = [rec, ...runs]
  liveLogs.set(runId, [])
  arrivalFloor.set(runId, 0)
  advance(rec)
  selectRun(runId, { wsOpen: true, centerTab: 'activity', inspectorTab: 'property' })
  ensureLive(runId)
  return runId
}

/** Attach live runs the server knows about but this tab does not (new tab, cleared session). */
export async function attachServerHistory(): Promise<number> {
  hydrate()
  const res = await fetchLiveHistory()
  if (!res.ok) return 0
  let added = 0
  for (const row of res.data.slice(0, 10)) {
    if (runs.some((r) => r.live?.serverRunId === row.run_id)) continue
    seq += 1
    const created = row.created_at ? Date.parse(row.created_at) : Date.now()
    const runId = `live-h-${row.run_id.slice(-10)}-${seq}`
    runs = [...runs, {
      runId, mode: 'live', scenarioId: null, startWall: created, controls: [], operatorText: null, parentRunId: null, createdAt: created, eventIdBase: 0, frozenT: null, handledIntents: [],
      live: { serverRunId: row.run_id, status: 'connecting', error: null, cursor: 0, propertyIds: [], addresses: [], originApp: null, originLabel: 'Server history', sources: capability.data?.sources ?? [], tools: capability.data?.tools ?? [], retries: 0, lastContactAt: null, clientRequestId: row.run_id, cancelPosted: false },
    }]
    liveLogs.set(runId, [])
    arrivalFloor.set(runId, Number.MAX_SAFE_INTEGER) // history replays without arrival motion
    added += 1
  }
  runs.sort((a, b) => b.createdAt - a.createdAt)
  persist(); emit()
  for (const r of runs) if (r.mode === 'live') ensureLive(r.runId)
  return added
}

const loops = new Map<string, AbortController>()
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const id = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(id); resolve() }, { once: true })
})

function patchLive(runId: string, patch: Partial<LiveMeta>) {
  const r = runs.find((x) => x.runId === runId)
  if (!r?.live) return
  r.live = { ...r.live, ...patch }
  persist(); emit()
}

/** Apply a page of server events exactly once (idempotent on event_id). */
export function appendLiveEvents(runId: string, events: AgentEvent[]): number {
  const r = runs.find((x) => x.runId === runId)
  if (!r?.live) return 0
  const log = liveLogs.get(runId) ?? []
  const cursor = log.length ? log[log.length - 1].event_id : 0
  const fresh = events.filter((e) => e.event_id > cursor && !e.fixture).sort((a, b) => a.event_id - b.event_id)
  const unique: AgentEvent[] = []
  let last = cursor
  for (const e of fresh) if (e.event_id > last) { unique.push(e); last = e.event_id }
  if (!unique.length) return 0
  const next = log.concat(unique)
  liveLogs.set(runId, next)
  r.live = { ...r.live, cursor: last, lastContactAt: Date.now() }
  advance(r)
  persistLog(runId)
  persist()
  emit()
  return unique.length
}

function liveTerminal(runId: string): boolean {
  const slot = views.get(runId)
  return Boolean(slot?.research && isTerminal(slot.research))
}

function ensureLive(runId: string) {
  const r = runs.find((x) => x.runId === runId)
  if (!r?.live?.serverRunId || loops.has(runId)) return
  if (['lost', 'refused', 'failed_to_start'].includes(r.live.status)) return
  if (r.live.status === 'complete' && liveTerminal(runId)) return
  const ctl = new AbortController()
  loops.set(runId, ctl)
  void liveLoop(runId, ctl.signal).finally(() => { if (loops.get(runId) === ctl) loops.delete(runId) })
}

function stopLive(runId: string) { loops.get(runId)?.abort(); loops.delete(runId) }

async function liveLoop(runId: string, signal: AbortSignal) {
  const rec = () => runs.find((x) => x.runId === runId) ?? null
  const serverId = rec()?.live?.serverRunId
  if (!serverId) return
  // reload / resume: the server snapshot confirms the run still exists and
  // supplies its declared sources; the event replay below starts at the cursor
  const snap = await fetchSnapshot(serverId, signal)
  if (signal.aborted) return
  if (!snap.ok) {
    if (snap.code === 'RUN_NOT_FOUND') { patchLive(runId, { status: 'lost', error: liveFailureCopy(snap) }); return }
    if (snap.code === 'FIXTURE_ON_LIVE_CHANNEL') { patchLive(runId, { status: 'refused', error: liveFailureCopy(snap) }); return }
  } else {
    const cur = rec()?.live
    if (cur && !cur.propertyIds.length && snap.data.property_ids.length) patchLive(runId, { propertyIds: snap.data.property_ids, addresses: snap.data.property_ids.map(() => null) })
  }
  let backoff = 1000
  let rebuilt = false
  while (!signal.aborted) {
    const r = rec()
    if (!r?.live) return
    const hidden = typeof document !== 'undefined' && document.hidden
    const res = await fetchEvents(serverId, r.live.cursor, { timeoutMs: hidden ? 5000 : 20_000, signal })
    if (signal.aborted) return
    if (!res.ok) {
      if (res.code === 'RUN_NOT_FOUND') { patchLive(runId, { status: 'lost', error: liveFailureCopy(res) }); return }
      if (res.code === 'FIXTURE_ON_LIVE_CHANNEL') { patchLive(runId, { status: 'refused', error: liveFailureCopy(res) }); return }
      patchLive(runId, { status: 'reconnecting', error: liveFailureCopy(res), retries: r.live.retries + 1 })
      await sleep(backoff, signal)
      backoff = Math.min(15_000, backoff * 2)
      continue
    }
    backoff = 1000
    const applied = appendLiveEvents(runId, res.data.events)
    // a per-run seq gap means an event was missed: rebuild once from the start of the log
    const slot = views.get(runId)
    if (slot?.research?.gap && !rebuilt) {
      rebuilt = true
      liveLogs.set(runId, []); views.delete(runId); arrivalFloor.set(runId, 0)
      patchLive(runId, { cursor: 0 })
      continue
    }
    const terminal = res.data.done || liveTerminal(runId)
    if (terminal && !applied) { patchLive(runId, { status: 'complete', error: null }); return }
    const cur = rec()?.live
    if (cur && (cur.status !== 'streaming' || cur.error)) patchLive(runId, { status: 'streaming', error: null })
    // the server long-polls (timeout_ms); an empty page means it waited — a short guard keeps a fast-failing server from spinning
    if (!applied) await sleep(hidden ? 5000 : 400, signal)
  }
}

async function cancelLive(runId: string) {
  const r = runs.find((x) => x.runId === runId)
  if (!r?.live?.serverRunId || r.live.cancelPosted) return
  patchLive(runId, { cancelPosted: true })
  const res = await requestLiveCancel(r.live.serverRunId)
  if (!res.ok) patchLive(runId, { cancelPosted: false, error: `Cancel was not accepted: ${liveFailureCopy(res)}` })
}

/** Retry the stream after a transport stop (lost runs stay lost — the server no longer has them). */
export function reconnectLive(runId: string) {
  const r = runs.find((x) => x.runId === runId)
  if (!r?.live || r.live.status === 'lost' || r.live.status === 'refused') return
  patchLive(runId, { status: 'connecting', error: null })
  ensureLive(runId)
}

/* ── reads ───────────────────────────────────────────────────────────── */

const subscribe = (l: () => void) => { hydrate(); listeners.add(l); return () => { listeners.delete(l) } }
const getVersion = () => version

export function useAgentVersion(): number { return useSyncExternalStore(subscribe, getVersion, getVersion) }

export function getUi(): AgentUi { hydrate(); return ui }
export function useAgentUi(): AgentUi { useAgentVersion(); return ui }

export function useRuns(): RunRecord[] { useAgentVersion(); return runs }
export const getRuns = () => { hydrate(); return runs }

/** The subject of a run, as the UI may show it (synthetic fixtures say so). */
export interface SubjectProperty {
  property_id: string
  address: string
  city: string | null
  jurisdiction: string | null
  asset: string | null
  beds_baths: string | null
  sqft: number | null
  year_built: number | null
  owner_display: string | null
  synthetic: boolean
}

export interface RunSnapshot {
  record: RunRecord
  mode: RunMode
  research: ResearchView | null
  run: RunView | null
  visible: number
  total: number
  end: number
  arrivalFloor: number
  title: string
  subtitle: string
  depth: ResearchDepth | null
  properties: SubjectProperty[]
  sources: Record<string, SourceRef>
  /** work is still arriving (fixture still playing, or a live run not yet terminal) */
  active: boolean
  live: LiveMeta | null
}

const maskId = (id: string) => `••${id.replace(/[^a-z0-9]/gi, '').slice(-4)}`

function fixtureSubject(p: SyntheticProperty): SubjectProperty {
  return { property_id: p.property_id, address: p.address, city: p.city, jurisdiction: p.jurisdiction, asset: p.asset, beds_baths: p.beds_baths, sqft: p.sqft, year_built: p.year_built, owner_display: p.owner_display, synthetic: true }
}

const snapCache = new Map<string, { version: number; snap: RunSnapshot }>()

export function snapshotOf(runId: string | null): RunSnapshot | null {
  if (!runId) return null
  const record = runs.find((r) => r.runId === runId)
  if (!record) return null
  const hit = snapCache.get(runId)
  if (hit && hit.version === version) return hit.snap
  const slot = views.get(runId) ?? advance(record)
  if (!slot) return null
  const d = derive(record)
  let snap: RunSnapshot
  if (record.mode === 'fixture') {
    const s = getScenario(record.scenarioId!)
    const terminal = slot.research ? isTerminal(slot.research) : slot.run ? runIsTerminal(slot.run) : false
    snap = {
      record, mode: 'fixture', research: slot.research, run: slot.run, visible: slot.count, total: d.events.length, end: d.end, arrivalFloor: arrivalFloor.get(runId) ?? 0,
      title: s.title, subtitle: s.subtitle, depth: s.depth, properties: s.properties.map(fixtureSubject),
      sources: Object.fromEntries(s.sources.map((x) => [x.source_id, toSourceRef(x)])),
      active: !terminal && slot.count < d.events.length, live: null,
    }
  } else {
    const lv = record.live!
    const v = slot.research
    const props: SubjectProperty[] = lv.propertyIds.map((id, i) => {
      const pv = v?.properties[id]
      const addr = (pv && pv.display_address !== id ? pv.display_address : null) ?? lv.addresses[i] ?? `Property ${maskId(id)}`
      return { property_id: id, address: addr, city: null, jurisdiction: null, asset: null, beds_baths: null, sqft: null, year_built: null, owner_display: null, synthetic: false }
    })
    // properties the server reported that the client did not name (never expected, rendered honestly)
    for (const id of v?.propertyOrder ?? []) if (!lv.propertyIds.includes(id)) props.push({ property_id: id, address: v!.properties[id].display_address, city: null, jurisdiction: null, asset: null, beds_baths: null, sqft: null, year_built: null, owner_display: null, synthetic: false })
    const sources: Record<string, SourceRef> = {}
    for (const s of lv.sources) sources[s.source_id] = toSourceRef(s)
    for (const t of v?.tasks ?? []) if (t.source_id && !sources[t.source_id]) sources[t.source_id] = toSourceRef({ source_id: t.source_id, name: t.source_id })
    const terminal = v ? isTerminal(v) : false
    const transportDead = ['lost', 'refused', 'failed_to_start'].includes(lv.status)
    snap = {
      record, mode: 'live', research: v, run: null, visible: slot.count, total: slot.count, end: 0, arrivalFloor: arrivalFloor.get(runId) ?? 0,
      title: props.length === 1 ? props[0].address : `${props.length} properties`,
      subtitle: `${lv.originLabel ?? 'Selection'} · read-only · AI off`,
      depth: v?.depth ?? 'quick', properties: props, sources,
      active: !terminal && !transportDead, live: lv,
    }
  }
  snapCache.set(runId, { version, snap })
  return snap
}

export function useRunSnapshot(runId: string | null): RunSnapshot | null { useAgentVersion(); return snapshotOf(runId) }

/** The events visible now for a run (for detail drawers / tests). */
export function visibleEvents(runId: string): AgentEvent[] {
  const r = runs.find((x) => x.runId === runId)
  if (!r) return []
  const slot = views.get(runId)
  return derive(r).events.slice(0, slot?.count ?? 0)
}

/** Waiting on the operator: a scope to confirm, a question, a plan or an approval. */
export function isWaiting(s: RunSnapshot): boolean {
  return Boolean((s.research && (s.research.state === 'draft' || s.research.tasks.some((t) => t.state === 'needs_input'))) || (s.run && (s.run.state === 'awaiting_plan_approval' || s.run.items.some((i) => i.kind === 'approval' && i.state === 'requested'))))
}

/* ── dev hooks for the capture harness (DEV builds only) ─────────────── */

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __lcAgent?: unknown }).__lcAgent = {
    start: startRun, control: controlRun, seek: seekRun, setUi, reset: resetAgent, selectRun,
    preflight: openLivePreflight, launch: launchLiveQuickScan, capability: () => capability, probe: refreshLiveCapability, history: attachServerHistory,
    runs: () => getRuns().map((r) => ({ runId: r.runId, mode: r.mode, scenarioId: r.scenarioId, t: r.mode === 'fixture' ? nowT(r) : null, end: derive(r).end, live: r.live })),
    ui: () => getUi(),
    snapshot: (runId: string) => snapshotOf(runId),
    events: (runId: string) => visibleEvents(runId),
  }
}
