import { useMemo } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { fieldMatchesEntity } from '../entity-utils'
import type { MapFilterRegistryField } from '../types'
import { cls } from '../utils'

export interface FieldCatalogProps {
  onSelectField: (field: MapFilterRegistryField) => void
}

export function FieldCatalog({ onSelectField }: FieldCatalogProps) {
  const {
    selectedEntity,
    fields,
    categoriesByEntity,
    favoriteFieldKeys,
    recentFieldKeys,
    toggleFavoriteField,
  } = useMasterFilters()

  const entityFields = useMemo(
    () => fields.filter((f) => fieldMatchesEntity(f, selectedEntity)),
    [fields, selectedEntity],
  )

  const favorites = useMemo(
    () => favoriteFieldKeys.map((key) => entityFields.find((f) => f.key === key)).filter(Boolean) as MapFilterRegistryField[],
    [entityFields, favoriteFieldKeys],
  )

  const recent = useMemo(
    () => recentFieldKeys.map((key) => entityFields.find((f) => f.key === key)).filter(Boolean) as MapFilterRegistryField[],
    [entityFields, recentFieldKeys],
  )

  const categories = categoriesByEntity[selectedEntity] ?? [...new Set(entityFields.map((f) => f.category))]

  const renderFieldRow = (field: MapFilterRegistryField) => (
    <div key={field.key} className="mf-field-row">
      <button type="button" className="mf-field-row__main" onClick={() => onSelectField(field)}>
        <span className="mf-field-row__label">{field.label}</span>
        <span className="mf-field-row__meta">{field.category}</span>
      </button>
      <button
        type="button"
        className={cls('mf-field-row__fav', favoriteFieldKeys.includes(field.key) && 'is-active')}
        aria-label={favoriteFieldKeys.includes(field.key) ? 'Remove favorite' : 'Add favorite'}
        onClick={() => toggleFavoriteField(field.key)}
      >
        ★
      </button>
    </div>
  )

  return (
    <div className="mf-catalog">
      {recent.length > 0 ? (
        <section className="mf-catalog__section">
          <h4>Recent fields</h4>
          <div className="mf-catalog__list">{recent.map(renderFieldRow)}</div>
        </section>
      ) : null}

      {favorites.length > 0 ? (
        <section className="mf-catalog__section">
          <h4>Favorites</h4>
          <div className="mf-catalog__list">{favorites.map(renderFieldRow)}</div>
        </section>
      ) : null}

      {categories.map((category) => {
        const rows = entityFields.filter((f) => f.category === category)
        if (!rows.length) return null
        return (
          <section key={category} className="mf-catalog__section">
            <h4>{category}</h4>
            <div className="mf-catalog__list">{rows.slice(0, 12).map(renderFieldRow)}</div>
          </section>
        )
      })}
    </div>
  )
}