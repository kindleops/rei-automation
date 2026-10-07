/**
 * Composer value pickers (mobile builder + desktop Composer) — one loader that
 * keeps what the options API says about its list instead of flattening it to
 * an array. "No values found" used to stand for four different things:
 *   - the facet snapshot never counted this field          → not_counted
 *   - no property in the audience has a value               → empty
 *   - the search matched nothing                            → no_match
 *   - the request failed                                    → unavailable
 * Each now reaches the operator in words, and every option carries the two
 * numbers it has (properties in the audience · eligible to queue) labelled.
 */
import { callBackend } from '../../lib/api/backendClient'

export type FieldValuesState = 'ok' | 'not_counted' | 'empty' | 'no_match' | 'unavailable'

export interface FieldOptionValue {
  value: string
  label: string
  /** Properties in the campaign audience carrying this value. */
  count?: number
  /** Of those, eligible to queue a text now. */
  eligibleCount?: number
  marketId?: string
}

export interface FieldOptionValues {
  options: FieldOptionValue[]
  state: FieldValuesState
  /** Operator-facing reason for any state other than ok. */
  message: string | null
  /** 'exact_group_count' (live) or 'facet_snapshot' (precomputed). */
  source: string | null
}

const STATE_MESSAGES: Record<Exclude<FieldValuesState, 'ok'>, string> = {
  not_counted: 'Values for this field haven’t been counted for the campaign audience yet. You can still type a value.',
  empty: 'No property in the campaign audience has a value for this field yet.',
  no_match: 'No value matches that search.',
  unavailable: 'Values couldn’t load.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const KNOWN_STATES = new Set<FieldValuesState>(['ok', 'not_counted', 'empty', 'no_match', 'unavailable'])

/** Pure: the options API payload → options + state. Exported for tests. */
export function normalizeFieldOptionValues(payload: unknown, search = ''): FieldOptionValues {
  const raw = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.options) ? payload.options : []
  const options: FieldOptionValue[] = []
  for (const item of raw) {
    if (isRecord(item)) {
      const label = text(item.label) || text(item.value)
      const value = text(item.value) || label
      if (!value) continue
      const count = num(item.count)
      const eligibleCount = num(item.queueable_count)
      const marketId = text(item.market_id)
      options.push({
        value,
        label,
        ...(count === undefined ? {} : { count }),
        ...(eligibleCount === undefined ? {} : { eligibleCount }),
        ...(marketId ? { marketId } : {}),
      })
    } else if (text(item)) {
      options.push({ value: text(item), label: text(item) })
    }
  }
  const record = isRecord(payload) ? payload : {}
  const declared = text(record.values_state) as FieldValuesState
  // An older API (no values_state) that returns nothing has not counted the
  // field as far as the operator can tell; a search with no hit is a no_match.
  const state: FieldValuesState = options.length
    ? 'ok'
    : KNOWN_STATES.has(declared) && declared !== 'ok'
      ? declared
      : search.trim() ? 'no_match' : 'not_counted'
  const message = state === 'ok' ? null : text(record.values_message) || STATE_MESSAGES[state]
  return { options, state, message, source: text(record.values_source) || null }
}

export async function loadFieldOptionValues(fieldKey: string, search = ''): Promise<FieldOptionValues> {
  const params = new URLSearchParams({ field: fieldKey, limit: '250' })
  const trimmed = search.trim()
  if (trimmed) params.set('search', trimmed)
  const result = await callBackend(`/api/cockpit/campaigns/options?${params.toString()}`)
  if (!result.ok) {
    return { options: [], state: 'unavailable', message: `${STATE_MESSAGES.unavailable} ${result.message || ''}`.trim(), source: null }
  }
  if (isRecord(result.data) && result.data.ok === false) {
    return { options: [], state: 'unavailable', message: `${STATE_MESSAGES.unavailable} ${text(result.data.message)}`.trim(), source: null }
  }
  return normalizeFieldOptionValues(result.data, trimmed)
}

/** "7,814 properties · 3,740 eligible" — both numbers, both named. */
export function describeOptionCounts(option: Pick<FieldOptionValue, 'count' | 'eligibleCount'>, format: (n: number) => string): string | null {
  if (option.count === undefined) return null
  const head = `${format(option.count)} ${option.count === 1 ? 'property' : 'properties'}`
  return option.eligibleCount === undefined ? head : `${head} · ${format(option.eligibleCount)} eligible`
}

/** Pure: add or remove one value, keeping the order the operator picked them in. */
export function toggleOptionValue(selected: readonly string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]
}

/** Pure: "2 selected · 116,240 properties · 58,104 eligible". */
export function pickerSummary(
  options: readonly FieldOptionValue[],
  selected: readonly string[],
  format: (n: number) => string,
): string | null {
  if (!selected.length) return options.length ? `${options.length} values · tap to select` : null
  const chosen = options.filter((option) => selected.includes(option.value))
  const properties = chosen.reduce((sum, option) => sum + Number(option.count || 0), 0)
  const eligible = chosen.reduce((sum, option) => sum + Number(option.eligibleCount || 0), 0)
  // Values of one field are disjoint for scalar fields; for flag lists a
  // property can carry two selected flags, so the sum is an upper bound.
  return `${selected.length} selected${properties ? ` · up to ${format(properties)} properties` : ''}${eligible ? ` · ${format(eligible)} eligible` : ''}`
}
