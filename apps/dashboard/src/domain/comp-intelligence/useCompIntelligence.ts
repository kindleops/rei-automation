import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { resolveCanonicalProperty } from '../canonical-property/resolver'
import { fetchCompIntelligence } from './comp-intelligence-api'
import { runDirectCompIntelligence } from './direct-pipeline'
import { subjectHasCoordinates } from './coordinate-resolver'
import type { CompIntelligencePayload, ValuationPipelineState } from './types'

function mapPipelineState(payload: CompIntelligencePayload | null, loading: boolean, error: string | null): ValuationPipelineState {
  if (loading) return 'loading_evidence'
  if (error && !payload) return 'error'
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
  const opportunityId = String((dealContext as Record<string, unknown> | null)?.opportunityId || (t as Record<string, unknown>)?.opportunity_id || '')

  const canonical = useMemo(
    () => resolveCanonicalProperty({ dealContext, thread, opportunityId }),
    [dealContext, thread, opportunityId],
  )

  const propertyId = canonical?.property_id || ''
  const threadKey = String(dealContext?.threadKey || dealContext?.thread_key || t?.thread_key || '')
  const masterOwnerId = String(dealContext?.masterOwnerId || dealContext?.master_owner_id || t?.master_owner_id || '')

  const [payload, setPayload] = useState<CompIntelligencePayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<'api' | 'direct_rpc' | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!propertyId) {
      setPayload(null)
      setDataSource(null)
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

      if (data?.subject?.is_subject_resolved && (data.discovery?.counts?.total ?? 0) > 0) {
        setPayload(data)
        setDataSource('api')
        return
      }

      const direct = await runDirectCompIntelligence({
        dealContext,
        thread,
        radius,
        monthsBack,
        opportunityId,
      })
      if (signal?.aborted) return

      if (direct) {
        setPayload(direct)
        setDataSource('direct_rpc')
        if (!data) setError('API pipeline unavailable — loaded via direct property RPC')
        return
      }

      setPayload(data)
      setDataSource(data ? 'api' : null)
      if (!data) setError('Comp intelligence pipeline returned no data')
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      try {
        const direct = await runDirectCompIntelligence({
          dealContext,
          thread,
          radius,
          monthsBack,
          opportunityId,
        })
        if (signal?.aborted) return
        if (direct) {
          setPayload(direct)
          setDataSource('direct_rpc')
          setError((err as Error)?.message || 'API failed — recovered via direct RPC')
          return
        }
      } catch {
        // fall through
      }
      setError((err as Error)?.message || 'Comp intelligence failed')
      setPayload(null)
      setDataSource(null)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [propertyId, radius, monthsBack, assetClass, threadKey, opportunityId, masterOwnerId, dealContext, thread])

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
        is_market_fallback: false,
        is_subject_resolved: true,
        failure_reason: null,
      }
    }

    if (canonical?.is_subject_resolved && canonical.latitude !== null && canonical.longitude !== null) {
      return {
        latitude: canonical.latitude,
        longitude: canonical.longitude,
        lat: canonical.latitude,
        lng: canonical.longitude,
        coordinate_source: canonical.coordinate_source,
        coordinate_confidence: canonical.coordinate_confidence,
        is_market_fallback: false,
        is_subject_resolved: true,
        failure_reason: null,
      }
    }

    return {
      latitude: null,
      longitude: null,
      lat: null,
      lng: null,
      coordinate_source: canonical?.coordinate_source || 'unresolved',
      coordinate_confidence: canonical?.coordinate_confidence || 0,
      is_market_fallback: false,
      is_subject_resolved: false,
      failure_reason: canonical?.coordinate_failure_reason || 'Subject coordinates unresolved',
    }
  }, [subject, canonical])

  const pipelineState = mapPipelineState(payload, loading, error)

  return {
    propertyId,
    canonical,
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
    dataSource,
    refresh,
  }
}