import { useMasterFilters } from '../MasterFiltersProvider'
import { ENTITY_LABELS, MAP_FILTER_ENTITIES } from '../types'
import { cls, fmtCount } from '../utils'

export function EntityRail() {
  const { selectedEntity, setSelectedEntity, registry, fieldsByEntity } = useMasterFilters()

  return (
    <nav className="mf-entity-rail" aria-label="Filter entities">
      {MAP_FILTER_ENTITIES.map((entity) => {
        const count = registry?.fieldsByEntity?.[entity]
          ?? registry?.fieldsByEntity?.[entity === 'master_owner' ? 'owner' : entity]
          ?? fieldsByEntity[entity]?.length
          ?? 0
        return (
          <button
            key={entity}
            type="button"
            className={cls('mf-entity-rail__btn', selectedEntity === entity && 'is-active')}
            onClick={() => setSelectedEntity(entity)}
          >
            <span className="mf-entity-rail__label">{ENTITY_LABELS[entity]}</span>
            <span className="mf-entity-rail__count">{fmtCount(count)}</span>
          </button>
        )
      })}
    </nav>
  )
}