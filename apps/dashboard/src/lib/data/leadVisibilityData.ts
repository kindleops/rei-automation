/**
 * LEAD VISIBILITY client — /api/cockpit/lead-visibility.
 *
 * The server answers `enabled` (flag lead_visibility_sync_enabled + its schema).
 * While it is off, every caller keeps today's archive path exactly; nothing in
 * the dashboard decides archive semantics.
 */
import { useEffect, useState } from 'react'
import { callBackend } from '../api/backendClient'

export interface VisibilityPending {
  thread_key: string
  action_id: string
  candidates: Array<{ opportunity_id: string; property_id: string | null; address: string | null; stage: string | null }>
  since: string | null
}

interface StatusBody { ok: boolean; enabled: boolean; reason?: string; pending?: VisibilityPending[] }

const STATUS_TTL_MS = 5 * 60_000
let status: { at: number; promise: Promise<boolean> } | null = null

/** Is the shared archive overlay live? Cached for 5 minutes; any failure → false (today's path). */
export function isLeadVisibilityEnabled(): Promise<boolean> {
  if (status && Date.now() - status.at < STATUS_TTL_MS) return status.promise
  const promise = callBackend<StatusBody>('/api/cockpit/lead-visibility', { timeoutMs: 8_000 })
    .then((res) => Boolean(res.ok && res.data?.ok && res.data.enabled))
    .catch(() => false)
  status = { at: Date.now(), promise }
  return promise
}

export function __resetLeadVisibilityStatus() { status = null }

export interface VisibilityItem { kind: 'thread' | 'opportunity'; id: string; ok: boolean; outcome: string; reason?: string; message?: string; note?: string }
export interface VisibilityResponse { ok: boolean; action_id?: string; status?: string; results?: VisibilityItem[]; needs_scope?: VisibilityItem[]; error?: string; message?: string; undo?: { undo_of: string } | null }

export async function applyLeadVisibility(body: {
  action?: 'archive' | 'unarchive'
  thread_keys?: string[]
  opportunity_ids?: string[]
  scope_choice?: 'conversation_only' | string[]
  undo_of?: string
  source?: 'inbox' | 'pipeline' | 'bulk'
  reason?: string
}): Promise<VisibilityResponse> {
  const res = await callBackend<VisibilityResponse>('/api/cockpit/lead-visibility', { method: 'POST', body: JSON.stringify(body), timeoutMs: 30_000 })
  if (!res.ok) return { ok: false, error: res.error || 'request_failed', message: res.message }
  return res.data ?? { ok: false, error: 'empty_response' }
}

/** "Reply on archived deals, property unclear" markers for one conversation (nothing while the overlay is off). */
export function useVisibilityPending(threadKey: string | null | undefined): VisibilityPending | null {
  const [state, setState] = useState<{ key: string | null; pending: VisibilityPending | null }>({ key: null, pending: null })
  const key = threadKey && /^\+1\d{10}$/.test(threadKey) ? threadKey : null
  useEffect(() => {
    if (!key) return
    let cancelled = false
    void isLeadVisibilityEnabled().then(async (enabled) => {
      if (!enabled || cancelled) return
      const res = await callBackend<StatusBody>(`/api/cockpit/lead-visibility?thread_keys=${encodeURIComponent(key)}`, { timeoutMs: 8_000 }).catch(() => null)
      if (cancelled) return
      const pending = res && res.ok ? (res.data?.pending ?? []).find((p) => p.thread_key === key) ?? null : null
      setState({ key, pending })
    })
    return () => { cancelled = true }
  }, [key])
  return state.key === key ? state.pending : null
}
