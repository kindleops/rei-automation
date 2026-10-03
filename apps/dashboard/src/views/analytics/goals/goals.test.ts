import { beforeEach, describe, expect, it } from 'vitest'
import { analyticsPathFor, attentionRank, barGeometry, duplicateOf, formatValue, goalState, goalTerms, mergeGoals, progressRequest, FALLBACK_CATALOGUE, type Goal, type GoalProgress } from './goals-model'
import { __goalsStore, archiveGoal, bootGoals, goalsNow, refreshProgress, saveGoal, LOCAL_PREFIX } from './goals-store'
import type { GoalsApi } from './goals-api'
import { goalsDeckCommands } from './goals-commands'
import { decodeB64Url } from '../../../domain/analytics/analytics-lab-api'

const goal = (over: Partial<Goal> = {}): Goal => ({ goal_id: 'g_reach01', metric_id: 'sellers_reached', label: null, market: null, market_label: null, period_kind: 'month', comparator: 'at_least', target_value: 600, timezone: 'America/Chicago', status: 'active', revision: 1, updated_at: '2026-10-01T00:00:00Z', ...over })
const prog = (over: Partial<GoalProgress> = {}): GoalProgress => ({
  goal_id: 'g_reach01', metric_id: 'sellers_reached', unit: 'count', period: { kind: 'month', start: '2026-10-01T05:00:00.000Z', end: '2026-11-01T05:00:00.000Z', elapsed: 0.5, days_left: 15 },
  target: 600, comparator: 'at_least', status: 'ok', reason: null, current: 250, n: 250, min_sample: null, additive: true, pace: 300, projection: 500, projection_basis: 'x', share: 0.4167, verdict: 'behind', cumulative: null, ...over,
})

describe('goals model', () => {
  it('words the Lab status verbatim and never invents a verdict', () => {
    expect(goalState(prog()).label).toBe('Behind pace')
    expect(goalState(prog()).tone).toBe('attn')
    expect(goalState(prog({ verdict: 'met' })).tone).toBe('ok')
    const thin = goalState(prog({ status: 'insufficient_sample', verdict: null, n: 12, min_sample: 30, reason: 'Below the minimum sample.' }))
    expect(thin.label).toBe('Too few records to judge')
    expect(thin.detail).toContain('12 of 30')
    expect(goalState(prog({ status: 'unavailable', verdict: null })).tone).toBe('neutral')
  })
  it('a missed target is gold, never red', () => {
    for (const v of ['behind', 'at_risk', 'missed', 'not_met'] as const) expect(goalState(prog({ verdict: v })).tone).not.toBe('crit')
  })
  it('bar geometry clamps and draws pace only when the server gave one', () => {
    expect(barGeometry(prog())).toEqual({ fill: 250 / 600, pace: 0.5, over: false })
    expect(barGeometry(prog({ current: 900 })).over).toBe(true)
    expect(barGeometry(prog({ pace: null })).pace).toBeNull()
    expect(barGeometry(prog({ status: 'no_data', current: null })).fill).toBe(0)
  })
  it('formats counts and rates; null is a dash, never 0', () => {
    expect(formatValue(1234, 'count')).toBe('1,234')
    expect(formatValue(0.0825, 'rate')).toBe('8.3%')
    expect(formatValue(null, 'count')).toBe('—')
    expect(goalTerms(goal({ market_label: 'Minneapolis' }), FALLBACK_CATALOGUE)).toBe('at least 600 per month · Minneapolis')
  })
  it('ranks behind first, unknown next, on-pace last', () => {
    expect(attentionRank(prog())).toBe(0)
    expect(attentionRank(prog({ status: 'no_data', verdict: null }))).toBe(3)
    expect(attentionRank(prog({ verdict: 'on_pace' }))).toBe(4)
  })
  it('links to the same question in Analytics (metric, market filter, period)', () => {
    const path = analyticsPathFor(goal({ market: 'minneapolis-mn' }), prog())
    const ctx = decodeB64Url<Record<string, unknown>>(path.split('lab=')[1])!
    expect(ctx.metric).toBe('sellers_reached')
    expect(ctx.filters).toEqual([{ field: 'market', op: 'eq', value: 'minneapolis-mn' }])
    expect(ctx.range).toEqual({ preset: 'custom', start: '2026-10-01T05:00:00.000Z', end: '2026-11-01T05:00:00.000Z' })
  })
  it('merge keeps the higher revision; duplicates are caught before a write', () => {
    const merged = mergeGoals([goal({ revision: 3, target_value: 700 })], [goal({ revision: 2 }), goal({ goal_id: 'g_other01', metric_id: 'reply_rate' })])
    expect(merged.find((g) => g.goal_id === 'g_reach01')!.target_value).toBe(700)
    expect(merged).toHaveLength(2)
    expect(duplicateOf(merged, { goal_id: 'g_new0001', metric_id: 'sellers_reached', market: null, period_kind: 'month' })?.goal_id).toBe('g_reach01')
    expect(duplicateOf(merged, { goal_id: 'g_new0001', metric_id: 'sellers_reached', market: 'x', period_kind: 'month' })).toBeNull()
    expect(progressRequest([goal(), goal({ goal_id: 'g_arch001', status: 'archived' })])).toHaveLength(1)
  })
})

function memStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m } }
function fakeApi(mode: 'missing' | 'server'): GoalsApi & { saved: Goal[]; progressCalls: number } {
  const server: Goal[] = []
  const api = {
    saved: server, progressCalls: 0,
    async list() { return mode === 'missing' ? { ok: false as const, reason: 'store_unavailable' as const, message: 'Goals are kept on this device until server storage is enabled.', catalogue: null } : { ok: true as const, goals: [...server], catalogue: [] } },
    async save(g: Goal) { const i = server.findIndex((x) => x.goal_id === g.goal_id); if (i >= 0) server[i] = g; else server.push(g); return { ok: true as const, goal: g } },
    async archive() { return { ok: true } },
    async progress(goals: Goal[]) { api.progressCalls += 1; return { ok: true as const, generated_at: 'now', goals: goals.map((g) => prog({ goal_id: g.goal_id, target: g.target_value })) } },
  }
  return api
}

describe('goals store', () => {
  beforeEach(() => __goalsStore.reset())
  it('falls back to the device when the table is missing, and keeps writing locally', async () => {
    const storage = memStorage()
    const api = fakeApi('missing')
    await bootGoals('op-1', { api, storage })
    expect(goalsNow().persistence).toBe('local')
    const r = await saveGoal({ goal_id: 'g_reach01', metric_id: 'sellers_reached', label: null, market: null, market_label: null, period_kind: 'month', comparator: 'at_least', target_value: 600, timezone: 'America/Chicago' })
    expect(r).toEqual({ ok: true, where: 'device' })
    expect(JSON.parse(storage.m.get(`${LOCAL_PREFIX}op-1`)!).goals[0].target_value).toBe(600)
    expect(api.saved).toHaveLength(0)
    await archiveGoal('g_reach01')
    expect(goalsNow().goals[0].status).toBe('archived')
  })
  it('uploads device goals the first time the server answers', async () => {
    const storage = memStorage()
    storage.setItem(`${LOCAL_PREFIX}op-1`, JSON.stringify({ v: 1, goals: [goal({ revision: 2 })] }))
    const api = fakeApi('server')
    await bootGoals('op-1', { api, storage })
    expect(goalsNow().persistence).toBe('server')
    expect(api.saved.map((g) => g.goal_id)).toEqual(['g_reach01'])
  })
  it('reads progress once per goal set and keeps it by goal id', async () => {
    const api = fakeApi('server')
    await bootGoals('op-1', { api, storage: memStorage() })
    await saveGoal({ goal_id: 'g_reach01', metric_id: 'sellers_reached', label: null, market: null, market_label: null, period_kind: 'month', comparator: 'at_least', target_value: 600, timezone: 'America/Chicago' })
    await refreshProgress()
    await refreshProgress()
    expect(api.progressCalls).toBe(1)
    expect(goalsNow().progress.byId.g_reach01.current).toBe(250)
  })
})

describe('goals deck commands', () => {
  it('answers show / set goal with a metric and a period', () => {
    expect(goalsDeckCommands('goals')[0].route).toBe('/analytics?lens=goals')
    const r = goalsDeckCommands('set goal sellers reached monthly')
    expect(r[0].route).toBe('/analytics?lens=goals&goal=new&metric=sellers_reached&period=month')
    expect(goalsDeckCommands('new goal')[0].route).toBe('/analytics?lens=goals&goal=new')
    expect(goalsDeckCommands('xy')).toEqual([])
  })
})
