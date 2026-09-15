/**
 * ONE COMPILER FROM A CATALOG FIELD + OPERATOR + VALUE TO A POSTGREST PREDICATE.
 *
 * This lived inside campaign-automation-service.js (8,061 lines, and through it
 * the SMS engine, the pre-send eligibility engine and the execution lock), so
 * any other surface that wanted to filter on a catalog field had two options:
 * import the whole send pipeline, or write its own translation. Entity Graph
 * took the second road and ended up with 13 hand-written inputs against a
 * catalog of 156 fields -- and its own separate idea of what "market" means.
 *
 * Extracted verbatim so the campaign builder and Entity Graph compile the same
 * field the same way. It depends only on the field catalog and two string
 * helpers, so a read-only browse path does not drag the send engine in.
 *
 * The invariant that matters: this module NEVER decides a filter is
 * inapplicable and silently drops it. It compiles what it is given. Deciding
 * whether a field is supported at all belongs to the caller, which must fail
 * closed -- a dropped narrowing turns "5 properties" into 169,802, and on
 * 2026-09-14 that wrote 64,878 unintended rows into a live campaign.
 */
import { asBoolean, clean } from '@/lib/domain/queue/queue-control-safety.js'
import { getCampaignFieldDefinition } from '@/lib/domain/campaigns/campaign-field-catalog.js'

export const EMPTY_FILTER_OPERATORS = new Set(['is_empty', 'is_not_empty'])

/** Operators whose value is a LIST, not a scalar. */
export const MULTI_VALUE_OPERATORS = ['is_any_of', 'is_not_any_of', 'contains_any']

export function isSafeIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(clean(value))
}

export function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function coerceScalarArray(value) {
  if (Array.isArray(value)) return value.flatMap(coerceScalarArray)
  if (value && typeof value === 'object') {
    const resolved = value.value ?? value.label ?? value.key ?? value.name
    return resolved === undefined ? [] : coerceScalarArray(resolved)
  }
  if (value === null || value === undefined) return []
  return [value]
}

export function normalizeFilterArrayInput(value) {
  if (Array.isArray(value)) return value.flatMap(coerceScalarArray)
  if (value && typeof value === 'object') return coerceScalarArray(value)
  const text = clean(value)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.flatMap(coerceScalarArray) : [parsed]
    } catch {
      return [value]
    }
  }
  return [value]
}

export function normalizePreviewOperator(operator, field) {
  const raw = clean(operator || field?.operators?.[0]?.key || 'eq')
  const mapped = {
    in: 'is_any_of',
    not_in: 'is_not_any_of',
  }[raw] || raw
  const allowed = new Set((field?.operators || []).map((entry) => entry.key))
  if (allowed.has(mapped)) return mapped
  if (['eq', 'is_any_of', 'is_not_any_of', 'contains_any'].includes(mapped)) return mapped
  return allowed.has('eq') ? 'eq' : clean(field?.operators?.[0]?.key || mapped || 'eq')
}

export function normalizePreviewFilterValue(value, operator) {
  if (MULTI_VALUE_OPERATORS.includes(operator)) {
    return normalizeFilterArrayInput(value)
  }
  if (operator === 'between') {
    return coerceScalarArray(value).slice(0, 2)
  }
  return value
}

export function hasMeaningfulFilterValue(value, operator) {
  if (EMPTY_FILTER_OPERATORS.has(operator)) return true
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulFilterValue(item, operator))
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  if (typeof value === 'boolean') return true
  return Boolean(clean(value))
}

export function filterScalarValues(filter = {}) {
  return MULTI_VALUE_OPERATORS.includes(filter.operator)
    ? normalizeFilterArrayInput(filter.value)
    : coerceScalarArray(filter.value)
}

export function filterColumn(filter = {}) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const column = field?.source_column || filter.source_column || filter.field || filter.field_key?.split('.').pop()
  return isSafeIdentifier(column) ? column : null
}

export function applySupabaseFilterToColumn(query, filter = {}, columnOverride = null) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const column = columnOverride || filterColumn(filter)
  if (!column || !field) return query
  const operator = normalizePreviewOperator(filter.operator || 'eq', field)
  const values = filterScalarValues({ ...filter, operator })
  const first = values[0]

  if (operator === 'is_empty') return query.is(column, null)
  if (operator === 'is_not_empty') return query.not(column, 'is', null)

  if (field.type === 'boolean' || operator === 'is_true' || operator === 'is_false') {
    if (operator === 'is_true') return query.eq(column, true)
    if (operator === 'is_false') return query.eq(column, false)
    if (first !== undefined) return query.eq(column, asBoolean(first, false))
    return query
  }

  if (field.type === 'number') {
    if (operator === 'gte') {
      const min = numberOrNull(first)
      return min === null ? query : query.gte(column, min)
    }
    if (operator === 'lte') {
      const max = numberOrNull(first)
      return max === null ? query : query.lte(column, max)
    }
    if (operator === 'between') {
      const min = numberOrNull(values[0])
      const max = numberOrNull(values[1])
      if (min !== null) query = query.gte(column, min)
      if (max !== null) query = query.lte(column, max)
      return query
    }
    if (operator === 'is_any_of' && values.length) {
      const numbers = values.map(numberOrNull).filter((value) => value !== null)
      return numbers.length ? query.in(column, numbers) : query
    }
    const exact = numberOrNull(first)
    return exact === null ? query : query.eq(column, exact)
  }

  if (['on_or_after', 'on_or_before', 'between'].includes(operator)) {
    if (operator === 'on_or_after') return clean(first) ? query.gte(column, clean(first)) : query
    if (operator === 'on_or_before') return clean(first) ? query.lte(column, clean(first)) : query
    if (clean(values[0])) query = query.gte(column, clean(values[0]))
    if (clean(values[1])) query = query.lte(column, clean(values[1]))
    return query
  }

  if (operator === 'contains' || operator === 'contains_any') {
    const terms = values.map(clean).filter(Boolean)
    if (!terms.length) return query
    if (terms.length === 1) return query.ilike(column, `%${terms[0]}%`)
    return query.or(terms.map((term) => `${column}.ilike.%${term.replace(/[,%]/g, '')}%`).join(','))
  }

  if (operator === 'is_not_any_of' && values.length) return query.not(column, 'in', `(${values.map(clean).join(',')})`)
  if (operator === 'is_any_of' && values.length) return query.in(column, values.map(clean).filter(Boolean))
  if (clean(first)) return query.eq(column, clean(first))
  return query
}

export function applySupabaseFilter(query, filter = {}) {
  return applySupabaseFilterToColumn(query, filter)
}

export function applySupabaseFilters(query, filters = []) {
  return filters.reduce((current, filter) => applySupabaseFilter(current, filter), query)
}
