/**
 * Recent thread messages for the Lead Command Sheet.
 *
 * Deliberately module-local and non-blocking: the sheet already paints identity,
 * workflow and deal from the row seed + dossier summary, and messages are the
 * slowest leg. They load on their own and slot in — they never gate the sheet.
 *
 * Reads the same `/api/cockpit/inbox/thread-messages` route the Inbox uses, so
 * there is no second notion of what a message is.
 */
import { useEffect, useState } from 'react'
import * as backendClient from '../../../lib/api/backendClient'

export type LeadMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  at: string
}

export type LeadThreadMessages = {
  /** Chronological, oldest first, capped by the caller. */
  messages: LeadMessage[]
  /** Median seller reply time in ms, or null when there isn't enough signal. */
  medianReplyMs: number | null
  replyPairs: number
  loading: boolean
  error: boolean
}

const EMPTY: LeadThreadMessages = {
  messages: [], medianReplyMs: null, replyPairs: 0, loading: false, error: false,
}

const str = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = String(v).trim()
  return s === 'null' || s === 'undefined' ? '' : s
}

const ts = (v: unknown): number => {
  const t = new Date(str(v)).getTime()
  return Number.isFinite(t) ? t : NaN
}

/**
 * A message the operator would recognise as part of the conversation.
 *
 * Drops empty bodies, unsent drafts, delivery receipts and system rows. Failed
 * outbound is excluded too — it never reached the seller, so counting it would
 * both misreport the exchange and corrupt reply timing (the clock would start
 * from a send that never landed).
 */
export function isMeaningful(raw: Record<string, unknown>): boolean {
  if (!str(raw.message_body)) return false

  const dir = str(raw.direction).toLowerCase()
  if (dir !== 'inbound' && dir !== 'outbound') return false

  const kind = `${str(raw.message_type)} ${str(raw.event_type)} ${str(raw.kind)}`.toLowerCase()
  if (/draft|receipt|system|status|note|internal/.test(kind)) return false

  if (dir === 'outbound') {
    const status = str(raw.delivery_status).toLowerCase()
    if (status === 'failed' || status === 'undelivered' || status === 'draft') return false
  }
  return true
}

/**
 * Rejoin split sends.
 *
 * Real threads contain sentence fragments sent seconds apart ("I am" /
 * "referring to 3242 N Colorado Ave."). Listed separately they read as two
 * messages and make the exchange look incoherent. Merging keeps the LAST
 * timestamp, which is also the correct clock start for reply timing — the
 * seller could only respond once the final fragment landed.
 */
const FRAGMENT_WINDOW_MS = 3 * 60_000

export function mergeFragments(messages: LeadMessage[]): LeadMessage[] {
  const out: LeadMessage[] = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    const gap = prev ? ts(m.at) - ts(prev.at) : Infinity
    if (prev && prev.direction === m.direction && Number.isFinite(gap) && gap <= FRAGMENT_WINDOW_MS) {
      out[out.length - 1] = {
        ...prev,
        body: `${prev.body.replace(/\s+$/, '')} ${m.body}`.trim(),
        at: m.at,
      }
    } else {
      out.push(m)
    }
  }
  return out
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Median time between an outbound landing and the seller's next inbound.
 *
 * Each inbound is paired with the nearest preceding outbound, so a burst of
 * consecutive seller messages contributes one measurement rather than inflating
 * the sample with near-zero gaps. Fewer than two pairs is not a cadence — the
 * caller omits the readout entirely rather than presenting one point as a rate.
 */
export function replyDeltas(messages: LeadMessage[]): number[] {
  const out: number[] = []
  let lastOutboundAt: number | null = null
  let awaitingReply = false

  for (const m of messages) {
    const at = ts(m.at)
    if (!Number.isFinite(at)) continue
    if (m.direction === 'outbound') {
      lastOutboundAt = at
      awaitingReply = true
    } else if (awaitingReply && lastOutboundAt !== null && at > lastOutboundAt) {
      out.push(at - lastOutboundAt)
      awaitingReply = false
    }
  }
  return out
}

export function useLeadThreadMessages(
  threadKey: string | null | undefined,
  { enabled = true, limit = 50 }: { enabled?: boolean; limit?: number } = {},
): LeadThreadMessages {
  const [state, setState] = useState<LeadThreadMessages>(EMPTY)

  useEffect(() => {
    if (!enabled || !threadKey) {
      setState(EMPTY)
      return
    }

    const controller = new AbortController()
    let live = true
    setState({ ...EMPTY, loading: true })

    ;(async () => {
      try {
        const result = await backendClient.fetchInboxThreadMessages(
          threadKey,
          `limit=${limit}`,
          controller.signal,
        )
        if (!live || controller.signal.aborted) return

        const payload = (result.ok ? result.data ?? {} : {}) as Record<string, unknown>
        const inner = (payload.data ?? null) as Record<string, unknown> | null
        const raw = (payload.messages ?? inner?.messages ?? []) as unknown

        if (!Array.isArray(raw)) {
          setState({ ...EMPTY, error: true })
          return
        }

        const messages = raw
          .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
          .filter(isMeaningful)
          .map((m, i) => ({
            id: str(m.id) || str(m.message_event_key) || `msg-${i}`,
            direction: str(m.direction).toLowerCase() as 'inbound' | 'outbound',
            body: str(m.message_body),
            at: str(m.created_at) || str(m.received_at) || str(m.sent_at) || str(m.event_timestamp),
          }))
          .filter((m) => Number.isFinite(ts(m.at)))
          .sort((a, b) => ts(a.at) - ts(b.at))
        const merged = mergeFragments(messages)

        const deltas = replyDeltas(merged)
        setState({
          messages: merged,
          medianReplyMs: deltas.length >= 2 ? median(deltas) : null,
          replyPairs: deltas.length,
          loading: false,
          error: false,
        })
      } catch (err) {
        if (!live || controller.signal.aborted) return
        if ((err as { name?: string })?.name === 'AbortError') return
        setState({ ...EMPTY, error: true })
      }
    })()

    return () => {
      live = false
      controller.abort()
    }
  }, [threadKey, enabled, limit])

  return state
}
