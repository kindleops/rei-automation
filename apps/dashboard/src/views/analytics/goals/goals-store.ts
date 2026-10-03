import { useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../../../components/auth/AuthProvider'
import { httpGoalsApi, STORE_MESSAGE, type GoalsApi } from './goals-api'
import { FALLBACK_CATALOGUE, mergeGoals, progressRequest, type CatalogueEntry, type Goal, type GoalProgress } from './goals-model'

/**
 * GOALS STORE — the operator's goals and where they persist.
 *
 *   local   always: written synchronously on every change, keyed by operator
 *           (`lc.analytics.goals.v1:<operator>`), so goals survive a reload
 *   server  /api/cockpit/analytics/goals once the PROPOSED analytics_goals
 *           migration is applied; until then the API answers
 *           goals_store_unavailable and goals stay on this device. The first
 *           time the server answers, device goals it does not hold (or holds
 *           at an older revision) are uploaded.
 *
 * Progress is separate: one shared read of /goals/progress for the active
 * goals, refreshed every 5 minutes while something on screen reads it. The
 * store never computes a value.
 */

export const LOCAL_PREFIX = 'lc.analytics.goals.v1:'
const PROGRESS_TTL = 5 * 60_000

export interface GoalsSnapshot {
  ready: boolean
  operatorKey: string | null
  goals: Goal[]
  catalogue: CatalogueEntry[]
  persistence: 'booting' | 'server' | 'local'
  note: string | null
  progress: { key: string; status: 'idle' | 'loading' | 'ready' | 'error'; byId: Record<string, GoalProgress>; at: number | null; error: string | null }
}

const EMPTY_PROGRESS: GoalsSnapshot['progress'] = { key: '', status: 'idle', byId: {}, at: null, error: null }
const EMPTY: GoalsSnapshot = { ready: false, operatorKey: null, goals: [], catalogue: [...FALLBACK_CATALOGUE], persistence: 'booting', note: null, progress: EMPTY_PROGRESS }

let snap: GoalsSnapshot = EMPTY
let deps: { api: GoalsApi; storage: Pick<Storage, 'getItem' | 'setItem'> | null } = { api: httpGoalsApi, storage: typeof localStorage === 'undefined' ? null : localStorage }
const listeners = new Set<() => void>()
const set = (patch: Partial<GoalsSnapshot>) => { snap = { ...snap, ...patch }; listeners.forEach((l) => l()) }
let progressCtl: AbortController | null = null

function readLocal(op: string): Goal[] {
  try {
    const raw = deps.storage?.getItem(LOCAL_PREFIX + op)
    const v = raw ? JSON.parse(raw) as { v?: number; goals?: Goal[] } : null
    return Array.isArray(v?.goals) ? v.goals.filter((g) => g && typeof g.goal_id === 'string' && typeof g.metric_id === 'string') : []
  } catch { return [] }
}
function writeLocal() {
  if (!snap.operatorKey) return
  try { deps.storage?.setItem(LOCAL_PREFIX + snap.operatorKey, JSON.stringify({ v: 1, goals: snap.goals })) } catch { /* private mode / quota: the server copy (if any) still holds */ }
}

/** Open the operator's goals: local first (instant), then the server. Safe to call again. */
export async function bootGoals(operatorKey: string, d?: Partial<typeof deps>): Promise<void> {
  if (d) deps = { ...deps, ...d }
  if (snap.ready && snap.operatorKey === operatorKey && !d) return
  const local = readLocal(operatorKey)
  snap = { ...EMPTY, ready: true, operatorKey, goals: local }
  listeners.forEach((l) => l())
  const r = await deps.api.list()
  if (snap.operatorKey !== operatorKey) return
  if (!r.ok) {
    set({ persistence: 'local', note: r.message, ...(r.catalogue?.length ? { catalogue: r.catalogue } : null) })
    return
  }
  const merged = mergeGoals(snap.goals, r.goals)
  const serverRev = new Map(r.goals.map((g) => [g.goal_id, g.revision]))
  const upload = merged.filter((g) => (serverRev.get(g.goal_id) ?? -1) < g.revision)
  set({ goals: merged, persistence: 'server', note: null, ...(r.catalogue.length ? { catalogue: r.catalogue } : null) })
  writeLocal()
  for (const g of upload) {
    const s = await deps.api.save(g)
    if (!s.ok && s.reason === 'conflict' && s.current) adopt(s.current)
  }
}

function adopt(g: Goal) {
  set({ goals: mergeGoals(snap.goals.filter((x) => x.goal_id !== g.goal_id), [g]) })
  writeLocal()
}

export type SaveOutcome = { ok: true; where: 'server' | 'device' } | { ok: false; message: string }

/** Create or update a goal (bumps its revision). Written to the device at once, then to the server when it is the store. */
export async function saveGoal(draft: Omit<Goal, 'revision' | 'updated_at' | 'status'> & Partial<Pick<Goal, 'revision' | 'status'>>): Promise<SaveOutcome> {
  const prev = snap.goals.find((g) => g.goal_id === draft.goal_id) ?? null
  const now = new Date().toISOString()
  const goal: Goal = { ...draft, status: draft.status ?? 'active', revision: (prev?.revision ?? 0) + 1, created_at: prev?.created_at ?? now, updated_at: now } as Goal
  const before = snap.goals
  set({ goals: mergeGoals(before.filter((g) => g.goal_id !== goal.goal_id), [goal]) })
  writeLocal()
  if (snap.persistence !== 'server') return { ok: true, where: 'device' }
  const r = await deps.api.save(goal)
  if (r.ok) { adopt(r.goal); return { ok: true, where: 'server' } }
  if (r.reason === 'conflict') { if (r.current) adopt(r.current); return { ok: false, message: 'A newer copy of this goal was saved in another session — it is shown now.' } }
  if (r.reason === 'store_unavailable' || r.reason === 'network') { set({ persistence: 'local', note: STORE_MESSAGE[r.reason] }); return { ok: true, where: 'device' } }
  set({ goals: before })
  writeLocal()
  return { ok: false, message: r.message }
}

/** Retire a goal (soft: status archived). */
export async function archiveGoal(goalId: string): Promise<SaveOutcome> {
  const g = snap.goals.find((x) => x.goal_id === goalId)
  if (!g) return { ok: true, where: 'device' }
  const now = new Date().toISOString()
  set({ goals: mergeGoals(snap.goals.filter((x) => x.goal_id !== goalId), [{ ...g, status: 'archived', revision: g.revision + 1, updated_at: now }]) })
  writeLocal()
  if (snap.persistence !== 'server') return { ok: true, where: 'device' }
  const r = await deps.api.archive(goalId)
  return r.ok ? { ok: true, where: 'server' } : { ok: true, where: 'device' }
}

/* ── progress ─────────────────────────────────────────────────────────── */

export const progressKey = (goals: ReadonlyArray<Goal>) => JSON.stringify(progressRequest(goals).map((g) => [g.goal_id, g.metric_id, g.market, g.period_kind, g.comparator, g.target_value, g.timezone]))

/** Read progress for the active goals when the set changed or the last read is stale. */
export async function refreshProgress(force = false): Promise<void> {
  const req = progressRequest(snap.goals)
  const key = progressKey(snap.goals)
  const p = snap.progress
  if (!force && p.key === key && (p.status === 'loading' || (p.status === 'ready' && p.at !== null && Date.now() - p.at < PROGRESS_TTL))) return
  if (!req.length) { set({ progress: { key, status: 'ready', byId: {}, at: Date.now(), error: null } }); return }
  progressCtl?.abort()
  const ctl = new AbortController()
  progressCtl = ctl
  set({ progress: { ...p, key, status: 'loading', error: null, byId: p.key === key ? p.byId : keepMatching(p.byId, req) } })
  const r = await deps.api.progress(req, ctl.signal)
  if (ctl.signal.aborted || snap.progress.key !== key) return
  if (!r.ok) { set({ progress: { ...snap.progress, status: 'error', error: r.message } }); return }
  set({ progress: { key, status: 'ready', byId: Object.fromEntries(r.goals.map((x) => [x.goal_id, x])), at: Date.now(), error: null } })
}
const keepMatching = (by: Record<string, GoalProgress>, req: Goal[]) => Object.fromEntries(req.filter((g) => by[g.goal_id] && by[g.goal_id].target === g.target_value).map((g) => [g.goal_id, by[g.goal_id]]))

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => snap
export const useGoalsStore = () => useSyncExternalStore(subscribe, get, get)
export const goalsNow = () => snap

/**
 * Goals for the signed-in operator, with progress kept current while
 * `active` (the reader is on screen). The effect only calls into the
 * external store — it never sets component state.
 */
export function useGoals(active = true): GoalsSnapshot {
  const { user } = useAuth()
  const op = user?.id ?? 'local'
  useEffect(() => { void bootGoals(op) }, [op])
  const s = useGoalsStore()
  const key = progressKey(s.goals)
  useEffect(() => {
    if (!active || !s.ready) return
    void refreshProgress()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshProgress() }, PROGRESS_TTL)
    return () => window.clearInterval(t)
  }, [active, s.ready, key])
  return s
}

export const __goalsStore = { reset: () => { snap = EMPTY; progressCtl = null; listeners.forEach((l) => l()) } }
