import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDealIntelligenceDossier, getBackendBaseUrl, getBackendSecret } from '../../lib/api/backendClient'
import type { DealIntelligenceDossier, EngineProgressStage } from './deal-intelligence.types'
import { ENGINE_STAGE_DISPLAY_ORDER, ENGINE_STAGE_LABELS } from './deal-intelligence.types'

interface ThreadIdentity {
  threadKey?: string
  propertyId?: string
  canonicalE164?: string
  prospectId?: string
  masterOwnerId?: string
}

interface EngineProgress {
  stage: EngineProgressStage
  status: 'running' | 'done' | 'error'
  label: string
}

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

function isFullDossier(value: DealIntelligenceDossier | null | undefined): boolean {
  if (!value || (value as { summary_only?: boolean }).summary_only) return false
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
  const [dossier, setDossier] = useState<DealIntelligenceDossier | null>(options.seedDossier ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [engineRunning, setEngineRunning] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [engineProgress, setEngineProgress] = useState<EngineProgress[]>([])
  const requestIdRef = useRef(0)
  const dossierRef = useRef<DealIntelligenceDossier | null>(options.seedDossier ?? null)
  const threadRef = useRef(thread)
  const hasFetchedOnceRef = useRef(false)
  threadRef.current = thread

  useEffect(() => {
    dossierRef.current = dossier
  }, [dossier])

  useEffect(() => {
    if (!options.seedDossier) return
    dossierRef.current = options.seedDossier
    setDossier(options.seedDossier)
  }, [options.seedDossier])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const currentThread = threadRef.current
    if (!currentThread?.threadKey) {
      setDossier(null)
      return
    }

    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    const qs = new URLSearchParams()
    const propertyId = resolvePropertyId(currentThread, null)
    if (propertyId) qs.set('property_id', propertyId)
    if (currentThread.canonicalE164) qs.set('canonical_e164', currentThread.canonicalE164)
    if (currentThread.prospectId) qs.set('prospect_id', currentThread.prospectId)
    if (currentThread.masterOwnerId) qs.set('master_owner_id', currentThread.masterOwnerId)

    try {
      const result = await fetchDealIntelligenceDossier(currentThread.threadKey, qs.toString(), signal)
      if (requestId !== requestIdRef.current) return
      if (!result.ok) throw new Error(`dossier_http_${result.status}`)
      const payload = result.data as { ok?: boolean; data?: DealIntelligenceDossier; error?: string }
      if (payload?.ok && payload?.data) {
        setDossier(payload.data)
      } else {
        throw new Error(payload?.error || 'dossier_failed')
      }
    } catch (err: unknown) {
      if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') return
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : 'dossier_failed')
      setDossier(null)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  const identityKey = buildThreadIdentityKey(thread)

  useEffect(() => {
    if (!enabled || !identityKey) {
      setDossier(null)
      setLoading(false)
      return
    }

    if (isFullDossier(options.seedDossier)) {
      return
    }

    dossierRef.current = null
    setDossier(null)
    setError(null)
    setLoading(true)

    const controller = new AbortController()
    hasFetchedOnceRef.current = true
    void refresh(controller.signal)

    return () => {
      controller.abort()
      requestIdRef.current += 1
    }
  }, [enabled, identityKey, refresh])

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
    setEngineError(null)
    setEngineProgress(
      ENGINE_STAGE_DISPLAY_ORDER.map((stage) => ({
        stage,
        status: 'running',
        label: ENGINE_STAGE_LABELS[stage],
      })),
    )

    const base = getBackendBaseUrl()
    const secret = getBackendSecret()
    const url = `${base}/api/cockpit/deal-intelligence/thread/${encodeURIComponent(currentThread.threadKey)}/run-engine?stream=true&property_id=${encodeURIComponent(propertyId)}`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
          'x-ops-dashboard-secret': secret,
        },
        body: JSON.stringify({ property_id: propertyId }),
      })
      if (!res.ok || !res.body) throw new Error(`run_engine_http_${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamFailed: string | null = null

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
                  return { ...item, status: event.status === 'done' ? 'done' : 'running' }
                }
                if (itemIndex >= 0 && eventIndex >= 0 && itemIndex < eventIndex) {
                  return { ...item, status: 'done' }
                }
                return item
              }),
            )
          }
          if (event.dossier) {
            setDossier(event.dossier)
          }
        }
      }

      if (streamFailed) throw new Error(streamFailed)
      await refresh()
    } catch (err: unknown) {
      setEngineError(err instanceof Error ? err.message : 'run_engine_failed')
      setEngineProgress((prev) =>
        prev.map((item) => (item.status === 'running' ? { ...item, status: 'error' } : item)),
      )
    } finally {
      setEngineRunning(false)
    }
  }, [refresh])

  return {
    dossier,
    loading,
    error,
    refresh,
    runDecisionEngine,
    engineRunning,
    engineError,
    engineProgress,
  }
}