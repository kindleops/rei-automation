/**
 * Reach's per-filter "why" (GET /composer?part=filters): what each applied
 * filter removed, what is left after it (and how much of it can queue), how
 * much of the universe even has a value in that filter's column, and every
 * filter that could not be applied with its reason. Shared by the desktop
 * Composer and the mobile Reach screen.
 */
import { callBackend } from '../../lib/api/backendClient'

export interface FilterEffect {
  field_key: string
  label: string
  operator: string
  value: unknown
  stage: 'location' | 'targeting'
  count_after: number | null
  removed: number | null
  eligible_after: number | null
  coverage: { with_value: number; of: number; pct: number } | null
  failed: boolean
}

export interface RefusedFilter {
  field_key: string
  label: string
  operator: string | null
  reason: string
  message: string
}

export interface FilterEffects {
  ok: true
  base_count: number | null
  universe_count: number | null
  final_count: number | null
  final_eligible: number | null
  effects: FilterEffect[]
  refused: RefusedFilter[]
  warnings: string[]
}

export type FilterEffectsResult = FilterEffects | { ok: false; message: string }

/** Below this share of the universe carrying a value, a filter's cut is mostly missing data. */
export const LOW_COVERAGE_PCT = 60

export async function loadFilterEffects(filters: Record<string, unknown>, signal?: AbortSignal): Promise<FilterEffectsResult> {
  const spec = encodeURIComponent(JSON.stringify({ filters }))
  const res = await callBackend<FilterEffects | { ok: false; error?: string; message?: string }>(
    `/api/cockpit/campaigns/composer?part=filters&spec=${spec}`,
    { signal, timeoutMs: 120_000 },
  )
  if (!res.ok) return { ok: false, message: res.message || res.error || 'Per-filter counts unavailable' }
  const data = res.data as FilterEffects | { ok: false; error?: string; message?: string }
  if (!data || data.ok === false) {
    const failure = (data || {}) as { error?: string; message?: string }
    return { ok: false, message: failure.message || failure.error || 'Per-filter counts unavailable' }
  }
  return {
    ...data,
    effects: Array.isArray(data.effects) ? data.effects : [],
    refused: Array.isArray(data.refused) ? data.refused : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  }
}

const OPERATOR_WORDS: Record<string, string> = {
  is_any_of: 'is',
  is_not_any_of: 'is not',
  eq: '=',
  gte: '≥',
  lte: '≤',
  between: 'between',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'has a value',
  is_true: 'is true',
  is_false: 'is false',
  on_or_after: 'on or after',
  on_or_before: 'on or before',
  within: 'inside',
}

/** "is Poor, Unsound" · "≥ 60" · "between 1950 – 1980" · "inside drawn area". */
export function describeFilterCondition(effect: Pick<FilterEffect, 'operator' | 'value' | 'field_key'>): string {
  const op = OPERATOR_WORDS[effect.operator] ?? effect.operator
  if (effect.operator === 'within') return 'inside the drawn area'
  if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(effect.operator)) return op
  const value = effect.value
  if (Array.isArray(value)) {
    const parts = value.map((entry) => String(entry)).filter(Boolean)
    if (effect.operator === 'between') return `between ${parts[0] ?? '…'} – ${parts[1] ?? '…'}`
    const shown = parts.length > 3 ? `${parts.slice(0, 3).join(', ')} +${parts.length - 3}` : parts.join(', ')
    return `${op} ${shown}`
  }
  return `${op} ${String(value ?? '')}`.trim()
}

/** The coverage sentence, or null when coverage is complete enough to say nothing. */
export function coverageWarning(effect: Pick<FilterEffect, 'coverage' | 'label' | 'stage'>, format: (n: number) => string): string | null {
  const c = effect.coverage
  if (!c || c.pct >= LOW_COVERAGE_PCT) return null
  const missing = Math.max(0, c.of - c.with_value)
  return `Only ${c.pct}% of this ${effect.stage === 'location' ? 'audience table' : 'universe'} has a ${effect.label} on file — ${format(missing)} properties have none, so they can’t match this filter (missing data, not a seller trait).`
}
