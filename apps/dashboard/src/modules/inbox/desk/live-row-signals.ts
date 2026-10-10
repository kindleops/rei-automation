import { useSyncExternalStore } from 'react'
import { resolveInboxStageBadge } from '../inbox-card-signals'
import { AUTOMATION_QUEUE_SOURCES } from './composer-phase'

/**
 * INBOX DESKTOP 4.0 — live rows, from events that already arrive.
 *
 * The Inbox list channel (inbox.adapter.ts) receives message_events,
 * send_queue and inbox_thread_state changes. This store reads the SAME events
 * — no extra subscription, no per-row polling — and keeps, per thread, the
 * one transient worth showing on its ledger row:
 *
 *   arrival   a seller message landed            (one restrained trace)
 *   queued    LeadCommand queued its reply       ✓ Reply queued   (send_queue INSERT, automation source)
 *   replying  LeadCommand's reply is going out   ••• replying     (send_queue → processing/sending)
 *   held      the automation held it for review  Needs you        (inbound marked human_review_required)
 *   failed    the reply did not send             Send failed      (send_queue failed / blocked)
 *   stage     the seller stage moved             S2 → S3          (inbox_thread_state, diffed against the row)
 *
 * Each transient expires on its own and the row settles to its canonical
 * state. Bursts are coalesced: past the first few arrivals in a burst, rows
 * are marked without the trace, so ten replies never pulse ten rows.
 */

export type RowSignalKind = 'arrival' | 'queued' | 'replying' | 'held' | 'failed' | 'stage'

export interface RowSignal {
  kind: RowSignalKind
  at: number
  until: number
  /** arrival inside a burst: marked, but no trace */
  quiet?: boolean
  from?: string
  to?: string
  /** true when the queued/replying row is the automation (not the operator) */
  automation?: boolean
}

const DURATION: Record<RowSignalKind, number> = {
  arrival: 1_400,
  queued: 3_200,
  replying: 20_000,
  held: 8_000,
  failed: 15_000,
  stage: 4_000,
}
const RANK: Record<RowSignalKind, number> = { failed: 0, held: 1, replying: 2, queued: 3, stage: 4, arrival: 5 }
const BURST_WINDOW_MS = 2_500
const BURST_TRACES = 3

const OPERATOR_QUEUE_SOURCES = new Set(['inbox', 'manual_inbox', 'inbox_bulk_follow_up'])

const signals = new Map<string, RowSignal>()
/** when a seller message last arrived live, per thread — read for "unread" until opened */
const arrivals = new Map<string, number>()
/** the last inbox_thread_state.seller_stage seen per thread (from facts or realtime) */
const knownStages = new Map<string, string>()
const timers = new Map<string, number>()
const listeners = new Set<() => void>()
const touchedListeners = new Set<(keys: string[]) => void>()
let burst: { start: number; count: number } = { start: 0, count: 0 }
/** how many desk ledgers are mounted — the store is inert (mobile, other hosts) at 0 */
let enabledCount = 0

/** The desk ledger switches the store on while it is mounted. */
export function enableRowSignals(): () => void {
  enabledCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    enabledCount = Math.max(0, enabledCount - 1)
  }
}

const emit = () => listeners.forEach((listener) => listener())

/** One key per conversation: the seller's 10-digit number when there is one. */
export function normalizeSignalKey(value: unknown): string {
  let text = String(value ?? '').trim()
  if (!text) return ''
  const phoneAt = text.toLowerCase().lastIndexOf('phone:')
  if (phoneAt >= 0) text = text.slice(phoneAt + 6)
  const digits = text.replace(/\D/g, '')
  if (digits.length >= 10 && digits.length <= 11 && /^[+\d\s().-]+$/.test(text.split('|')[0])) return digits.slice(-10)
  return text.toLowerCase()
}

function schedule(key: string, at: number) {
  if (typeof window === 'undefined') return
  const existing = timers.get(key)
  if (existing) window.clearTimeout(existing)
  const timer = window.setTimeout(() => {
    timers.delete(key)
    const current = signals.get(key)
    if (current && current.until <= Date.now() + 5) {
      signals.delete(key)
      emit()
    }
  }, Math.max(0, at - Date.now()) + 10)
  timers.set(key, timer)
}

function put(key: string, next: RowSignal) {
  const current = signals.get(key)
  // A stronger state is not replaced by a weaker one until it expires.
  if (current && current.until > next.at && RANK[current.kind] < RANK[next.kind]) return
  signals.set(key, next)
  schedule(key, next.until)
  emit()
}

