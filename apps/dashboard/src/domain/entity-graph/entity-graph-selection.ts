/**
 * Entity Graph exact selection — the operator's pinned set of property ids.
 *
 * Accumulates across pagination and across filter runs; a whole filtered cohort
 * can be added only with an explicit scope confirmation (the operator confirms
 * the exact count the server reported). The set is what becomes the campaign
 * draft's `properties.property_id in [...]` target filter — nothing is ever
 * added that the operator did not select or confirm.
 *
 * Pure and framework-free so it can be unit-tested and persisted per tab.
 */

export type SelectionSource =
  | { kind: 'row' }
  | { kind: 'cohort'; cohortKey: string; confirmedCount: number; confirmedAt: string }

export type SelectedProperty = {
  propertyId: string
  label: string | null
  source: SelectionSource
}

export type EntityGraphSelection = {
  version: 1
  items: SelectedProperty[]
}

export const EMPTY_SELECTION: EntityGraphSelection = { version: 1, items: [] }
export const SELECTION_MAX = 5000

function cleanId(value: unknown): string {
  return String(value ?? '').trim()
}

export function selectedIds(selection: EntityGraphSelection): string[] {
  return selection.items.map((item) => item.propertyId)
}

export function isSelected(selection: EntityGraphSelection, propertyId: string): boolean {
  const id = cleanId(propertyId)
  return selection.items.some((item) => item.propertyId === id)
}

/** Add rows (from any page or any filter run). Existing entries keep their original source. */
export function addRows(
  selection: EntityGraphSelection,
  rows: Array<{ propertyId: string; label?: string | null }>,
): EntityGraphSelection {
  const seen = new Set(selection.items.map((item) => item.propertyId))
  const added: SelectedProperty[] = []
  for (const row of rows) {
    const id = cleanId(row.propertyId)
    if (!id || seen.has(id)) continue
    seen.add(id)
    added.push({ propertyId: id, label: row.label ?? null, source: { kind: 'row' } })
  }
  if (!added.length) return selection
  if (selection.items.length + added.length > SELECTION_MAX) {
    throw new Error(`selection_too_large:${SELECTION_MAX}`)
  }
  return { version: 1, items: [...selection.items, ...added] }
}

export function removeRows(selection: EntityGraphSelection, propertyIds: string[]): EntityGraphSelection {
  const drop = new Set(propertyIds.map(cleanId))
  return { version: 1, items: selection.items.filter((item) => !drop.has(item.propertyId)) }
}

export function toggleRow(
  selection: EntityGraphSelection,
  row: { propertyId: string; label?: string | null },
): EntityGraphSelection {
  return isSelected(selection, row.propertyId)
    ? removeRows(selection, [row.propertyId])
    : addRows(selection, [row])
}

/**
 * Add an entire filtered cohort. `cohortIds` is the full id list the server
 * resolved for the cohort; `confirmedCount` is what the operator confirmed on
 * screen. If they differ, the cohort changed under the operator and nothing is
 * added.
 */
export function addConfirmedCohort(
  selection: EntityGraphSelection,
  cohort: { cohortKey: string; cohortIds: string[]; confirmedCount: number; now?: string },
): EntityGraphSelection {
  const ids = Array.from(new Set(cohort.cohortIds.map(cleanId).filter(Boolean)))
  if (ids.length !== cohort.confirmedCount) {
    throw new Error(`cohort_count_changed:${cohort.confirmedCount}->${ids.length}`)
  }
  const seen = new Set(selection.items.map((item) => item.propertyId))
  const source: SelectionSource = {
    kind: 'cohort',
    cohortKey: cohort.cohortKey,
    confirmedCount: cohort.confirmedCount,
    confirmedAt: cohort.now ?? new Date().toISOString(),
  }
  const added = ids.filter((id) => !seen.has(id)).map((id) => ({ propertyId: id, label: null, source }))
  if (selection.items.length + added.length > SELECTION_MAX) {
    throw new Error(`selection_too_large:${SELECTION_MAX}`)
  }
  return { version: 1, items: [...selection.items, ...added] }
}

export function clearSelection(): EntityGraphSelection {
  return EMPTY_SELECTION
}

/** Payload for POST /api/cockpit/campaigns/preview-selection (read-only). */
export function toPreviewSelectionPayload(selection: EntityGraphSelection): { property_ids: string[] } {
  return { property_ids: selectedIds(selection) }
}

/** The explicit target filter the existing campaign-draft path consumes. */
export function toCampaignTargetFilter(selection: EntityGraphSelection) {
  return { field_key: 'properties.property_id', operator: 'in', value: selectedIds(selection) }
}

const STORAGE_KEY = 'nexus:entity-graph:selection:v1'

export function serializeSelection(selection: EntityGraphSelection): string {
  return JSON.stringify(selection)
}

/** Corrupt or foreign data restores an EMPTY selection — never a guessed one. */
export function deserializeSelection(raw: string | null | undefined): EntityGraphSelection {
  if (!raw) return EMPTY_SELECTION
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return EMPTY_SELECTION
    const items: SelectedProperty[] = []
    const seen = new Set<string>()
    for (const item of parsed.items) {
      const id = cleanId(item?.propertyId)
      if (!id || seen.has(id)) continue
      const source = item?.source?.kind === 'cohort' ? item.source : { kind: 'row' as const }
      seen.add(id)
      items.push({ propertyId: id, label: item?.label ?? null, source })
    }
    return { version: 1, items }
  } catch {
    return EMPTY_SELECTION
  }
}

export function loadSelection(storage: Pick<Storage, 'getItem'> | null): EntityGraphSelection {
  try {
    return deserializeSelection(storage?.getItem(STORAGE_KEY))
  } catch {
    return EMPTY_SELECTION
  }
}

export function saveSelection(storage: Pick<Storage, 'setItem'> | null, selection: EntityGraphSelection): void {
  try {
    storage?.setItem(STORAGE_KEY, serializeSelection(selection))
  } catch {
    /* storage unavailable: selection stays in memory only */
  }
}
