import type { FilterCatalogField } from './inbox-filter-api'
import { INBOX_FILTER_FIELDS } from './inbox-filter-catalog-client'
import type { InboxAdvancedFilters } from '../../modules/inbox/inbox-ui-helpers'
import { serializeAdvancedFiltersForServer } from './inbox-advanced-filter-engine'

const isActiveValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return false
  if (value === 'all') return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

export function resolveCatalogRangeKeys(field: FilterCatalogField): {
  minKey?: keyof InboxAdvancedFilters
  maxKey?: keyof InboxAdvancedFilters
  fromKey?: keyof InboxAdvancedFilters
  toKey?: keyof InboxAdvancedFilters
} {
  if (field.type === 'numberRange') {
    const base = field.key.replace(/Min$/, '')
    return {
      minKey: `${base}Min` as keyof InboxAdvancedFilters,
      maxKey: `${base}Max` as keyof InboxAdvancedFilters,
    }
  }
  if (field.type === 'dateRange') {
    return {
      fromKey: field.key as keyof InboxAdvancedFilters,
      toKey: field.key.replace(/From$/, 'To') as keyof InboxAdvancedFilters,
    }
  }
  return {}
}

export function pickActiveCatalogFilterValues(filters: InboxAdvancedFilters): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const seen = new Set<string>()

  for (const field of INBOX_FILTER_FIELDS) {
    if (field.type === 'numberRange' || field.type === 'dateRange') {
      const keys = resolveCatalogRangeKeys(field)
      if (field.type === 'numberRange') {
        const min = keys.minKey ? filters[keys.minKey] : undefined
        const max = keys.maxKey ? filters[keys.maxKey] : undefined
        if (!isActiveValue(min) && !isActiveValue(max)) continue
        if (keys.minKey && isActiveValue(min)) payload[keys.minKey as string] = min
        if (keys.maxKey && isActiveValue(max)) payload[keys.maxKey as string] = max
        seen.add(field.key)
        continue
      }
      const from = keys.fromKey ? filters[keys.fromKey] : undefined
      const to = keys.toKey ? filters[keys.toKey] : undefined
      if (!isActiveValue(from) && !isActiveValue(to)) continue
      if (keys.fromKey && isActiveValue(from)) payload[keys.fromKey as string] = from
      if (keys.toKey && isActiveValue(to)) payload[keys.toKey as string] = to
      seen.add(field.key)
      continue
    }

    if (field.type === 'flags') continue

    const value = (filters as Record<string, unknown>)[field.key]
    if (!isActiveValue(value) || seen.has(field.key)) continue
    payload[field.key] = value
    seen.add(field.key)
  }

  const flagKeys = [
    'propertyFlagsAny', 'propertyFlagsAll', 'propertyFlagsExclude',
    'personFlagsAny', 'personFlagsAll', 'personFlagsExclude',
  ] as const
  for (const key of flagKeys) {
    const value = filters[key]
    if (isActiveValue(value)) payload[key] = value
  }

  return payload
}

export function serializeInboxFiltersForMap(filters: InboxAdvancedFilters): Record<string, unknown> {
  return {
    ...pickActiveCatalogFilterValues(filters),
    ...serializeAdvancedFiltersForServer(filters),
  }
}

