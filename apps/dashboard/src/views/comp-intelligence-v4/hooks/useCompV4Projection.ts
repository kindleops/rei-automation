/**
 * Comp Intelligence V4 — live canonical projection hook.
 *
 * - Reuses the existing domain API client (`fetchCompIntelligence`), which
 *   already attaches auth + base URL. No new engine, no new endpoint.
 * - Caches by property identity + search parameters.
 * - Stale-while-revalidate: cached model stays visible while a fresh request
 *   is in flight (status flips to `refreshing`, not `loading`).
 * - Cancels superseded requests via AbortController.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchCompIntelligence } from '../../../domain/comp-intelligence/comp-intelligence-api'
import { adaptProjection } from '../adapters/projectionAdapter'
import type { V4LoadState, V4Model } from '../state/types'

export interface CompV4Request {
  propertyId: string | null
  opportunityId?: string | null
  threadKey?: string | null
  masterOwnerId?: string | null
  radiusMiles: number
  monthsBack: number
  assetClass?: string | null
}

function cacheKey(req: CompV4Request): string {
  return [
    req.propertyId ?? 'none',
    req.radiusMiles,
    req.monthsBack,
    req.assetClass ?? 'any',
    req.opportunityId ?? '',
    req.threadKey ?? '',
  ].join('|')
}

// Module-level cache survives remounts within the session (Section 17).
const MODEL_CACHE = new Map<string, V4Model>()

export function useCompV4Projection(req: CompV4Request): V4LoadState & { reload: () => void } {
  const [state, setState] = useState<V4LoadState>({ status: 'idle', model: null, error: null })
  const abortRef = useRef<AbortController | null>(null)
  const reqRef = useRef(req)
  reqRef.current = req

  const run = useCallback(async (request: CompV4Request) => {
    if (!request.propertyId) {
      setState({ status: 'idle', model: null, error: null })
      return
    }
    const key = cacheKey(request)
    const cached = MODEL_CACHE.get(key) ?? null

    // Cancel any superseded request.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({
      status: cached ? 'refreshing' : 'loading',
      model: cached,
      error: null,
    })

    try {
      const payload = await fetchCompIntelligence(
        request.propertyId,
        {
          radius: request.radiusMiles,
          monthsBack: request.monthsBack,
          assetClass: request.assetClass ?? undefined,
          threadKey: request.threadKey ?? undefined,
          opportunityId: request.opportunityId ?? undefined,
          masterOwnerId: request.masterOwnerId ?? undefined,
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (!payload) {
        setState({
          status: 'error',
          model: cached,
          error: 'Comp intelligence is unavailable for this property.',
        })
        return
      }
      const model = adaptProjection(payload as unknown as Record<string, unknown>, {
        propertyId: request.propertyId,
        opportunityId: request.opportunityId,
        threadKey: request.threadKey,
        masterOwnerId: request.masterOwnerId,
        radiusMiles: request.radiusMiles,
        monthsBack: request.monthsBack,
      })
      MODEL_CACHE.set(key, model)
      if (controller.signal.aborted) return
      setState({ status: 'ready', model, error: null })
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') return
      setState({
        status: 'error',
        model: cached,
        error: err instanceof Error ? err.message : 'Failed to load comp intelligence.',
      })
    }
  }, [])

  useEffect(() => {
    void run(req)
    return () => abortRef.current?.abort()
    // Re-run when identity or search parameters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, cacheKey(req)])

  const reload = useCallback(() => {
    MODEL_CACHE.delete(cacheKey(reqRef.current))
    void run(reqRef.current)
  }, [run])

  return { ...state, reload }
}
