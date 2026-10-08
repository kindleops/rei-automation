/**
 * ENTITY GRAPH DESK · OUTREACH STATE (client) — last contact, stage, status,
 * SMS eligibility (+ the blocking reason) per property, from
 * GET /api/cockpit/entity-graph/outreach-state. The server answers with the
 * campaign target builder's own readiness rule; this file only fetches,
 * caches and words it.
 *
 * Same load contract as the column enrichment: only the rows on screen, at
 * most BATCH ids per request, cached TTL_MS, a failure leaves cells "—".
 */
import { useEffect, useMemo, useState } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import type { EntityOutreachState, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'

export type OutreachState = EntityOutreachState

const BATCH = 300
const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; state: OutreachState | null }>()

/** Plain words for a readiness / graph block reason. Unknown codes are humanised, never hidden. */
export const SMS_REASON_LABEL: Record<string, string> = {
  not_in_campaign_audience: 'Not in the campaign audience',
  missing_phone: 'No phone on file',
  NO_PHONE: 'No phone on file',
  non_sms_capable: 'No SMS-capable line',
  SMS_INELIGIBLE: 'No SMS-capable line',
  pending_prior_touch: 'Recently contacted — waiting',
  PENDING_PRIOR_TOUCH: 'Recently contacted — waiting',
  suppressed: 'Suppressed (opted out)',
  suppression_blocked: 'Suppressed (opted out)',
  wrong_number: 'Wrong number',
  active_queue_item: 'Already queued',
  ACTIVE_QUEUE_ITEM: 'Already queued',
  routing_blocked: 'No sender coverage',
  no_sender_coverage: 'No sender coverage',
  graph_not_queue_eligible: 'Not queue-eligible',
  missing_identity_linkage: 'No resolved person + phone',
  entity_contact_requires_review: 'Entity contact needs review',
  identity_not_verified: 'Owner identity not verified',
  missing_timezone: 'No time zone',
  ambiguous_phone_ownership: 'Phone shared by several owners',
}

export const smsReasonLabel = (code: string | null | undefined): string => {
  if (!code) return ''
  return SMS_REASON_LABEL[code] ?? code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export const humanize = (s: string | null | undefined): string => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '')

export function relativeDay(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const days = Math.floor((now - t) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
}

export function lastContactLabel(c: OutreachState['lastContact'], now = Date.now()): string | null {
  if (!c) return null
  return `${relativeDay(c.at, now)} · ${c.direction === 'inbound' ? 'In' : 'Out'} · ${c.channel.toUpperCase()}`
}

export function smsLabel(s: OutreachState['sms']): string | null {
  if (!s) return null
  return s.eligible ? 'Yes' : `No · ${smsReasonLabel(s.reason)}`
}

export function readOutreach(propertyId: string, now = Date.now()): OutreachState | null | undefined {
  const hit = cache.get(propertyId)
  return hit && now - hit.at < TTL_MS ? hit.state : undefined
}

export function storeOutreach(ids: readonly string[], states: Record<string, OutreachState>, now = Date.now()) {
  for (const id of ids) cache.set(id, { at: now, state: states[id] ?? null })
}

export const __outreachCacheTest = { reset: () => cache.clear() }

export async function fetchOutreachStates(ids: string[], signal?: AbortSignal): Promise<Record<string, OutreachState>> {
  const out: Record<string, OutreachState> = {}
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH)
    const res = await callBackend<{ ok: boolean; states?: Record<string, OutreachState> }>(`/api/cockpit/entity-graph/outreach-state?property_ids=${encodeURIComponent(part.join(','))}`, { signal })
    if (!res.ok) throw new Error(res.message || res.error || 'outreach_state_failed')
    Object.assign(out, res.data?.states ?? {})
    storeOutreach(part, res.data?.states ?? {})
  }
  return out
}

const propertyIdOf = (r: EntitySearchResult): string | null => (r.entityType === 'property' ? r.entityId || r.contextIds?.propertyId || null : null)

/** Merge cached outreach state onto `details.outreach` for the rows on screen (property rows). */
export function useOutreachStates(rows: readonly EntitySearchResult[], enabled: boolean) {
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled || !rows.length) return
    const ids = [...new Set(rows.map(propertyIdOf).filter((id): id is string => Boolean(id)))].filter((id) => readOutreach(id) === undefined)
    if (!ids.length) return
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      fetchOutreachStates(ids, ctl.signal)
        .then(() => { if (!ctl.signal.aborted) { setError(null); setVersion((v) => v + 1) } })
        .catch((e: unknown) => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'outreach_state_failed') })
    }, 180)
    return () => { window.clearTimeout(timer); ctl.abort() }
  }, [rows, enabled])
  const merged = useMemo(() => {
    void version
    if (!enabled) return rows as EntitySearchResult[]
    return rows.map((r) => {
      const id = propertyIdOf(r)
      const state = id ? readOutreach(id) : undefined
      return state === undefined ? r : { ...r, details: { ...(r.details ?? {}), outreach: state } }
    })
  }, [rows, version, enabled])
  return { rows: merged, error }
}

/** One network's properties (the inspector + the graph hover card). */
export function useNetworkOutreach(propertyIds: readonly string[]) {
  const key = propertyIds.join(',')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const ids = propertyIds.filter((id) => readOutreach(id) === undefined).slice(0, BATCH)
    if (!ids.length) return
    const ctl = new AbortController()
    fetchOutreachStates(ids, ctl.signal).then(() => { if (!ctl.signal.aborted) setVersion((v) => v + 1) }).catch(() => {})
    return () => ctl.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- key encodes the ids
  return useMemo(() => {
    void version
    const map = new Map<string, OutreachState | null>()
    for (const id of propertyIds) {
      const s = readOutreach(id)
      if (s !== undefined) map.set(id, s)
    }
    return map
  }, [key, version]) // eslint-disable-line react-hooks/exhaustive-deps
}
