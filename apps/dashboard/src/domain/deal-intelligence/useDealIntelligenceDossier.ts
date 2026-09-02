import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDealIntelligenceDossier, getBackendBaseUrl, getBackendSecret } from '../../lib/api/backendClient'
import { resolveThreadRouteKey } from '../inbox/canonical-thread-reference'
import { resolveDealDeskThreadReference } from '../inbox/deal-desk-thread-reference'
import type { DealIntelligenceDossier, EngineProgressStage } from './deal-intelligence.types'
import { ENGINE_STAGE_DISPLAY_ORDER, ENGINE_STAGE_LABELS } from './deal-intelligence.types'

interface ThreadIdentity {
  threadKey?: string
  propertyId?: string
  canonicalE164?: string
  prospectId?: string
  masterOwnerId?: string
}

export type EngineRunPhase = 'running' | 'success' | 'error'

export type EngineProgressStatus = 'pending' | 'running' | 'done' | 'error'

/**
 * How complete the dossier currently on screen is.
 *
 * `seed`    — identity handed over by the surface we navigated from; no network yet.
 * `summary` — shell payload: identity, location, property basics, workflow state.
 * `full`    — everything, including comps / buyers / activity / enrichment.
 */
export type DossierPhase = 'empty' | 'seed' | 'summary' | 'full'

export interface EngineProgress {
  stage: EngineProgressStage
  status: EngineProgressStatus
  label: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

const buildInitialEngineProgress = (): EngineProgress[] =>
  ENGINE_STAGE_DISPLAY_ORDER.map((stage, index) => ({
    stage,
    status: index === 0 ? 'running' : 'pending',
    label: ENGINE_STAGE_LABELS[stage],
  }))

function resolvePropertyId(thread: ThreadIdentity | null | undefined, dossier: DealIntelligenceDossier | null) {
  return (
    thread?.propertyId
    || (dossier?.identity?.property_id as string | undefined)
    || dossier?.property?.property_id
    || null
  )
}

function buildThreadIdentityKey(thread: ThreadIdentity | null | undefined): string {
  if (!thread?.threadKey) return ''
  return [
    thread.threadKey,
    thread.propertyId || '',
    thread.prospectId || '',
    thread.masterOwnerId || '',
    thread.canonicalE164 || '',
  ].join('|')
}

function isSummaryPayload(value: DealIntelligenceDossier | null | undefined): boolean {
  return Boolean(value && (value as { summary_only?: boolean }).summary_only)
}

function isFullDossier(value: DealIntelligenceDossier | null | undefined): boolean {
  if (!value || isSummaryPayload(value)) return false
  return Boolean(
    value.master_owner?.full_name
    || value.prospect?.full_name
    || (Array.isArray(value.comps?.records) && value.comps.records.length > 0),
  )
}

export function useDealIntelligenceDossier(
  thread: ThreadIdentity | null | undefined,
  options: { seedDossier?: DealIntelligenceDossier | null; enabled?: boolean } = {},
) {
  const enabled = options.enabled !== false
  const seed = options.seedDossier ?? null

  // Kept apart rather than merged so a late summary response can never downgrade
  // an already-loaded section back to its `lazy` placeholder. What renders is
  // simply the most complete payload we hold.
  const [summaryDossier, setSummaryDossier] = useState<DealIntelligenceDossier | null>(null)
  const [fullDossier, setFullDossier] = useState<DealIntelligenceDossier | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [engineRunning, setEngineRunning] = useState(false)
  const [engineRunPhase, setEngineRunPhase] = useState<EngineRunPhase | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [engineProgress, setEngineProgress] = useState<EngineProgress[]>([])
  const requestIdRef = useRef(0)
  const dossierRef = useRef<DealIntelligenceDossier | null>(seed ?? null)
  const seedRef = useRef(seed)
  seedRef.current = seed
  const threadRef = useRef(thread)
  threadRef.current = thread

  const dossier = fullDossier ?? summaryDossier ?? seed ?? null

  const phase: DossierPhase = fullDossier
    ? 'full'
    : summaryDossier
      ? 'summary'
      : seed
        ? 'seed'
        : 'empty'

  useEffect(() => {
    dossierRef.current = dossier
  }, [dossier])

  const buildQuery = useCallback((currentThread: ThreadIdentity) => {
    const qs = new URLSearchParams()
    const propertyId = resolvePropertyId(currentThread, null)
    if (propertyId) qs.set('property_id', propertyId)
    if (currentThread.canonicalE164) qs.set('canonical_e164', currentThread.canonicalE164)
    if (currentThread.prospectId) qs.set('prospect_id', currentThread.prospectId)
    if (currentThread.masterOwnerId) qs.set('master_owner_id', currentThread.masterOwnerId)
    return qs
  }, [])

  const fetchPhase = useCallback(async (
    currentThread: ThreadIdentity,
    summaryOnly: boolean,
    signal?: AbortSignal,
  ): Promise<DealIntelligenceDossier> => {
    const qs = buildQuery(currentThread)
    if (summaryOnly) qs.set('summary', '1')

    // Same route key as the thread-select orchestrator, so one conversation is never
    // fetched twice under two different key shapes (N.1 runtime verification).
    //
    // Must go through the Deal Desk *binding*, not the pure resolver: the pure resolver
    // receives no composite conversation id, so a thread with a composite identity and
    // no dialable phone would fall back to a different selection key here than on the
    // selection path — reintroducing the duplicate fetch this line exists to prevent.
    const routeKey =
      resolveThreadRouteKey(resolveDealDeskThreadReference(currentThread)) ??
      currentThread.threadKey!
    const result = await fetchDealIntelligenceDossier(routeKey, qs.toString(), signal)
    if (!result.ok) throw new Error(`dossier_http_${result.status}`)
    const payload = result.data as { ok?: boolean; data?: DealIntelligenceDossier; error?: string }
    if (!payload?.ok || !payload?.data) throw new Error(payload?.error || 'dossier_failed')
    return payload.data
  }, [buildQuery])

  /**
   * Re-fetch the full dossier. `background` keeps whatever is already on screen
   * mounted while the request is in flight — the profile must not blank out just
   * because a section is being refreshed.
   */
  const refresh = useCallback(async (signal?: AbortSignal, opts: { background?: boolean } = {}) => {
    const currentThread = threadRef.current
    if (!currentThread?.threadKey) {
      setSummaryDossier(null)
      setFullDossier(null)
      return
    }

    const requestId = ++requestIdRef.current
    if (!opts.background) setDetailLoading(true)
    setError(null)

    try {
      const data = await fetchPhase(currentThread, false, signal)
      if (requestId !== requestIdRef.current) return
      setFullDossier(data)
    } catch (err: unknown) {
      if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') return
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : 'dossier_failed')
      // Keep whatever we already have. Dropping it turns a failed *refresh* into
      // a blank profile, which is strictly worse than slightly stale data.
    } finally {
      if (requestId === requestIdRef.current) setDetailLoading(false)
    }
  }, [fetchPhase])

