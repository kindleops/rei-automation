import { useEffect, useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import type { LedgerFacts } from './ledger-model'
import { onSignalTouched, seedRowStage } from './live-row-signals'

/**
 * INBOX DESKTOP 4.0 — the ledger's per-row facts, read progressively.
 *
 * Rows paint from the list response (identity, latest reply, stage). The
 * facts (canonical bucket flags, read state, waiting / follow-up timestamps,
 * stored valuation) follow from /api/cockpit/inbox/ledger-facts for the rows
 * actually on screen: batched, cached per thread, and re-read only when a
 * realtime change touches that thread. No polling, no per-row requests.
 */

const ENDPOINT = '/api/cockpit/inbox/ledger-facts'
const BATCH_MS = 120
const CHUNK = 100
const STALE_MS = 90_000
const TOUCH_DEBOUNCE_MS = 1_500

type Entry = { facts: LedgerFacts | null; at: number }

const cache = new Map<string, Entry>()
const inflight = new Set<string>()
const queued = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let flushTimer = 0
let touchTimer = 0
const touchedKeys = new Set<string>()

const emit = () => { version += 1; listeners.forEach((listener) => listener()) }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function fetchChunk(keys: string[]) {
  keys.forEach((key) => inflight.add(key))
  try {
    const result = await callBackend<Record<string, unknown>>(`${ENDPOINT}?keys=${encodeURIComponent(keys.join(','))}`)
    const body = result.ok ? asRecord(result.data) : {}
    const facts = asRecord(body.facts ?? asRecord(body.data).facts)
    const ok = result.ok && body.ok !== false
    const now = Date.now()
    for (const key of keys) {
      const value = facts[key] as LedgerFacts | undefined
      // A failed read leaves the previous facts (or nothing) in place; it never
      // writes "no facts" over good ones.
      if (value) {
        cache.set(key, { facts: value, at: now })
        seedRowStage(key, value.seller_stage)
      } else if (ok) {
        cache.set(key, { facts: null, at: now })
      }
    }
  } catch {
    /* enrichment is best-effort: rows keep their lens state */
  } finally {
    keys.forEach((key) => inflight.delete(key))
    emit()
  }
}

function flush() {
  flushTimer = 0
  const keys = [...queued].filter((key) => !inflight.has(key))
  queued.clear()
  for (let i = 0; i < keys.length; i += CHUNK) void fetchChunk(keys.slice(i, i + CHUNK))
}

/** Ask for facts for these thread keys (missing or stale ones only, unless forced). */
export function requestLedgerFacts(keys: readonly string[], options: { force?: boolean } = {}) {
  if (typeof window === 'undefined') return
  const now = Date.now()
  let added = false
  for (const key of keys) {
    if (!key || inflight.has(key)) continue
    const entry = cache.get(key)
    if (!options.force && entry && now - entry.at < STALE_MS) continue
    queued.add(key)
    added = true
  }
  if (added && !flushTimer) flushTimer = window.setTimeout(flush, BATCH_MS)
}

/** Facts for one thread key, or null while they have not arrived (or do not exist). */
export function readLedgerFacts(key: string | null | undefined): LedgerFacts | null {
  return key ? cache.get(key)?.facts ?? null : null
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/**
 * Subscribe a ledger to the facts of the keys it shows. Returns a version
 * number that changes whenever any facts land (rows read their own entry).
 */
export function useLedgerFacts(keys: readonly string[]): number {
  const signature = keys.join('\u0001')
  useEffect(() => {
    if (!signature) return
    requestLedgerFacts(signature.split('\u0001'))
  }, [signature])

  // Realtime touched a thread: its canonical state may have moved. Re-read it
  // once things settle — coalesced, so a burst is one request.
  useEffect(() => onSignalTouched((touched) => {
    touched.forEach((key) => touchedKeys.add(key))
    if (touchTimer) window.clearTimeout(touchTimer)
    touchTimer = window.setTimeout(() => {
      touchTimer = 0
      const pending = [...touchedKeys].filter((key) => cache.has(key))
      touchedKeys.clear()
      if (pending.length) requestLedgerFacts(pending, { force: true })
    }, TOUCH_DEBOUNCE_MS)
  }), [])

  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** After a local write the server confirmed (read, snooze), re-read that row. */
export function refreshLedgerFacts(key: string | null | undefined) {
  if (key) requestLedgerFacts([key], { force: true })
}

export const __ledgerFactsTest = {
  reset() { cache.clear(); inflight.clear(); queued.clear(); version = 0 },
  set(key: string, facts: LedgerFacts | null) { cache.set(key, { facts, at: Date.now() }); emit() },
}
