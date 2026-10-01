import { useCallback, useEffect, useRef, useState } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import { fetchDealDecision } from '../../../domain/deal-intelligence/deal-decision-api'
import { fetchKey, rememberRecent, type DiSubject } from './di-subject'
import type { DiDecision, DiStory } from './di-types'

const STALE_AFTER_MS = 2 * 60_000

interface Loaded { key: string; data: DiDecision; at: number }
interface Failed { key: string; message: string; at: number }

/**
 * The canonical decision for a subject.
 *
 *   · One read (GET /api/cockpit/deal-intelligence/decision) per subject.
 *   · Changing subject keeps the previous decision on screen — dimmed by the
 *     caller via `pending` — until the new one lands. No blank, no remount.
 *   · A failed refresh keeps what was loaded and says when it was loaded.
 *   · Revalidates when the operator comes back to the tab / pane after two
 *     minutes. Nothing polls; nothing here writes.
 */
export function useDecisionRoom(subject: DiSubject, opts: { visible: boolean }) {
  const key = fetchKey(subject)
  const { propertyId, threadKey, opportunityId } = subject
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState<Failed | null>(null)
  const [nonce, setNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const loadedRef = useRef<Loaded | null>(null)
  useEffect(() => { loadedRef.current = loaded }, [loaded])

  useEffect(() => {
    if (!key) return
    const ctrl = new AbortController()
    fetchDealDecision({ propertyId, threadKey, opportunityId: propertyId || threadKey ? null : opportunityId }, ctrl.signal)
      .then((raw) => {
        if (ctrl.signal.aborted) return
        const data = raw as unknown as DiDecision
        setLoaded({ key, data, at: Date.now() })
        setFailed(null)
        setRefreshing(false)
        if (data.subject?.propertyId) {
          rememberRecent({
            propertyId: data.subject.propertyId,
            threadKey: data.contact?.threadKey ?? data.pipeline?.threadKey ?? threadKey ?? null,
            address: data.subject.address,
            seller: data.contact?.sellerName ?? null,
            tier: data.decision.status === 'available' ? data.decision.tierLabel : null,
            at: Date.now(),
          })
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setFailed({ key, message: e instanceof Error ? e.message : 'deal_decision_failed', at: Date.now() })
        setRefreshing(false)
      })
    return () => ctrl.abort()
  }, [key, propertyId, threadKey, opportunityId, nonce])

  const refresh = useCallback(() => {
    setRefreshing(true)
    setNonce((n) => n + 1)
  }, [])

  // Back to the tab or the pane after a while: re-read once.
  const { visible } = opts
  useEffect(() => {
    const maybe = () => {
      const l = loadedRef.current
      if (document.visibilityState !== 'visible' || !l) return
      if (Date.now() - l.at > STALE_AFTER_MS) refresh()
    }
    document.addEventListener('visibilitychange', maybe)
    const t = visible ? window.setTimeout(maybe, 0) : null
    return () => {
      document.removeEventListener('visibilitychange', maybe)
      if (t !== null) window.clearTimeout(t)
    }
  }, [visible, refresh])

  const current = loaded?.key === key ? loaded : null
  return {
    /** what is on screen: the current subject's decision, or the previous one while the next loads */
    data: loaded?.data ?? null,
    /** the decision belongs to the requested subject */
    current: Boolean(current),
    /** a different subject's decision is still on screen */
    pending: Boolean(key) && !current && failed?.key !== key,
    refreshing,
    error: failed?.key === key ? failed.message : null,
    loadedAt: current?.at ?? null,
    refresh,
  }
}

/**
 * The deal's own story — beats from the Pipeline read model
 * (GET /api/cockpit/pipeline/command/story/:id): first contact, replies with
 * their classified intent, stage moves, offers, closing events, and the
 * current lane. Loaded after the decision, only when there is a deal.
 */
export function useDealStory(opportunityId: string | null | undefined) {
  const [state, setState] = useState<{ id: string; story: DiStory | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!opportunityId) return
    const ctrl = new AbortController()
    callBackend<{ ok: boolean; data: DiStory }>(`/api/cockpit/pipeline/command/story/${encodeURIComponent(opportunityId)}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        const body = res.ok ? (res.data as unknown as { data?: DiStory } | null) : null
        setState({ id: opportunityId, story: body?.data ?? null, error: res.ok ? null : res.error || 'story_unavailable' })
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ id: opportunityId, story: null, error: e instanceof Error ? e.message : 'story_unavailable' })
      })
    return () => ctrl.abort()
  }, [opportunityId])
  const mine = state && state.id === opportunityId ? state : null
  return { story: mine?.story ?? null, loading: Boolean(opportunityId) && !mine, error: mine?.error ?? null }
}
