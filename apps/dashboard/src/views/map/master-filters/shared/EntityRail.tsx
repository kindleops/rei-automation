import { useMasterFilters } from '../MasterFiltersProvider'
import { ENTITY_LABELS, MAP_FILTER_ENTITIES } from '../types'
import { cls, fmtCount } from '../utils'

export function EntityRail() {
  const { selectedEntity, setSelectedEntity, registry } = useMasterFilters()

  return (
    <div className="mf-entity-segment" role="tablist" aria-label="Filter entities">
      {MAP_FILTER_ENTITIES.map((entity) => {
        const count = registry?.fieldsByEntity?.[entity]
          ?? registry?.fieldsByEntity?.[entity === 'master_owner' ? 'owner' : entity]
        return (
          <button
            key={entity}
            type="button"
            role="tab"
            aria-selected={selectedEntity === entity}
            className={cls('mf-entity-segment__btn', selectedEntity === entity && 'is-active')}
            onClick={() => setSelectedEntity(entity)}
          >
            <span>{ENTITY_LABELS[entity]}</span>
            <span className="mf-entity-segment__count">{fmtCount(count)}</span>
          </button>
        )
      })}
    </div>
  )
}