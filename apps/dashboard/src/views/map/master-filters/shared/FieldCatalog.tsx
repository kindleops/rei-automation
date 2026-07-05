import { useMemo, useState } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { fieldMatchesEntity } from '../entity-utils'
import type { MapFilterRegistryField } from '../types'
import { cls } from '../utils'

export interface FieldCatalogProps {
  onSelectField: (field: MapFilterRegistryField) => void
}

export function FieldCatalog({ onSelectField }: FieldCatalogProps) {
  const {
    fields,
    selectedEntity,
    categoriesByEntity,
    favoriteFieldKeys,
    recentFieldKeys,
    toggleFavoriteField,
    recordRecentField,
  } = useMasterFilters()

  const categories = categoriesByEntity[selectedEntity] ?? []
  const [expandedCategory, setExpandedCategory] = useState<string | null>(categories[0] ?? null)

  const entityFields = useMemo(
    () => fields.filter((f) => fieldMatchesEntity(f, selectedEntity)),
    [fields, selectedEntity],
  )

  const favoriteFields = useMemo(
    () => entityFields.filter((f) => favoriteFieldKeys.includes(f.key)),
    [entityFields, favoriteFieldKeys],
  )

  const recentFields = useMemo(
    () => recentFieldKeys
      .map((key) => entityFields.find((f) => f.key === key))
      .filter((f): f is MapFilterRegistryField => Boolean(f)),
    [entityFields, recentFieldKeys],
  )

  const fieldsByCategory = useMemo(() => {
    const map = new Map<string, MapFilterRegistryField[]>()
    for (const field of entityFields) {
      const list = map.get(field.category) ?? []
      list.push(field)
      map.set(field.category, list)
    }
    return map
  }, [entityFields])

  const renderFieldButton = (field: MapFilterRegistryField) => (
    <div key={field.key} className="mf-field-catalog__item">
      <button
        type="button"
        className="mf-field-catalog__field"
        onClick={() => {
          recordRecentField(field.key)
          onSelectField(field)
        }}
      >
        <span className="mf-field-catalog__field-label">{field.label}</span>
        <span className="mf-field-catalog__field-desc">{field.description}</span>
      </button>
      <button
        type="button"
        className={cls('mf-field-catalog__fav', favoriteFieldKeys.includes(field.key) && 'is-active')}
        aria-label={favoriteFieldKeys.includes(field.key) ? 'Remove favorite' : 'Add favorite'}
        onClick={() => toggleFavoriteField(field.key)}
      >
        ★
      </button>
    </div>
  )

  return (
    <div className="mf-field-catalog">
      {recentFields.length > 0 ? (
        <section className="mf-field-catalog__section">
          <h4 className="mf-field-catalog__heading">Recent</h4>
          <div className="mf-field-catalog__list">{recentFields.map(renderFieldButton)}</div>
        </section>
      ) : null}

      {favoriteFields.length > 0 ? (
        <section className="mf-field-catalog__section">
          <h4 className="mf-field-catalog__heading">Favorites</h4>
          <div className="mf-field-catalog__list">{favoriteFields.map(renderFieldButton)}</div>
        </section>
      ) : null}

      <section className="mf-field-catalog__section">
        <h4 className="mf-field-catalog__heading">Categories</h4>
        <div className="mf-field-catalog__categories">
          {categories.map((category) => {
            const categoryFields = fieldsByCategory.get(category) ?? []
            const isOpen = expandedCategory === category
            return (
              <div key={category} className="mf-field-catalog__category">
                <button
                  type="button"
                  className={cls('mf-field-catalog__category-btn', isOpen && 'is-open')}
                  onClick={() => setExpandedCategory(isOpen ? null : category)}
                >
                  <span>{category}</span>
                  <span className="mf-field-catalog__category-count">{categoryFields.length}</span>
                </button>
                {isOpen ? (
                  <div className="mf-field-catalog__list">{categoryFields.map(renderFieldButton)}</div>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}