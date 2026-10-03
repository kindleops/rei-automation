/**
 * ANALYTICS GOALS — persistence + progress.
 *
 *   list(operator)            the operator's goals (active first)
 *   save(operator, goal)      create / update (revision-checked)
 *   archive(operator, id)     soft-retire a goal (status = archived; never a hard delete)
 *   progress(goals)           each goal's period-to-date from the Lab engine
 *
 * Operator-private: the operator is ALWAYS the one the Cloudflare Worker
 * verified (x-ops-user-id); a body or query never names it. Who may set
 * targets beyond "the signed-in, allowlisted operator, for themself" is an
 * open owner decision — nothing here grants a team-wide goal.
 *
 * The table is a PROPOSED migration
 * (supabase/migrations/PROPOSED_20261003190000_analytics_goals.sql). Until it
 * is applied every store call answers `goals_store_unavailable` (503) and the
 * dashboard keeps goals on the device, uploading them once the server answers.
 * `progress` needs no table: it evaluates goal definitions the client sends
 * (validated here) through the same Lab path Analytics reads.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { normalizeContext } from '../lab/query-contract.js'
import { runQuery } from '../lab/lab-service.js'
import { GOAL_TABLE, GoalError, MAX_GOALS, MAX_PROGRESS_GOALS, labContextFor, progressOf, validateGoal } from './goal-model.js'

const COLUMNS = 'goal_id, metric_id, label, market, market_label, period_kind, comparator, target_value, timezone, status, revision, created_at, updated_at'

export function isMissingTable(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (['42P01', 'PGRST205', 'PGRST204', '42703'].includes(code)) return true
  const m = String(error.message || '').toLowerCase()
  return m.includes('does not exist') || m.includes('schema cache') || m.includes('could not find the table')
}

const unavailable = (cause) => new GoalError('goals_store_unavailable', 503, 'Goal storage is not enabled yet.', { cause })
const fail = (error) => (isMissingTable(error) ? unavailable(error) : error)

export function operatorIdOf(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('x-ops-user-id') : null
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

export function createGoalService({ db = defaultSupabase, query = runQuery, now = () => Date.now() } = {}) {
  const table = () => db.from(GOAL_TABLE)

  async function list(operatorId) {
    const { data, error } = await table().select(COLUMNS).eq('operator_id', operatorId).order('updated_at', { ascending: false }).limit(MAX_GOALS * 2)
    if (error) throw fail(error)
    return data || []
  }

  async function current(operatorId, goalId) {
    const { data, error } = await table().select(COLUMNS).eq('operator_id', operatorId).eq('goal_id', goalId).maybeSingle()
    if (error) throw fail(error)
    return data || null
  }

  async function save(operatorId, raw) {
    const row = validateGoal(raw)
    const existing = await current(operatorId, row.goal_id)
    if (existing && Number(existing.revision) >= row.revision) {
      throw new GoalError('revision_conflict', 409, 'A newer copy of this goal was saved in another session.', { current: existing })
    }
    if (!existing) {
      const { count, error } = await table().select('goal_id', { count: 'exact', head: true }).eq('operator_id', operatorId).eq('status', 'active')
      if (error) throw fail(error)
      if ((count || 0) >= MAX_GOALS) throw new GoalError('too_many_goals', 400, `At most ${MAX_GOALS} active goals.`)
    }
    const stamp = new Date(now()).toISOString()
    const { data, error } = await table()
      .upsert({ ...row, operator_id: operatorId, updated_at: stamp, ...(existing ? {} : { created_at: stamp }) }, { onConflict: 'operator_id,goal_id' })
      .select(COLUMNS)
      .single()
    if (error) {
      // one active goal per metric × market × period (partial unique index)
      if (String(error.code) === '23505') throw new GoalError('duplicate_goal', 409, 'There is already an active goal for this metric, market and period.')
      throw fail(error)
    }
    return data
  }

  async function archive(operatorId, goalId) {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(goalId || ''))) throw new GoalError('invalid_goal', 400, 'goal_id is required')
    const existing = await current(operatorId, goalId)
    if (!existing) return { goal_id: goalId, archived: false }
    const { error } = await table().update({ status: 'archived', revision: Number(existing.revision) + 1, updated_at: new Date(now()).toISOString() }).eq('operator_id', operatorId).eq('goal_id', goalId)
    if (error) throw fail(error)
    return { goal_id: goalId, archived: true }
  }

  /** Progress for goal definitions (validated): one Lab read per goal, shared by the Lab's own result cache. */
  async function progress(rawGoals) {
    if (!Array.isArray(rawGoals)) throw new GoalError('invalid_goal', 400, 'goals must be a list')
    if (rawGoals.length > MAX_PROGRESS_GOALS) throw new GoalError('invalid_goal', 400, `at most ${MAX_PROGRESS_GOALS} goals per request`)
    const goals = rawGoals.map(validateGoal).filter((g) => g.status === 'active')
    const t = now()
    const out = await Promise.all(goals.map(async (goal) => {
      const ctxRaw = labContextFor(goal, t)
      if (Date.parse(ctxRaw.range.end) - Date.parse(ctxRaw.range.start) < 60_000) {
        return progressOf(goal, { status: 'no_data', value: null, reason: 'The period has just started.' }, { now: t })
      }
      try {
        const ctx = normalizeContext(ctxRaw, { now: t })
        const view = progressOf(goal, { status: 'unavailable' }, { now: t }).additive ? 'series' : 'metric'
        const r = await query(ctx, view)
        const cur = r?.metric?.cur ?? null
        return { ...progressOf(goal, cur, { now: t, series: view === 'series' ? r?.result : null }), data_as_of: r?.dataAsOf ?? null, definition_version: r?.version ?? null }
      } catch (error) {
        console.error('analytics.goal_progress_failed', goal.metric_id, error?.message || error)
        return progressOf(goal, { status: 'unavailable', value: null, reason: 'Analytics could not evaluate this metric right now.' }, { now: t })
      }
    }))
    return { generated_at: new Date(t).toISOString(), goals: out }
  }

  return { list, save, archive, progress }
}
