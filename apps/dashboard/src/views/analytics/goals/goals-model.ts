import { encodeB64Url } from '../../../domain/analytics/analytics-lab-api'
import type { LCTone } from '../../../shared/lc/states-model'

/**
 * ANALYTICS GOALS — client model (pure, tested).
 *
 * A goal is an operator-set TARGET on a canonical Analytics Lab metric, for a
 * recurring calendar period (week / month / quarter) and one market or all.
 * The UI never computes the value: progress comes from
 * GET /api/cockpit/analytics/goals/progress, which evaluates the goal through
 * the same Lab engine Analytics reads. This module only words and colours what
 * the server returned, and builds the Analytics link for the same question.
 */

export type PeriodKind = 'week' | 'month' | 'quarter'
export type Comparator = 'at_least' | 'at_most'
export type GoalStatus = 'ok' | 'no_data' | 'insufficient_sample' | 'unavailable' | 'not_applicable'
export type Verdict = 'met' | 'on_pace' | 'behind' | 'at_risk' | 'missed' | 'not_met' | 'in_progress' | 'within'

export interface Goal {
  goal_id: string
  metric_id: string
  label: string | null
  market: string | null
  market_label: string | null
  period_kind: PeriodKind
  comparator: Comparator
  target_value: number
  timezone: string
  status: 'active' | 'archived'
  revision: number
  created_at?: string | null
  updated_at: string | null
}

export interface CatalogueEntry {
  id: string
  label: string
  unit: 'count' | 'rate' | 'ratio' | 'duration_min'
  polarity: 'up' | 'down' | 'neutral'
  additive: boolean
  min_sample: number | null
  gated: string | null
  caveat: string | null
  default_comparator: Comparator
  description: string
}

export interface GoalProgress {
  goal_id: string
  metric_id: string
  unit: CatalogueEntry['unit']
  period: { kind: PeriodKind; start: string; end: string; elapsed: number | null; days_left: number }
  target: number
  comparator: Comparator
  status: GoalStatus
  reason: string | null
  current: number | null
  n: number | null
  min_sample: number | null
  additive: boolean
  pace: number | null
  projection: number | null
  projection_basis: string | null
  share: number | null
  verdict: Verdict | null
  cumulative: Array<{ start: string; total: number }> | null
  data_as_of?: string | null
  definition_version?: string | null
}

export const PERIODS: ReadonlyArray<{ value: PeriodKind; label: string }> = [
  { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' },
]
export const PERIOD_WORD: Record<PeriodKind, string> = { week: 'this week', month: 'this month', quarter: 'this quarter' }
export const PER_PERIOD: Record<PeriodKind, string> = { week: 'per week', month: 'per month', quarter: 'per quarter' }

/**
 * The goal catalogue as the API defines it (goal-model.js GOAL_METRIC_IDS),
 * for a device with no server reachable at all. The server's copy wins
 * whenever it answers.
 */
export const FALLBACK_CATALOGUE: ReadonlyArray<CatalogueEntry> = [
  ['sellers_reached', 'Sellers reached', 'count', 'neutral', true],
  ['sellers_replied', 'Sellers who replied', 'count', 'up', false],
  ['reached_replied', 'Reached sellers who replied', 'count', 'up', true],
  ['interested_sellers', 'Interested sellers', 'count', 'up', true],
  ['opted_out_sellers', 'Opted-out sellers', 'count', 'down', true],
  ['opportunities_created', 'Opportunities created', 'count', 'up', true],
  ['stage_advancements', 'Stage advancements', 'count', 'up', true],
  ['offers_issued', 'Offers issued', 'count', 'up', true],
  ['contracts_signed', 'Contracts signed', 'count', 'up', true],
  ['closings', 'Closings', 'count', 'up', true],
  ['messages_delivered', 'Messages delivered', 'count', 'up', true],
  ['reply_rate', 'Reply rate', 'rate', 'up', false],
  ['interest_rate', 'Interest rate', 'rate', 'up', false],
  ['delivery_rate', 'Delivery rate', 'rate', 'up', false],
  ['opt_out_rate', 'Opt-out rate', 'rate', 'down', false],
].map(([id, label, unit, polarity, additive]) => ({
  id: id as string, label: label as string, unit: unit as CatalogueEntry['unit'], polarity: polarity as CatalogueEntry['polarity'], additive: additive as boolean,
  min_sample: null, gated: null, caveat: null, default_comparator: polarity === 'down' ? 'at_most' : 'at_least', description: '',
}))

export const catalogueEntry = (cat: ReadonlyArray<CatalogueEntry>, id: string) => cat.find((c) => c.id === id) ?? FALLBACK_CATALOGUE.find((c) => c.id === id) ?? null

export function newGoalId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 14) : Math.random().toString(36).slice(2, 16)
  return `g_${rnd}`
}

/* ── formatting ───────────────────────────────────────────────────────── */

export function formatValue(v: number | null | undefined, unit: CatalogueEntry['unit'] | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (unit === 'rate' || unit === 'ratio') return `${(v * 100).toFixed(1)}%`
  if (unit === 'duration_min') return `${Math.round(v)} min`
  return Math.round(v).toLocaleString('en-US')
}

export const COMPARATOR_WORD: Record<Comparator, string> = { at_least: 'at least', at_most: 'at most' }

