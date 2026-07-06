import { appendRuleToRoot, createRule } from '../expression-utils'
import { useMasterFilters } from '../MasterFiltersProvider'
import type { MapFilterRegistryField } from '../types'
import { EntityRail } from '../shared/EntityRail'
import { FieldCatalog } from '../shared/FieldCatalog'
import { FieldSearch } from '../shared/FieldSearch'
import { QuickFilters } from '../shared/QuickFilters'

export function DiscoverPane() {
  const { draftExpression, setDraftExpression, registryLoading, registryError } = useMasterFilters()

  const onSelectField = (field: MapFilterRegistryField) => {
    const rule = createRule(field.key, field.operators[0] ?? 'equals', '')
    setDraftExpression(appendRuleToRoot(draftExpression, rule))
  }

  return (
    <aside className="mf-pane mf-pane--discover">
      <h3 className="mf-pane__title">Discover</h3>
      {registryLoading ? <p className="mf-pane__status">Loading registry…</p> : null}
      {registryError ? <p className="mf-pane__error">{registryError}</p> : null}
      <FieldSearch onSelectField={onSelectField} />
      <EntityRail />
      <QuickFilters />
      <FieldCatalog onSelectField={onSelectField} />
    </aside>
  )
}