export function countActiveCatalogFilters(filters: InboxAdvancedFilters = {}): number {
  let count = 0
  const seen = new Set<string>()

  for (const field of INBOX_FILTER_FIELDS) {
    if (field.type === 'numberRange' || field.type === 'dateRange') {
      const keys = resolveCatalogRangeKeys(field)
      const min = keys.minKey ? filters[keys.minKey] : undefined
      const max = keys.maxKey ? filters[keys.maxKey] : undefined
      const from = keys.fromKey ? filters[keys.fromKey] : undefined
      const to = keys.toKey ? filters[keys.toKey] : undefined
      const active = field.type === 'numberRange'
        ? isActiveValue(min) || isActiveValue(max)
        : isActiveValue(from) || isActiveValue(to)
      if (active && !seen.has(field.key)) {
        seen.add(field.key)
        count += 1
      }
      continue
    }
    if (field.type === 'flags') {
      const isProperty = field.key === 'propertyFlags'
      const anyKey = isProperty ? 'propertyFlagsAny' : 'personFlagsAny'
      const allKey = isProperty ? 'propertyFlagsAll' : 'personFlagsAll'
      const excludeKey = isProperty ? 'propertyFlagsExclude' : 'personFlagsExclude'
      const active = isActiveValue(filters[anyKey]) || isActiveValue(filters[allKey]) || isActiveValue(filters[excludeKey])
      if (active && !seen.has(field.key)) {
        seen.add(field.key)
        count += 1
      }
      continue
    }
    const value = (filters as Record<string, unknown>)[field.key]
    if (isActiveValue(value) && !seen.has(field.key)) {
      seen.add(field.key)
      count += 1
    }
  }

  return count
}

export interface CatalogFilterChip {
  key: string
  label: string
  clear: (current: InboxAdvancedFilters) => InboxAdvancedFilters
}

export function buildCatalogFilterChips(filters: InboxAdvancedFilters): CatalogFilterChip[] {
  const chips: CatalogFilterChip[] = []

  const push = (key: string, label: string, clear: (current: InboxAdvancedFilters) => InboxAdvancedFilters) => {
    chips.push({ key, label, clear })
  }

  for (const field of INBOX_FILTER_FIELDS) {
    if (field.type === 'numberRange' || field.type === 'dateRange') {
      const keys = resolveCatalogRangeKeys(field)
      if (field.type === 'numberRange') {
        const min = keys.minKey ? filters[keys.minKey] : undefined
        const max = keys.maxKey ? filters[keys.maxKey] : undefined
        if (!isActiveValue(min) && !isActiveValue(max)) continue
        const parts: string[] = []
        if (isActiveValue(min)) parts.push(`≥ ${min}`)
        if (isActiveValue(max)) parts.push(`≤ ${max}`)
        push(field.key, `${field.label} ${parts.join(' ')}`, (current) => ({
          ...current,
          ...(keys.minKey ? { [keys.minKey]: undefined } : {}),
          ...(keys.maxKey ? { [keys.maxKey]: undefined } : {}),
        }))
        continue
      }
      const from = keys.fromKey ? filters[keys.fromKey] : undefined
      const to = keys.toKey ? filters[keys.toKey] : undefined
      if (!isActiveValue(from) && !isActiveValue(to)) continue
      const parts: string[] = []
      if (isActiveValue(from)) parts.push(`from ${from}`)
      if (isActiveValue(to)) parts.push(`to ${to}`)
      push(field.key, `${field.label} ${parts.join(' ')}`, (current) => ({
        ...current,
        ...(keys.fromKey ? { [keys.fromKey]: undefined } : {}),
        ...(keys.toKey ? { [keys.toKey]: undefined } : {}),
      }))
      continue
    }

    if (field.type === 'flags') {
      const isProperty = field.key === 'propertyFlags'
      const any = isProperty ? filters.propertyFlagsAny : filters.personFlagsAny
      const all = isProperty ? filters.propertyFlagsAll : filters.personFlagsAll
      const exclude = isProperty ? filters.propertyFlagsExclude : filters.personFlagsExclude
      const active = any?.length || all?.length || exclude?.length
      if (!active) continue
      const count = (any?.length ?? 0) + (all?.length ?? 0) + (exclude?.length ?? 0)
      push(field.key, `${field.label} (${count})`, (current) => ({
        ...current,
        ...(isProperty
          ? { propertyFlagsAny: undefined, propertyFlagsAll: undefined, propertyFlagsExclude: undefined }
          : { personFlagsAny: undefined, personFlagsAll: undefined, personFlagsExclude: undefined }),
      }))
      continue
    }

    const value = (filters as Record<string, unknown>)[field.key]
    if (!isActiveValue(value)) continue
    push(field.key, `${field.label}: ${String(value)}`, (current) => ({
      ...current,
      [field.key]: field.key === 'outOfStateOwner' ? 'all' : undefined,
    }))
  }

  return chips
}