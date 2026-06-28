import { useCallback, useEffect, useRef, useState } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import type { BuyerMatchSubjectContext, BuyerMatchV4Projection } from './buyer-match-v4.types'
import { subjectContextKey } from './buildSubjectContext'

export interface UseBuyerMatchV4ProjectionResult {
  projection: BuyerMatchV4Projection | null
  loading: boolean
  refreshing: boolean
  error: string | null
  refresh: () => void
}

export function shouldRejectStaleProjection(
  requestPropertyId: string | null,
  activePropertyId: string | null,
): boolean {
  if (!requestPropertyId || !activePropertyId) return false
  return requestPropertyId !== activePropertyId
}

function projectionCacheKey(subject: BuyerMatchSubjectContext): string {
  return [
    subject.propertyId ?? 'none',
    subject.valuationSnapshotId ?? '',
    subject.canonicalAddress,
  ].join('|')
}

export function useBuyerMatchV4Projection(
  subject: BuyerMatchSubjectContext,
  paused = false,
): UseBuyerMatchV4ProjectionResult {
  const [projection, setProjection] = useState<BuyerMatchV4Projection | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const subjectRef = useRef(subject)
  subjectRef.current = subject

  const run = useCallback(async (current: BuyerMatchSubjectContext, refresh = false) => {
    const propertyId = current.propertyId
    if (!propertyId || paused) {
      setProjection(null)
      setLoading(false)
      setRefreshing(false)
      return
    }

    const requestKey = subjectContextKey(current)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (projection && refresh) setRefreshing(true)
    else if (!projection) setLoading(true)
    setError(null)

    try {
      const res = await callBackend<BuyerMatchV4Projection>(
        '/api/cockpit/buyer-match-v4/projection',
        {
          method: 'POST',
          body: JSON.stringify({
            property_id: propertyId,
            refresh,
            canonical_address: current.canonicalAddress,
            valuation_snapshot_id: current.valuationSnapshotId,
            strategy: current.strategy,
            execution_state: current.executionState,
            repair_estimate: current.repairEstimate,
            acquisition_v3: {
              strategy: current.strategy,
              execution_state: current.executionState,
              value_contract: {
                qualified_market_value: current.marketValue != null ? { mid: current.marketValue } : null,
                qualified_buyer_exit: {
                  conservative: current.buyerExitLow,
                  base: current.buyerExitBase,
                  optimistic: current.buyerExitHigh,
                },
              },
            },
          }),
          signal: controller.signal,
        },
      )

      if (controller.signal.aborted) return
      if (shouldRejectStaleProjection(requestKey, subjectContextKey(subjectRef.current))) return

      if (!res.ok) {
        setError(res.message || 'projection_failed')
        return
      }

      const envelope = res.data as { data?: BuyerMatchV4Projection } | BuyerMatchV4Projection | undefined
      const payload =
        envelope && typeof envelope === 'object' && 'data' in envelope && envelope.data
          ? envelope.data
          : (envelope as BuyerMatchV4Projection | undefined)

      if (payload) {
        setProjection(payload)
        if (payload.market?.dataState === 'PARTIAL' && payload.meta?.cached) {
          window.setTimeout(() => {
            if (!controller.signal.aborted && subjectContextKey(subjectRef.current) === requestKey) {
              void run(subjectRef.current, true)
            }
          }, 1200)
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'projection_failed')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [paused, projection])

  useEffect(() => {
    setProjection(null)
    setError(null)
    void run(subject, false)
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, projectionCacheKey(subject)])

  const refresh = useCallback(() => {
    void run(subjectRef.current, true)
  }, [run])

  return { projection, loading, refreshing, error, refresh }
}