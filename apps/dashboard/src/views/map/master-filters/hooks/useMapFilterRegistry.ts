import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchMapFilterRegistry } from '../api'
import { normalizeRegistryField } from '../entity-utils'
import type { MapFilterEntity, MapFilterRegistryField, MapFilterRegistryResponse } from '../types'

export interface UseMapFilterRegistryResult {
  registry: MapFilterRegistryResponse | null
  fields: MapFilterRegistryField[]
  fieldsByEntity: Partial<Record<MapFilterEntity, MapFilterRegistryField[]>>
  categoriesByEntity: Partial<Record<MapFilterEntity, string[]>>
  registryLoading: boolean
  registryError: string | null
  refreshRegistry: (q?: string) => Promise<void>
}

export function useMapFilterRegistry(initialQuery = ''): UseMapFilterRegistryResult {
  const [registry, setRegistry] = useState<MapFilterRegistryResponse | null>(null)
  const [registryLoading, setRegistryLoading] = useState(true)
  const [registryError, setRegistryError] = useState<string | null>(null)

  const refreshRegistry = useCallback(async (q = initialQuery) => {
    setRegistryLoading(true)
    setRegistryError(null)
    const result = await fetchMapFilterRegistry(q)
    setRegistryLoading(false)
    if (!result.ok) {
      setRegistryError(result.message || result.error)
      return
    }
    setRegistry({
      ...result.data,
      fields: result.data.fields.map(normalizeRegistryField),
    })
  }, [initialQuery])

  useEffect(() => {
    void refreshRegistry(initialQuery)
  }, [refreshRegistry, initialQuery])

  const fields = useMemo(() => registry?.fields ?? [], [registry])

  const fieldsByEntity = useMemo(() => {
    const map: Partial<Record<MapFilterEntity, MapFilterRegistryField[]>> = {}
    for (const field of fields) {
      const entity = field.entity as MapFilterEntity
      if (!map[entity]) map[entity] = []
      map[entity]!.push(field)
    }
    return map
  }, [fields])

  const categoriesByEntity = useMemo(() => {
    const map: Partial<Record<MapFilterEntity, string[]>> = {}
    for (const field of fields) {
      const entity = field.entity as MapFilterEntity
      if (!map[entity]) map[entity] = []
      if (!map[entity]!.includes(field.category)) map[entity]!.push(field.category)
    }
    for (const key of Object.keys(map) as MapFilterEntity[]) {
      map[key]!.sort((a, b) => a.localeCompare(b))
    }
    return map
  }, [fields])

  return {
    registry,
    fields,
    fieldsByEntity,
    categoriesByEntity,
    registryLoading,
    registryError,
    refreshRegistry,
  }
}