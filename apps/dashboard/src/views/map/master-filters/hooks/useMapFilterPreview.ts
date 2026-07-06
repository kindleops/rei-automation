import { useCallback, useEffect, useRef, useState } from 'react'

import { previewMapFilter } from '../api'
import type { AdvancedMapFilterGroup, MapFilterBounds, MapFilterPreviewCounts } from '../types'

const PREVIEW_DEBOUNCE_MS = 450

export interface UseMapFilterPreviewResult {
  previewCounts: MapFilterPreviewCounts | null
  previewLoading: boolean
  previewError: string | null
  previewDurationMs: number | null
  refreshPreview: () => void
}

export function useMapFilterPreview(
  expression: AdvancedMapFilterGroup,
  bounds?: MapFilterBounds | null,
): UseMapFilterPreviewResult {
  const [previewCounts, setPreviewCounts] = useState<MapFilterPreviewCounts | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDurationMs, setPreviewDurationMs] = useState<number | null>(null)
  const requestId = useRef(0)

  const runPreview = useCallback(async () => {
    const id = ++requestId.current
    setPreviewLoading(true)
    setPreviewError(null)

    const started = performance.now()
    const result = await previewMapFilter(expression, bounds)
    if (id !== requestId.current) return

    setPreviewLoading(false)
    setPreviewDurationMs(Math.round(performance.now() - started))

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
    previewDurationMs,
    refreshPreview: runPreview,
  }
}