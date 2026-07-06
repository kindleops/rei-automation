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
import { CANONICAL_PROPERTY_BASELINE } from './constants'
import {
  validateDraftExpression,
  expressionIsPreviewable,
  type ExpressionValidationIssue,
} from './expression-validation'
import { countActiveRules, createEmptyExpression, cloneExpression } from './expression-utils'
import { useMapFilterPreview } from './hooks/useMapFilterPreview'
import { useMapFilterRegistry } from './hooks/useMapFilterRegistry'
import type {
  AdvancedMapFilterGroup,
  MapFilterBounds,
  MapFilterEntity,
  MapFilterPreviewCounts,
  MapFilterPreviewStatus,
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
    token: string | null
    expression: AdvancedMapFilterGroup
    summary: string
    activeRuleCount: number
    matchingProperties: number
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
  previewDurationMs: number | null
  previewStatus: MapFilterPreviewStatus
  validationIssues: ExpressionValidationIssue[]
  canPreview: boolean
  canApply: boolean
  matchingPropertyCount: number | null
  matchingPropertyCountLabel: string
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
  isDraftDirty: boolean
  showSavedDrawer: boolean
  setShowSavedDrawer: (open: boolean) => void
  refreshPreview: () => void
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
  const [showSavedDrawer, setShowSavedDrawer] = useState(false)
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

  const activeRuleCount = useMemo(() => countActiveRules(draftExpression), [draftExpression])

  const validation = useMemo(
    () => validateDraftExpression(draftExpression, fields),
    [draftExpression, fields],
  )

  const canPreview = useMemo(
    () => expressionIsPreviewable(draftExpression, fields),
    [draftExpression, fields],
  )

  const {
    previewCounts,
    lastValidPreviewCounts,
    previewLoading,
    previewError,
    previewDurationMs,
    refreshPreview,
  } = useMapFilterPreview(draftExpression, bounds, { enabled: canPreview })

  const previewStatus: MapFilterPreviewStatus = useMemo(() => {
    if (activeRuleCount === 0) {
      if (previewLoading) return 'loading'
      if (previewError) return 'failed'
      if (previewCounts) return 'baseline'
      return 'baseline'
    }
    if (!canPreview) return 'incomplete'
    if (previewLoading) return lastValidPreviewCounts ? 'stale' : 'loading'
    if (previewError) return 'failed'
    if (previewCounts) return 'valid'
    return 'loading'
  }, [
    activeRuleCount,
    canPreview,
    lastValidPreviewCounts,
    previewCounts,
    previewError,
    previewLoading,
  ])

  const matchingPropertyCount = useMemo(() => {
    if (activeRuleCount === 0) {
      if (previewCounts?.matchingProperties != null && !previewError) {
        return previewCounts.matchingProperties
      }
      return CANONICAL_PROPERTY_BASELINE
    }
    if (!canPreview) return null
    if (previewStatus === 'failed') return null
    if (previewStatus === 'loading') return lastValidPreviewCounts?.matchingProperties ?? null
    if (previewStatus === 'stale') return lastValidPreviewCounts?.matchingProperties ?? null
    return previewCounts?.matchingProperties ?? null
  }, [
    activeRuleCount,
    canPreview,
    lastValidPreviewCounts,
    previewCounts,
    previewError,
    previewStatus,
  ])

  const matchingPropertyCountLabel = useMemo(() => {
    if (activeRuleCount === 0) return 'All authorized properties'
    if (!canPreview) return 'Complete the highlighted rule'
    if (previewStatus === 'loading') return 'Refreshing count…'
    if (previewStatus === 'stale') return 'Refreshing count…'
    if (previewStatus === 'failed') return 'Could not preview this filter'
    if (previewStatus === 'valid' && matchingPropertyCount != null) return 'Preview updated'
    return `${activeRuleCount} active rule${activeRuleCount === 1 ? '' : 's'}`
  }, [activeRuleCount, canPreview, matchingPropertyCount, previewStatus])

  const canApply = useMemo(() => {
    if (applyLoading) return false
    if (activeRuleCount === 0) return true
    if (!canPreview) return false
    if (previewLoading) return false
    if (previewError) return false
    if (matchingPropertyCount == null) return false
    return true
  }, [activeRuleCount, applyLoading, canPreview, matchingPropertyCount, previewError, previewLoading])

  const isDraftDirty = useMemo(() => {
    if (!appliedExpression && activeRuleCount === 0) return false
    return JSON.stringify(draftExpression) !== JSON.stringify(appliedExpression ?? createEmptyExpression())
  }, [activeRuleCount, appliedExpression, draftExpression])

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
    if (!canApply && activeRuleCount > 0) return false

    setApplyLoading(true)
    setApplyError(null)

    if (activeRuleCount === 0) {
      const empty = createEmptyExpression()
      setDraftExpression(empty)
      setAppliedToken(null)
      setAppliedExpression(null)
      setApplyLoading(false)
      onClear?.()
      onApply?.({
        token: null,
        expression: empty,
        summary: 'All authorized properties',
        activeRuleCount: 0,
        matchingProperties: matchingPropertyCount ?? CANONICAL_PROPERTY_BASELINE,
      })
      return true
    }

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
      matchingProperties: matchingPropertyCount ?? CANONICAL_PROPERTY_BASELINE,
    })
    return true
  }, [activeRuleCount, canApply, draftExpression, matchingPropertyCount, onApply, onClear])

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
      previewCounts: canPreview ? previewCounts : null,
      previewLoading: canPreview ? previewLoading : false,
      previewError: canPreview ? previewError : null,
      previewDurationMs,
      previewStatus,
      validationIssues: validation.issues,
      canPreview,
      canApply,
      matchingPropertyCount,
      matchingPropertyCountLabel,
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
      isDraftDirty,
      showSavedDrawer,
      setShowSavedDrawer,
      refreshPreview,
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
      previewDurationMs,
      previewStatus,
      validation.issues,
      canPreview,
      canApply,
      matchingPropertyCount,
      matchingPropertyCountLabel,
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
      isDraftDirty,
      showSavedDrawer,
      refreshPreview,
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