export interface InboxRealtimeSignalInput {
  table: string
  eventType?: string | null
  row: Record<string, unknown> | null | undefined
  threadKey: string
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const lower = (value: unknown): string => str(value).toLowerCase()
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Feed one realtime change. Unknown tables and irrelevant rows are ignored. */
export function ingestInboxRealtimeSignal(input: InboxRealtimeSignalInput, now = Date.now()): void {
  if (enabledCount === 0) return
  const key = normalizeSignalKey(input.threadKey)
  const row = input.row ?? {}
  if (!key) return
  // Facts are keyed by inbox_thread_state.thread_key; prefer the row's own key
  // over the resolved conversation id so the right facts are re-read.
  const factsKey = str(row.thread_key) || input.threadKey
  const touched = () => touchedListeners.forEach((listener) => listener([factsKey]))

  if (input.table === 'message_events') {
    const direction = lower(row.direction)
    if (!direction.startsWith('in')) return
    const meta = asRecord(row.metadata)
    const held = meta.human_review_required === true || meta.needs_human_review === true
      || lower(meta.human_review_required) === 'true'
    const queued = Boolean(str(row.auto_reply_queue_id) || str(meta.auto_reply_queue_id))
    if (lower(input.eventType) === 'insert') {
      if (now - burst.start > BURST_WINDOW_MS) burst = { start: now, count: 0 }
      burst.count += 1
      arrivals.set(key, now)
      put(key, { kind: 'arrival', at: now, until: now + DURATION.arrival, quiet: burst.count > BURST_TRACES })
      touched()
      return
    }
    if (held && !queued) {
      put(key, { kind: 'held', at: now, until: now + DURATION.held })
      touched()
    }
    return
  }

  if (input.table === 'send_queue') {
    const source = lower(row.source)
    const automation = AUTOMATION_QUEUE_SOURCES.has(source)
    if (!automation && !OPERATOR_QUEUE_SOURCES.has(source)) return
    const status = lower(row.queue_status)
    // A sender park (blocked_sender_ineligible: daily cap / cooling — "parking
    // is NOT a send failure", sender-routing-wake.js) is not "Send failed";
    // failed_transport / undelivered are.
    const parked = status === 'blocked_sender_ineligible'
    if (!parked && (status.startsWith('failed') || status === 'undelivered' || status.includes('blocked'))) {
      put(key, { kind: 'failed', at: now, until: now + DURATION.failed, automation })
    } else if (status === 'processing' || status === 'sending') {
      put(key, { kind: 'replying', at: now, until: now + DURATION.replying, automation })
    } else if (['scheduled', 'queued', 'pending', 'approved', 'ready'].includes(status) && lower(input.eventType) === 'insert') {
      put(key, { kind: 'queued', at: now, until: now + DURATION.queued, automation })
    } else if (status === 'sent' || status === 'delivered' || status === 'cancelled') {
      const current = signals.get(key)
      if (current && (current.kind === 'replying' || current.kind === 'queued')) {
        signals.delete(key)
        emit()
      }
    }
    touched()
    return
  }

  if (input.table === 'inbox_thread_state') {
    // Like with like: the SAME column (inbox_thread_state.seller_stage) before and
    // after. The list row's stage can come from another source (the canonical
    // acquisition stage), and diffing across sources would invent movement.
    const next = str(row.seller_stage)
    const previous = knownStages.get(key)
    if (next) knownStages.set(key, next)
    const from = previous ? resolveInboxStageBadge({ seller_stage: previous }) : null
    const to = next ? resolveInboxStageBadge({ seller_stage: next }) : null
    if (from && to && from.code !== to.code) {
      put(key, { kind: 'stage', at: now, until: now + DURATION.stage, from: from.short, to: to.short })
    }
    touched()
  }
}

/** Seed the stage baseline from canonical facts, so the first live change is seen. */
export function seedRowStage(threadKey: unknown, sellerStage: unknown) {
  const key = normalizeSignalKey(threadKey)
  const stage = str(sellerStage)
  if (key && stage && !knownStages.has(key)) knownStages.set(key, stage)
}

/** The opened conversation is read: its live-arrival mark is spent. */
export function clearRowArrival(threadKey: unknown) {
  const key = normalizeSignalKey(threadKey)
  if (!key || !arrivals.has(key)) return
  arrivals.delete(key)
  emit()
}

export function readRowSignal(threadKey: unknown, now = Date.now()): RowSignal | null {
  const signal = signals.get(normalizeSignalKey(threadKey))
  return signal && signal.until > now ? signal : null
}

export function readRowArrival(threadKey: unknown): number | null {
  return arrivals.get(normalizeSignalKey(threadKey)) ?? null
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** A row's live transient. Only the row whose signal changed re-renders. */
export function useRowSignal(threadKey: string | null): RowSignal | null {
  return useSyncExternalStore(subscribe, () => (threadKey ? signals.get(normalizeSignalKey(threadKey)) ?? null : null), () => null)
}

export function useRowArrival(threadKey: string | null): number | null {
  return useSyncExternalStore(subscribe, () => (threadKey ? arrivals.get(normalizeSignalKey(threadKey)) ?? null : null), () => null)
}

/** Threads whose canonical facts are now stale (the ledger re-reads them). */
export function onSignalTouched(listener: (keys: string[]) => void): () => void {
  touchedListeners.add(listener)
  return () => { touchedListeners.delete(listener) }
}

export const __rowSignalsTest = {
  reset() {
    signals.clear()
    arrivals.clear()
    knownStages.clear()
    if (typeof window !== 'undefined') timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
    burst = { start: 0, count: 0 }
  },
  enable() { return enableRowSignals() },
}
