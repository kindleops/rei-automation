import { useCallback, useEffect, useRef, useState } from 'react'

import { previewMapFilter } from '../api'
import type { AdvancedMapFilterGroup, MapFilterBounds, MapFilterPreviewCounts } from '../types'

const PREVIEW_DEBOUNCE_MS = 450

export interface UseMapFilterPreviewOptions {
  enabled?: boolean
}

export interface UseMapFilterPreviewResult {
  previewCounts: MapFilterPreviewCounts | null
  lastValidPreviewCounts: MapFilterPreviewCounts | null
  previewLoading: boolean
  previewError: string | null
  previewDurationMs: number | null
  refreshPreview: () => void
}

export function useMapFilterPreview(
  expression: AdvancedMapFilterGroup,
  bounds?: MapFilterBounds | null,
  options: UseMapFilterPreviewOptions = {},
): UseMapFilterPreviewResult {
  const enabled = options.enabled !== false
  const [previewCounts, setPreviewCounts] = useState<MapFilterPreviewCounts | null>(null)
  const [lastValidPreviewCounts, setLastValidPreviewCounts] = useState<MapFilterPreviewCounts | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDurationMs, setPreviewDurationMs] = useState<number | null>(null)
  const requestId = useRef(0)

  const runPreview = useCallback(async () => {
    if (!enabled) {
      setPreviewLoading(false)
      setPreviewError(null)
      return
    }

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
    setLastValidPreviewCounts(result.data.counts)
  }, [bounds, enabled, expression])

  useEffect(() => {
    if (!enabled) {
      setPreviewLoading(false)
      setPreviewError(null)
      return
    }

    const timer = setTimeout(() => {
      void runPreview()
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, runPreview])

  return {
    previewCounts,
    lastValidPreviewCounts,
    previewLoading,
    previewError,
    previewDurationMs,
    refreshPreview: runPreview,
  }
}