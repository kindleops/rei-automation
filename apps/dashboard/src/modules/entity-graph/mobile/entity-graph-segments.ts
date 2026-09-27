/**
 * SAVED SEGMENTS — a named filter set, kept on this device.
 *
 * A segment stores the COHORT DEFINITION (scope, filters, field filters,
 * query), not today's rows, so reopening it re-resolves against live data.
 * There is no saved-list table in the schema; this is deliberately local
 * rather than a fake server feature.
 */
import type { EntityGraphFilters } from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import type { EntityScope } from './entity-graph-mobile-format'

export type SavedSegment = {
  id: string
  name: string
  scope: EntityScope
  filters: Partial<EntityGraphFilters>
  fieldFilters: EntityGraphFieldFilter[]
  query?: string
  total?: number | null
  savedAt: string
}

const KEY = 'nexus.entityGraph.segments.v1'

export function readSegments(): SavedSegment[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function describe(scope: EntityScope, filters: Partial<EntityGraphFilters>, fieldFilters: EntityGraphFieldFilter[], query?: string): string {
  const bits: string[] = []
  if (query) bits.push(`“${query}”`)
  for (const key of ['market', 'state', 'city', 'zip', 'assetType'] as const) {
    const v = filters[key]
    if (v) bits.push(String(v))
  }
  for (const f of fieldFilters.slice(0, 3)) {
    const field = f.field_key.split('.').pop()?.replace(/_/g, ' ') ?? f.field_key
    const value = Array.isArray(f.value) ? f.value.join('/') : f.value === undefined || f.value === null ? '' : String(f.value)
    bits.push(value ? `${field} ${value}` : field)
  }
  const noun = scope === 'master_owners' ? 'Owners' : scope === 'contact_methods' ? 'Contacts' : scope.charAt(0).toUpperCase() + scope.slice(1)
  return bits.length ? `${noun} · ${bits.join(' · ')}` : `All ${noun.toLowerCase()}`
}

export function saveSegment(input: {
  scope: EntityScope
  filters: Partial<EntityGraphFilters>
  fieldFilters: EntityGraphFieldFilter[]
  query?: string
  total?: number | null
  name?: string
}): SavedSegment {
  const segment: SavedSegment = {
    id: `seg_${Date.now().toString(36)}`,
    name: input.name?.trim() || describe(input.scope, input.filters, input.fieldFilters, input.query),
    scope: input.scope,
    filters: input.filters,
    fieldFilters: input.fieldFilters,
    query: input.query || undefined,
    total: input.total ?? null,
    savedAt: new Date().toISOString(),
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify([segment, ...readSegments()].slice(0, 40)))
  } catch { /* storage full or disabled — the segment still applies now */ }
  return segment
}

export function deleteSegment(id: string): SavedSegment[] {
  const next = readSegments().filter((s) => s.id !== id)
  try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