  const identityKey = buildThreadIdentityKey(thread)

  useEffect(() => {
    if (!enabled || !identityKey) {
      setSummaryDossier(null)
      setFullDossier(null)
      setDetailLoading(false)
      return
    }

    if (isFullDossier(seedRef.current)) return

    const currentThread = threadRef.current
    if (!currentThread?.threadKey) return

    setSummaryDossier(null)
    setFullDossier(null)
    setError(null)
    setDetailLoading(true)

    const controller = new AbortController()
    const requestId = ++requestIdRef.current

    // Two-phase open, fired CONCURRENTLY. The two requests are independent — the
    // summary skips comps, buyer market, activity and enrichment — so awaiting the
    // summary before starting the full build just added its latency to the total.
    // Server-side the pair also shares one `inbox_threads_hydrated` materialization
    // via the in-flight cache, so racing them costs no extra database work.
    const summaryPromise = fetchPhase(currentThread, true, controller.signal)
    const fullPromise = fetchPhase(currentThread, false, controller.signal)

    void summaryPromise
      .then((summary) => {
        if (requestId !== requestIdRef.current) return
        setSummaryDossier(summary)
      })
      .catch(() => {
        // Non-fatal: the full request is the real load.
      })

    void fullPromise
      .then((full) => {
        if (requestId !== requestIdRef.current) return
        setFullDossier(full)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') return
        if (requestId !== requestIdRef.current) return
        setError(err instanceof Error ? err.message : 'dossier_failed')
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setDetailLoading(false)
      })

    return () => {
      controller.abort()
      requestIdRef.current += 1
    }
  }, [enabled, identityKey, fetchPhase])

