import { useCallback, useEffect, useRef, useState } from 'react'

import { previewMapFilter } from '../api'
import type { AdvancedMapFilterGroup, MapFilterBounds, MapFilterPreviewCounts } from '../types'
import { countActiveRules } from '../expression-utils'

const PREVIEW_DEBOUNCE_MS = 500

export interface UseMapFilterPreviewResult {
  previewCounts: MapFilterPreviewCounts | null
  previewLoading: boolean
  previewError: string | null
  refreshPreview: () => void
}

export function useMapFilterPreview(
  expression: AdvancedMapFilterGroup,
  bounds?: MapFilterBounds | null,
): UseMapFilterPreviewResult {
  const [previewCounts, setPreviewCounts] = useState<MapFilterPreviewCounts | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const requestId = useRef(0)

  const runPreview = useCallback(async () => {
    const activeRules = countActiveRules(expression)
    if (activeRules === 0) {
      setPreviewCounts(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }

    const id = ++requestId.current
    setPreviewLoading(true)
    setPreviewError(null)

    const result = await previewMapFilter(expression, bounds)
    if (id !== requestId.current) return

    setPreviewLoading(false)
    if (!result.ok) {
      setPreviewError(result.message || result.error)
      return
    }
    setPreviewCounts(result.data.counts)
  }, [expression, bounds])

  useEffect(() => {
    const timer = setTimeout(() => {
      void runPreview()
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [runPreview])

  return {
    previewCounts,
    previewLoading,
    previewError,
    refreshPreview: runPreview,
  }
}