/** "Sellers reached · at least 600 per month · Minneapolis" */
export function goalTitle(goal: Pick<Goal, 'label' | 'metric_id'>, cat: ReadonlyArray<CatalogueEntry>): string {
  return goal.label || catalogueEntry(cat, goal.metric_id)?.label || goal.metric_id
}
export function goalTerms(goal: Goal, cat: ReadonlyArray<CatalogueEntry>): string {
  const unit = catalogueEntry(cat, goal.metric_id)?.unit
  return `${COMPARATOR_WORD[goal.comparator]} ${formatValue(goal.target_value, unit)} ${PER_PERIOD[goal.period_kind]} · ${goal.market_label || goal.market || 'All markets'}`
}

/* ── verdicts (colour: green verified, gold attention; red is never a missed target) ── */

export const VERDICT: Record<Verdict, { label: string; tone: LCTone }> = {
  met: { label: 'Target met', tone: 'ok' },
  on_pace: { label: 'On pace', tone: 'ok' },
  within: { label: 'Within target', tone: 'ok' },
  behind: { label: 'Behind pace', tone: 'attn' },
  at_risk: { label: 'Projected over', tone: 'attn' },
  missed: { label: 'Over target', tone: 'attn' },
  not_met: { label: 'Not at target', tone: 'attn' },
  in_progress: { label: 'In progress', tone: 'neutral' },
}

export const STATUS_WORD: Record<Exclude<GoalStatus, 'ok'>, string> = {
  no_data: 'No data yet this period',
  insufficient_sample: 'Too few records to judge',
  unavailable: 'Unavailable',
  not_applicable: 'Not measurable for this market',
}

/** The one-word state of a goal: the verdict when the Lab answered ok, else the Lab's own status, verbatim. */
export function goalState(p: GoalProgress | null | undefined): { label: string; tone: LCTone; detail: string | null } {
  if (!p) return { label: 'Measuring…', tone: 'neutral', detail: null }
  if (p.status !== 'ok' || !p.verdict) {
    const sample = p.status === 'insufficient_sample' && p.n !== null && p.min_sample ? ` (${p.n} of ${p.min_sample} needed)` : ''
    return { label: STATUS_WORD[p.status as Exclude<GoalStatus, 'ok'>] ?? 'Unavailable', tone: 'neutral', detail: p.reason ? `${p.reason}${sample}` : sample || null }
  }
  return { ...VERDICT[p.verdict], detail: null }
}

/** Where the bar fills to, and where the pace mark sits (shares of target, clamped for drawing). */
export function barGeometry(p: GoalProgress | null | undefined): { fill: number; pace: number | null; over: boolean } {
  if (!p || p.status !== 'ok' || p.current === null || !(p.target > 0)) return { fill: 0, pace: null, over: false }
  const fill = p.current / p.target
  return { fill: Math.max(0, Math.min(1, fill)), pace: p.pace !== null ? Math.max(0, Math.min(1, p.pace / p.target)) : null, over: fill > 1 }
}

/** Rank for "what needs attention": behind / at-risk first, then unknown, then on track. */
export function attentionRank(p: GoalProgress | null | undefined): number {
  if (!p) return 2
  if (p.status !== 'ok') return 3
  return p.verdict === 'behind' || p.verdict === 'at_risk' || p.verdict === 'missed' || p.verdict === 'not_met' ? 0 : p.verdict === 'in_progress' ? 1 : 4
}

/* ── the same question in Analytics ───────────────────────────────────── */

export function analyticsPathFor(goal: Goal, p: GoalProgress | null | undefined): string {
  const ctx = {
    v: 1, tz: goal.timezone, lens: 'overview', metric: goal.metric_id, groupBy: null, view: 'line',
    filters: goal.market ? [{ field: 'market', op: 'eq', value: goal.market }] : [], segment: [],
    range: p ? { preset: 'custom', start: p.period.start, end: p.period.end } : { preset: goal.period_kind === 'week' ? '7d' : goal.period_kind === 'month' ? '30d' : '90d' },
    compare: { mode: 'none' }, grain: 'day',
  }
  return `/analytics?lab=${encodeB64Url(ctx)}`
}

/** The goal definitions the progress endpoint evaluates (active only, stable order). */
export function progressRequest(goals: ReadonlyArray<Goal>): Goal[] {
  return goals.filter((g) => g.status === 'active').slice().sort((a, b) => a.goal_id.localeCompare(b.goal_id)).slice(0, 24)
}

/** Merge a local and a server list: the higher revision wins per goal id. */
export function mergeGoals(local: ReadonlyArray<Goal>, server: ReadonlyArray<Goal>): Goal[] {
  const by = new Map<string, Goal>()
  for (const g of [...server, ...local]) {
    const cur = by.get(g.goal_id)
    if (!cur || g.revision > cur.revision) by.set(g.goal_id, g)
  }
  return [...by.values()].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
}

/** One active goal per metric × market × period (the server's unique index, checked before a write). */
export function duplicateOf(goals: ReadonlyArray<Goal>, draft: Pick<Goal, 'goal_id' | 'metric_id' | 'market' | 'period_kind'>): Goal | null {
  return goals.find((g) => g.status === 'active' && g.goal_id !== draft.goal_id && g.metric_id === draft.metric_id && (g.market ?? '') === (draft.market ?? '') && g.period_kind === draft.period_kind) ?? null
}
