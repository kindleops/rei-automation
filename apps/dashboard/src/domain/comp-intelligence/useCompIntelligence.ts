import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getNextExpansionStep } from './direct-pipeline'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { resolveCanonicalProperty } from '../canonical-property/resolver'
import { fetchCanonicalSubjectProperty, fetchCompIntelligence } from './comp-intelligence-api'
import { mapCandidatesToDegradedEvidence } from './degraded-evidence'
import { runDirectCompIntelligence } from './direct-pipeline'
import { fetchPropertyRecord } from './property-record-loader'
import { subjectHasCoordinates } from './coordinate-resolver'
import type { CompIntelligencePayload, ValuationPipelineState } from './types'

function enrichPayloadEvidence(payload: CompIntelligencePayload): CompIntelligencePayload {
  const candidates = payload.discovery?.candidates ?? []
  if (payload.transaction_evidence?.length || !candidates.length) return payload
  return {
    ...payload,
    transaction_evidence: mapCandidatesToDegradedEvidence(
      candidates,
      payload.discovery?.is_market_fallback ? 'MARKET_FALLBACK' : 'API_DISCOVERY',
    ),
  }
}

function mergeSubject(
  payload: CompIntelligencePayload,
  serverSubject: CompIntelligencePayload['subject'] | null,
): CompIntelligencePayload {
  if (!serverSubject?.is_subject_resolved) return payload
  return { ...payload, subject: serverSubject }
}

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
      return payload.discovery?.counts?.total ? 'scoring_comps' : 'blocked_insufficient_evidence'
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
  initialRadius = 1,
  initialMonthsBack = 12,
  assetClass,
  paused = false,
}: {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  initialRadius?: number
  initialMonthsBack?: number
  assetClass?: string
  paused?: boolean
}) {
  const [radius, setRadius] = useState(initialRadius)
  const t = thread as Record<string, unknown> | null
  const opportunityId = String((dealContext as Record<string, unknown> | null)?.opportunityId || t?.opportunity_id || '')

  const [propertyRecord, setPropertyRecord] = useState<Record<string, unknown> | null>(null)

  const canonical = useMemo(
    () => resolveCanonicalProperty({ dealContext, thread, opportunityId, propertyRecord }),
    [dealContext, thread, opportunityId, propertyRecord],
  )

  const propertyId = canonical?.property_id || ''
  const threadKey = String(dealContext?.threadKey || dealContext?.thread_key || t?.thread_key || '')
  const masterOwnerId = String(dealContext?.masterOwnerId || dealContext?.master_owner_id || t?.master_owner_id || '')

  const [payload, setPayload] = useState<CompIntelligencePayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<'api' | 'direct_rpc' | null>(null)
  const [monthsBack, setMonthsBack] = useState(initialMonthsBack)
  const [expansionLog, setExpansionLog] = useState<string | null>(null)
  const priorSearchRef = useRef<{ radius: number; monthsBack: number; count: number } | null>(null)
  const pendingExpansionRef = useRef<{ fromRadius: number; fromMonths: number; fromCount: number } | null>(null)

  useEffect(() => {
    if (!propertyId) {
      setPropertyRecord(null)
      return
    }
    let cancelled = false
    void fetchPropertyRecord(propertyId).then((row) => {
      if (!cancelled) setPropertyRecord(row)
    })
    return () => { cancelled = true }
  }, [propertyId])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!propertyId) {
      setPayload(null)
      setDataSource(null)
      return
    }
    setLoading(true)
    setError(null)

    const hydratedRecord = propertyRecord ?? await fetchPropertyRecord(propertyId)

    try {
      const [apiData, serverSubject, direct] = await Promise.all([
        fetchCompIntelligence(
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
        ).catch(() => null),
        fetchCanonicalSubjectProperty(
          propertyId,
          { threadKey: threadKey || null, opportunityId: opportunityId || null },
          signal,
        ).catch(() => null),
        runDirectCompIntelligence({
          dealContext,
          thread,
          radius,
          monthsBack,
          opportunityId,
          propertyRecord: hydratedRecord,
        }).catch(() => null),
      ])

      if (signal?.aborted) return

      if (apiData?.decision_projection?.projection_mode === 'authoritative_v3') {
        const merged = enrichPayloadEvidence(mergeSubject(apiData, serverSubject))
        setPayload({ ...merged, data_source_mode: 'api' })
        setDataSource('api')
        setError(null)
        return
      }

      let mergedApi = apiData ? enrichPayloadEvidence(mergeSubject(apiData, serverSubject)) : null
      let mergedDirect = direct
        ? (serverSubject?.is_subject_resolved ? mergeSubject(direct, serverSubject) : direct)
        : null

      const apiEvidenceCount = mergedApi?.transaction_evidence?.length ?? mergedApi?.discovery?.counts?.total ?? 0
      const directEvidenceCount = mergedDirect?.transaction_evidence?.length ?? mergedDirect?.discovery?.counts?.total ?? 0

      if (directEvidenceCount > apiEvidenceCount && mergedDirect) {
        setPayload({ ...mergedDirect, data_source_mode: 'EVIDENCE_ONLY_DEGRADED' })
        setDataSource('direct_rpc')
        setError(directEvidenceCount > 0 ? null : 'V3 decision unavailable — no comp evidence recovered')
        return
      }

      if (mergedApi && (apiEvidenceCount > 0 || mergedApi.decision_projection)) {
        if (!mergedApi.transaction_evidence?.length && (mergedApi.discovery?.counts?.total ?? 0) > 0) {
          mergedApi = enrichPayloadEvidence(mergedApi)
        }
        setPayload({
          ...mergedApi,
          data_source_mode: mergedApi.decision_projection?.projection_mode === 'authoritative_v3'
            ? 'api'
            : 'EVIDENCE_ONLY_DEGRADED',
        })
        setDataSource('api')
        setError(apiEvidenceCount > 0 ? null : 'V3 decision unavailable — no comp evidence recovered')
        return
      }

      if (mergedDirect) {
        setPayload({ ...mergedDirect, data_source_mode: 'EVIDENCE_ONLY_DEGRADED' })
        setDataSource('direct_rpc')
        setError(directEvidenceCount > 0 ? null : 'V3 decision unavailable — no comp evidence recovered')
        return
      }

      setPayload(mergedApi)
      setDataSource(mergedApi ? 'api' : null)
      if (!mergedApi) setError('Comp intelligence pipeline returned no data')
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      try {
        const direct = await runDirectCompIntelligence({
          dealContext,
          thread,
          radius,
          monthsBack,
          opportunityId,
          propertyRecord: hydratedRecord ?? await fetchPropertyRecord(propertyId),
        })
        if (signal?.aborted) return
        if (direct) {
          setPayload({ ...direct, data_source_mode: 'EVIDENCE_ONLY_DEGRADED' })
          setDataSource('direct_rpc')
          setError((direct.discovery?.counts?.total ?? 0) > 0 ? null : (err as Error)?.message || 'API failed')
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
  }, [propertyId, radius, monthsBack, assetClass, threadKey, opportunityId, masterOwnerId, dealContext, thread, propertyRecord])

  useEffect(() => {
    if (paused || !propertyId) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh identity is stable enough; avoid aborting in-flight RPC on unrelated renders
  }, [paused, propertyId, radius, monthsBack, assetClass])

  useEffect(() => {
    const count = payload?.discovery?.counts?.total
      ?? payload?.transaction_evidence?.length
      ?? 0
    const pending = pendingExpansionRef.current
    if (pending && count >= 0) {
      const added = Math.max(0, count - pending.fromCount)
      setExpansionLog(
        `Expanded from ${pending.fromRadius} mi / ${pending.fromMonths} months to ${radius} mi / ${monthsBack} months. Found ${added} additional sale${added === 1 ? '' : 's'}.`,
      )
      pendingExpansionRef.current = null
    }
    priorSearchRef.current = { radius, monthsBack, count }
  }, [payload, radius, monthsBack])

  const findMoreComps = useCallback(() => {
    const next = getNextExpansionStep(radius, monthsBack)
    if (!next) {
      setExpansionLog('Search already at maximum expansion.')
      return false
    }
    const currentCount = payload?.discovery?.counts?.total
      ?? payload?.transaction_evidence?.length
      ?? 0
    pendingExpansionRef.current = {
      fromRadius: radius,
      fromMonths: monthsBack,
      fromCount: currentCount,
    }
    setRadius(next.radius)
    setMonthsBack(next.monthsBack)
    return true
  }, [radius, monthsBack, payload])

  const canExpandFurther = getNextExpansionStep(radius, monthsBack) != null

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
        is_market_fallback: canonical.is_market_fallback,
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
      is_market_fallback: canonical?.is_market_fallback ?? false,
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
    radius,
    setRadius,
    monthsBack,
    setMonthsBack,
    expansionLog,
    findMoreComps,
    canExpandFurther,
    refresh,
  }
}