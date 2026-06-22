import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { fetchCompIntelligence } from './comp-intelligence-api'
import { resolveCoordinatesFromContext, subjectHasCoordinates } from './coordinate-resolver'
import type { CompIntelligencePayload, ValuationPipelineState } from './types'

function mapPipelineState(payload: CompIntelligencePayload | null, loading: boolean, error: string | null): ValuationPipelineState {
  if (loading) return 'loading_evidence'
  if (error) return 'error'
  if (!payload) return 'blocked_missing_subject'
  const backendState = payload.valuation_state?.state
  switch (backendState) {
    case 'ready':
      return 'ready'
    case 'ready_with_limitations':
      return 'ready_with_limitations'
    case 'blocked_missing_subject':
      return 'blocked_missing_subject'
    case 'blocked_insufficient_evidence':
      return 'blocked_insufficient_evidence'
    case 'valuing':
      return 'valuing'
    case 'scoring_comps':
      return 'scoring_comps'
    default:
      return payload.discovery?.counts?.total ? 'scoring_comps' : 'searching_comps'
  }
}

export function useCompIntelligence({
  thread,
  dealContext,
  radius = 1,
  monthsBack = 6,
  assetClass,
  paused = false,
}: {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  radius?: number
  monthsBack?: number
  assetClass?: string
  paused?: boolean
}) {
  const t = thread as Record<string, unknown> | null
  const propertyId = String(dealContext?.propertyId || t?.propertyId || t?.property_id || '')
  const threadKey = String(dealContext?.threadKey || t?.thread_key || '')
  const opportunityId = String((dealContext as Record<string, unknown> | null)?.opportunityId || (t as Record<string, unknown>)?.opportunity_id || '')
  const masterOwnerId = String(dealContext?.masterOwnerId || t?.master_owner_id || '')

  const localCoords = useMemo(
    () =>
      resolveCoordinatesFromContext({
        dealContext: dealContext as Record<string, unknown> | null,
        thread: t,
        property: dealContext?.property as Record<string, unknown> | undefined,
        rawPayload: (dealContext?.property as Record<string, unknown> | undefined)?.raw_payload_json as Record<string, unknown> | undefined,
      }),
    [dealContext, t],
  )

  const [payload, setPayload] = useState<CompIntelligencePayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!propertyId) {
      setPayload(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCompIntelligence(
        propertyId,
        {
          radius,
          monthsBack,
          assetClass,
          threadKey: threadKey || null,
          opportunityId: opportunityId || null,
          masterOwnerId: masterOwnerId || null,
        },
        signal,
      )
      if (signal?.aborted) return
      setPayload(data)
      if (!data) setError('Comp intelligence pipeline returned no data')
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      setError((err as Error)?.message || 'Comp intelligence failed')
      setPayload(null)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [propertyId, radius, monthsBack, assetClass, threadKey, opportunityId, masterOwnerId])

  useEffect(() => {
    if (paused || !propertyId) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [paused, propertyId, radius, monthsBack, assetClass, refresh])

  const subject = payload?.subject ?? null
  const coords = useMemo(() => {
    if (subject?.is_subject_resolved && subject.latitude?.value != null && subject.longitude?.value != null) {
      return {
        latitude: subject.latitude.value,
        longitude: subject.longitude.value,
        lat: subject.latitude.value,
        lng: subject.longitude.value,
        coordinate_source: subject.coordinate_source,
        coordinate_confidence: subject.coordinate_confidence,
        is_market_fallback: subject.is_market_fallback,
        is_subject_resolved: true,
        failure_reason: subject.coordinate_failure_reason ?? null,
      }
    }
    return localCoords
  }, [subject, localCoords])

  const pipelineState = mapPipelineState(payload, loading, error)

  return {
    propertyId,
    payload,
    subject,
    coords,
    hasCoords: subjectHasCoordinates(coords),
    discovery: payload?.discovery ?? null,
    valuation: payload?.valuation ?? null,
    valuationState: payload?.valuation_state ?? null,
    pipelineState,
    loading,
    error,
    refresh,
  }
}