import { callBackend } from '../../../lib/api/backendClient'
import { encodeB64Url } from '../../../domain/analytics/analytics-lab-api'
import type { CatalogueEntry, Goal, GoalProgress } from './goals-model'

/**
 * Server persistence + progress for Goals — /api/cockpit/analytics/goals.
 *
 * Operator-private: the API scopes every read and write to the operator the
 * Worker verified (x-ops-user-id); the browser never names the operator.
 * Until the PROPOSED analytics_goals migration is applied the store answers
 * `goals_store_unavailable` and goals stay on this device (goals-store.ts).
 * Progress needs no table: it evaluates the definitions sent to it.
 */

export type StoreFailure = 'store_unavailable' | 'operator_unknown' | 'unauthorized' | 'network' | 'invalid' | 'duplicate'

export type ListResult =
  | { ok: true; goals: Goal[]; catalogue: CatalogueEntry[] }
  | { ok: false; reason: StoreFailure; message: string; catalogue: CatalogueEntry[] | null }

export type SaveResult =
  | { ok: true; goal: Goal }
  | { ok: false; reason: 'conflict'; current: Goal | null }
  | { ok: false; reason: StoreFailure; message: string }

export interface GoalsApi {
  list(): Promise<ListResult>
  save(goal: Goal): Promise<SaveResult>
  archive(goalId: string): Promise<{ ok: boolean; reason?: StoreFailure }>
  progress(goals: Goal[], signal?: AbortSignal): Promise<{ ok: true; goals: GoalProgress[]; generated_at: string } | { ok: false; message: string }>
}

const PATH = '/api/cockpit/analytics/goals'

type Body = { ok?: boolean; error?: string; message?: string; goals?: Goal[]; goal?: Goal; current?: Goal | null; catalogue?: CatalogueEntry[]; generated_at?: string }

export function reasonOf(status: number, body: Body | undefined): StoreFailure {
  const e = body?.error
  if (e === 'goals_store_unavailable') return 'store_unavailable'
  if (e === 'operator_unknown') return 'operator_unknown'
  if (e === 'invalid_goal') return 'invalid'
  if (e === 'duplicate_goal') return 'duplicate'
  if (status === 401 || status === 403) return 'unauthorized'
  return 'network'
}

export const STORE_MESSAGE: Record<StoreFailure, string> = {
  store_unavailable: 'Goals are kept on this device until server storage is enabled.',
  operator_unknown: 'Goals are kept on this device — the server could not identify the operator.',
  unauthorized: 'Goals are kept on this device — the server refused the request.',
  network: 'Goals are kept on this device — the server could not be reached.',
  invalid: 'The server rejected this goal.',
  duplicate: 'There is already an active goal for this metric, market and period.',
}

export const httpGoalsApi: GoalsApi = {
  async list() {
    const res = await callBackend<Body>(PATH, { timeoutMs: 20_000 })
    if (!res.ok) {
      const body = res.upstream as Body | undefined
      const reason = reasonOf(res.status, body)
      return { ok: false, reason, message: STORE_MESSAGE[reason], catalogue: Array.isArray(body?.catalogue) ? body.catalogue : null }
    }
    return { ok: true, goals: Array.isArray(res.data?.goals) ? res.data.goals : [], catalogue: Array.isArray(res.data?.catalogue) ? res.data.catalogue : [] }
  },
  async save(goal) {
    const res = await callBackend<Body>(PATH, { method: 'PUT', body: JSON.stringify({ goal }), headers: { 'content-type': 'application/json' }, timeoutMs: 20_000 })
    if (!res.ok) {
      const body = res.upstream as Body | undefined
      if (res.status === 409 && body?.error === 'revision_conflict') return { ok: false, reason: 'conflict', current: body?.current ?? null }
      const reason = reasonOf(res.status, body)
      return { ok: false, reason, message: body?.message || STORE_MESSAGE[reason] }
    }
    return res.data?.goal ? { ok: true, goal: res.data.goal } : { ok: false, reason: 'network', message: STORE_MESSAGE.network }
  },
  async archive(goalId) {
    const res = await callBackend<Body>(`${PATH}?goal_id=${encodeURIComponent(goalId)}`, { method: 'DELETE', timeoutMs: 20_000 })
    return res.ok ? { ok: true } : { ok: false, reason: reasonOf(res.status, res.upstream as Body | undefined) }
  },
  async progress(goals, signal) {
    if (!goals.length) return { ok: true, goals: [], generated_at: new Date().toISOString() }
    // only what the evaluation needs: the query string stays short for 24 goals
    const slim = goals.map((g) => ({ goal_id: g.goal_id, metric_id: g.metric_id, market: g.market, period_kind: g.period_kind, comparator: g.comparator, target_value: g.target_value, timezone: g.timezone, revision: g.revision }))
    const res = await callBackend<Body & { goals?: GoalProgress[] }>(`${PATH}/progress?goals=${encodeB64Url(slim)}`, { signal, timeoutMs: 120_000 })
    if (!res.ok || !res.data?.ok) return { ok: false, message: 'Goal progress could not be read from Analytics right now.' }
    return { ok: true, goals: (res.data.goals as unknown as GoalProgress[]) ?? [], generated_at: res.data.generated_at ?? new Date().toISOString() }
  },
}
