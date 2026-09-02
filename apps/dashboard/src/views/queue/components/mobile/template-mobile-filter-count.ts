import type { ColumnPreset, TemplateIntelligenceFilters } from '../../../../domain/templates/template-intelligence.types'

/** Number of non-default template filters, for the mobile filter-bar badge. */
export function templateFilterCount(filters: TemplateIntelligenceFilters, preset: ColumnPreset): number {
  let n = 0
  if (filters.range !== '7d') n++
  if (filters.stage) n++
  if (filters.query?.trim()) n++
  if (filters.touch != null) n++
  if (filters.language) n++
  if (filters.activeState) n++
  if (preset !== 'performance') n++
  return n
}
