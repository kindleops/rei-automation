import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendBaseUrl, getBackendSecret } from '../../lib/api/backendClient'
import type { DealIntelligenceDossier, EngineProgressStage } from './deal-intelligence.types'
import { ENGINE_STAGE_LABELS } from './deal-intelligence.types'

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

export function useDealIntelligenceDossier(thread: ThreadIdentity | null | undefined) {
  const [dossier, setDossier] = useState<DealIntelligenceDossier | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [engineRunning, setEngineRunning] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [engineProgress, setEngineProgress] = useState<EngineProgress[]>([])
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!thread?.threadKey) {
      setDossier(null)
      return
    }

    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    const base = getBackendBaseUrl()
    const secret = getBackendSecret()
    const qs = new URLSearchParams()
    if (thread.propertyId) qs.set('property_id', thread.propertyId)
    if (thread.canonicalE164) qs.set('canonical_e164', thread.canonicalE164)
    if (thread.prospectId) qs.set('prospect_id', thread.prospectId)
    if (thread.masterOwnerId) qs.set('master_owner_id', thread.masterOwnerId)

    const path = `/api/cockpit/deal-intelligence/thread/${encodeURIComponent(thread.threadKey)}`
    const url = qs.toString() ? `${base}${path}?${qs.toString()}` : `${base}${path}`

    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-ops-dashboard-secret': secret,
        },
      })
      if (!res.ok) throw new Error(`dossier_http_${res.status}`)
      const payload = await res.json()
      if (requestId !== requestIdRef.current) return
      if (payload?.ok && payload?.data) {
        setDossier(payload.data as DealIntelligenceDossier)
      } else {
        throw new Error(payload?.error || 'dossier_failed')
      }
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : 'dossier_failed')
      setDossier(null)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [thread?.threadKey, thread?.propertyId, thread?.canonicalE164, thread?.prospectId, thread?.masterOwnerId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runDecisionEngine = useCallback(async () => {
    if (!thread?.threadKey || !thread?.propertyId) return
    setEngineRunning(true)
    setEngineError(null)
    setEngineProgress(
      (Object.keys(ENGINE_STAGE_LABELS) as EngineProgressStage[]).map((stage) => ({
        stage,
        status: 'running',
        label: ENGINE_STAGE_LABELS[stage],
      })),
    )

    const base = getBackendBaseUrl()
    const secret = getBackendSecret()
    const url = `${base}/api/cockpit/deal-intelligence/thread/${encodeURIComponent(thread.threadKey)}/run-engine?stream=true&property_id=${encodeURIComponent(thread.propertyId)}`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
          'x-ops-dashboard-secret': secret,
        },
        body: JSON.stringify({ property_id: thread.propertyId }),
      })
      if (!res.ok || !res.body) throw new Error(`run_engine_http_${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.stage) {
            const stageOrder = Object.keys(ENGINE_STAGE_LABELS)
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
            setDossier(event.dossier as DealIntelligenceDossier)
          }
        }
      }
      await refresh()
    } catch (err: unknown) {
      setEngineError(err instanceof Error ? err.message : 'run_engine_failed')
      setEngineProgress((prev) =>
        prev.map((item) => (item.status === 'running' ? { ...item, status: 'error' } : item)),
      )
    } finally {
      setEngineRunning(false)
    }
  }, [thread?.threadKey, thread?.propertyId, refresh])

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