  const runDecisionEngine = useCallback(async () => {
    const currentThread = threadRef.current
    if (!currentThread?.threadKey) {
      setEngineError('thread_key_required')
      return
    }

    const propertyId = resolvePropertyId(currentThread, dossierRef.current)
    if (!propertyId) {
      setEngineError('property_id_required')
      return
    }

    setEngineRunning(true)
    setEngineRunPhase('running')
    setEngineError(null)
    setEngineProgress(buildInitialEngineProgress())

    const base = getBackendBaseUrl()
    const secret = getBackendSecret()
    // Carry the full identity, not just the property: the route rebuilds the
    // dossier afterwards, and rebuilding from thread_key + property_id alone
    // resolves a different linked prospect and swaps the displayed seller.
    const runQs = buildQuery(currentThread)
    runQs.set('stream', 'true')
    runQs.set('property_id', propertyId)
    const url = `${base}/api/cockpit/deal-intelligence/thread/${encodeURIComponent(currentThread.threadKey)}/run-engine?${runQs.toString()}`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
          'x-ops-dashboard-secret': secret,
        },
        body: JSON.stringify({
          property_id: propertyId,
          canonical_e164: currentThread.canonicalE164,
          prospect_id: currentThread.prospectId,
          master_owner_id: currentThread.masterOwnerId,
        }),
      })
      if (!res.ok || !res.body) throw new Error(`run_engine_http_${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamFailed: string | null = null
      let receivedDossier = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as {
            ok?: boolean
            error?: string
            stage?: EngineProgressStage
            status?: string
            dossier?: DealIntelligenceDossier
          }

          if (event.ok === false && event.error) {
            streamFailed = event.error
            continue
          }

          if (event.stage) {
            const stageOrder = [...ENGINE_STAGE_DISPLAY_ORDER, 'calculating_confidence' as EngineProgressStage]
            const eventIndex = stageOrder.indexOf(event.stage)
            setEngineProgress((prev) =>
              prev.map((item) => {
                const itemIndex = stageOrder.indexOf(item.stage)
                if (item.stage === event.stage) {
                  if (event.status === 'done') return { ...item, status: 'done' }
                  return { ...item, status: 'running' }
                }
                if (itemIndex >= 0 && eventIndex >= 0) {
                  if (itemIndex < eventIndex) return { ...item, status: 'done' }
                  if (itemIndex > eventIndex) return { ...item, status: 'pending' }
                }
                return item
              }),
            )
          }
          if (event.dossier) {
            // The run-engine stream closes with a freshly built dossier, so this
            // IS the post-run state. Adopting it directly is what keeps the rest
            // of the profile mounted: no refetch, no loading gate, no remount.
            receivedDossier = true
            // Bump the request id so an in-flight open cannot land afterwards and
            // overwrite the engine result with a pre-run dossier.
            requestIdRef.current += 1
            setFullDossier(event.dossier)
          }
        }
      }

      if (streamFailed) throw new Error(streamFailed)
      setEngineProgress((prev) => prev.map((item) => ({ ...item, status: 'done' })))
      // Only reach for the network if the stream never handed us a result.
      if (!receivedDossier) await refresh(undefined, { background: true })
      setEngineRunPhase('success')
      await sleep(900)
    } catch (err: unknown) {
      setEngineError(err instanceof Error ? err.message : 'run_engine_failed')
      setEngineProgress((prev) =>
        prev.map((item) => {
          if (item.status === 'running') return { ...item, status: 'error' }
          if (item.status === 'pending') return item
          return item
        }),
      )
      setEngineRunPhase('error')
      await sleep(1400)
    } finally {
      setEngineRunning(false)
      setEngineRunPhase(null)
    }
  }, [refresh, buildQuery])

  // `loading` now means "nothing to show yet" rather than "a request is open".
  // Surfaces that used it as a full-screen gate therefore stop blanking as soon
  // as the summary lands.
  const loading = !dossier && detailLoading

  return useMemo(() => ({
    dossier,
    phase,
    loading,
    /** A request is in flight; sections absent from the summary should skeleton. */
    detailLoading,
    /** True once the heavy sections (comps, buyers, activity, enrichment) are present. */
    detailReady: phase === 'full',
    error,
    refresh,
    runDecisionEngine,
    engineRunning,
    engineRunPhase,
    engineError,
    engineProgress,
  }), [
    dossier, phase, loading, detailLoading, error, refresh, runDecisionEngine,
    engineRunning, engineRunPhase, engineError, engineProgress,
  ])
}
