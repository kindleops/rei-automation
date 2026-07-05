import type { MapFilterEntity, MapFilterRegistryField, RegistryEntity } from './types'
import { MAP_FILTER_ENTITIES } from './types'

/** Normalize registry `owner` → `master_owner` for UI entity rail. */
export function normalizeRegistryEntity(entity: RegistryEntity): MapFilterEntity | null {
  if (entity === 'owner') return 'master_owner'
  if (entity === 'geo') return null
  if (MAP_FILTER_ENTITIES.includes(entity as MapFilterEntity)) return entity as MapFilterEntity
  return null
}

export function normalizeRegistryField(field: MapFilterRegistryField): MapFilterRegistryField {
  const entity = normalizeRegistryEntity(field.entity)
  if (!entity) return field
  if (entity === field.entity) return field
  return { ...field, entity: entity as MapFilterRegistryField['entity'] }
}

export function fieldMatchesEntity(field: MapFilterRegistryField, entity: MapFilterEntity): boolean {
  return normalizeRegistryEntity(field.entity) === entity
}