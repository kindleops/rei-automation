import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { createMapFilterToken } from './api'
import { countActiveRules, createEmptyExpression, cloneExpression } from './expression-utils'
import { useMapFilterPreview } from './hooks/useMapFilterPreview'
import { useMapFilterRegistry } from './hooks/useMapFilterRegistry'
import type {
  AdvancedMapFilterGroup,
  MapFilterBounds,
  MapFilterEntity,
  MapFilterPreviewCounts,
  MapFilterRegistryField,
  MapFilterRegistryResponse,
  MasterFiltersMobilePane,
} from './types'

const FAVORITES_KEY = 'mf:favoriteFieldKeys'
const RECENT_KEY = 'mf:recentFieldKeys'
const MAX_RECENT = 12

export interface MasterFiltersProviderProps {
  children: ReactNode
  bounds?: MapFilterBounds | null
  initialExpression?: AdvancedMapFilterGroup
  initialToken?: string | null
  onApply?: (payload: {
    token: string
    expression: AdvancedMapFilterGroup
    summary: string
    activeRuleCount: number
  }) => void
  onClear?: () => void
}

export interface MasterFiltersContextValue {
  draftExpression: AdvancedMapFilterGroup
  setDraftExpression: (expression: AdvancedMapFilterGroup) => void
  appliedToken: string | null
  appliedExpression: AdvancedMapFilterGroup | null
  applyFilters: () => Promise<boolean>
  clearFilters: () => void
  applyLoading: boolean
  applyError: string | null
  previewCounts: MapFilterPreviewCounts | null
  previewLoading: boolean
  previewError: string | null
  registry: MapFilterRegistryResponse | null
  fields: MapFilterRegistryField[]
  fieldsByEntity: Partial<Record<MapFilterEntity, MapFilterRegistryField[]>>
  categoriesByEntity: Partial<Record<MapFilterEntity, string[]>>
  registryLoading: boolean
  registryError: string | null
  refreshRegistry: (q?: string) => Promise<void>
  favoriteFieldKeys: string[]
  recentFieldKeys: string[]
  toggleFavoriteField: (fieldKey: string) => void
  recordRecentField: (fieldKey: string) => void
  selectedEntity: MapFilterEntity
  setSelectedEntity: (entity: MapFilterEntity) => void
  mobilePane: MasterFiltersMobilePane
  setMobilePane: (pane: MasterFiltersMobilePane) => void
  activeRuleCount: number
  showSavedLibrary: boolean
  setShowSavedLibrary: (open: boolean) => void
}

const MasterFiltersContext = createContext<MasterFiltersContextValue | null>(null)

function readStringList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeStringList(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values))
  } catch {
    // ignore quota errors
  }
}

export function MasterFiltersProvider({
  children,
  bounds = null,
  initialExpression,
  initialToken = null,
  onApply,
  onClear,
}: MasterFiltersProviderProps) {
  const [draftExpression, setDraftExpression] = useState<AdvancedMapFilterGroup>(
    () => initialExpression ? cloneExpression(initialExpression) : createEmptyExpression(),
  )
  const [appliedToken, setAppliedToken] = useState<string | null>(initialToken)
  const [appliedExpression, setAppliedExpression] = useState<AdvancedMapFilterGroup | null>(
    initialExpression ? cloneExpression(initialExpression) : null,
  )
  const [applyLoading, setApplyLoading] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<MapFilterEntity>('property')
  const [mobilePane, setMobilePane] = useState<MasterFiltersMobilePane>('discover')
  const [showSavedLibrary, setShowSavedLibrary] = useState(false)
  const [favoriteFieldKeys, setFavoriteFieldKeys] = useState<string[]>(() => readStringList(FAVORITES_KEY))
  const [recentFieldKeys, setRecentFieldKeys] = useState<string[]>(() => readStringList(RECENT_KEY))

  const {
    registry,
    fields,
    fieldsByEntity,
    categoriesByEntity,
    registryLoading,
    registryError,
    refreshRegistry,
  } = useMapFilterRegistry()

  const {
    previewCounts,
    previewLoading,
    previewError,
  } = useMapFilterPreview(draftExpression, bounds)

  const activeRuleCount = useMemo(() => countActiveRules(draftExpression), [draftExpression])

  useEffect(() => {
    writeStringList(FAVORITES_KEY, favoriteFieldKeys)
  }, [favoriteFieldKeys])

  useEffect(() => {
    writeStringList(RECENT_KEY, recentFieldKeys)
  }, [recentFieldKeys])

  const toggleFavoriteField = useCallback((fieldKey: string) => {
    setFavoriteFieldKeys((current) =>
      current.includes(fieldKey)
        ? current.filter((k) => k !== fieldKey)
        : [fieldKey, ...current].slice(0, 24),
    )
  }, [])

  const recordRecentField = useCallback((fieldKey: string) => {
    setRecentFieldKeys((current) => [fieldKey, ...current.filter((k) => k !== fieldKey)].slice(0, MAX_RECENT))
  }, [])

  const applyFilters = useCallback(async () => {
    if (activeRuleCount === 0) {
      setApplyError('Add at least one filter rule before applying.')
      return false
    }

    setApplyLoading(true)
    setApplyError(null)
    const result = await createMapFilterToken(draftExpression)
    setApplyLoading(false)

    if (!result.ok) {
      setApplyError(result.message || result.error)
      return false
    }

    const nextExpression = cloneExpression(draftExpression)
    setAppliedToken(result.data.filterToken)
    setAppliedExpression(nextExpression)
    onApply?.({
      token: result.data.filterToken,
      expression: nextExpression,
      summary: result.data.summary,
      activeRuleCount: result.data.activeRuleCount,
    })
    return true
  }, [activeRuleCount, draftExpression, onApply])

  const clearFilters = useCallback(() => {
    const empty = createEmptyExpression()
    setDraftExpression(empty)
    setAppliedToken(null)
    setAppliedExpression(null)
    setApplyError(null)
    onClear?.()
  }, [onClear])

  const value = useMemo<MasterFiltersContextValue>(
    () => ({
      draftExpression,
      setDraftExpression,
      appliedToken,
      appliedExpression,
      applyFilters,
      clearFilters,
      applyLoading,
      applyError,
      previewCounts,
      previewLoading,
      previewError,
      registry,
      fields,
      fieldsByEntity,
      categoriesByEntity,
      registryLoading,
      registryError,
      refreshRegistry,
      favoriteFieldKeys,
      recentFieldKeys,
      toggleFavoriteField,
      recordRecentField,
      selectedEntity,
      setSelectedEntity,
      mobilePane,
      setMobilePane,
      activeRuleCount,
      showSavedLibrary,
      setShowSavedLibrary,
    }),
    [
      draftExpression,
      appliedToken,
      appliedExpression,
      applyFilters,
      clearFilters,
      applyLoading,
      applyError,
      previewCounts,
      previewLoading,
      previewError,
      registry,
      fields,
      fieldsByEntity,
      categoriesByEntity,
      registryLoading,
      registryError,
      refreshRegistry,
      favoriteFieldKeys,
      recentFieldKeys,
      toggleFavoriteField,
      recordRecentField,
      selectedEntity,
      mobilePane,
      activeRuleCount,
      showSavedLibrary,
    ],
  )

  return (
    <MasterFiltersContext.Provider value={value}>
      {children}
    </MasterFiltersContext.Provider>
  )
}

export function useMasterFilters(): MasterFiltersContextValue {
  const ctx = useContext(MasterFiltersContext)
  if (!ctx) throw new Error('useMasterFilters must be used within MasterFiltersProvider')
  return ctx
}