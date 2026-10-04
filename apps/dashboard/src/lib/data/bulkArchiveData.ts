/**
 * BULK ARCHIVE client — POST /api/cockpit/archive/bulk in batches.
 *
 * The server owns every decision (idempotency, blocked-with-queued-sends, won
 * refused, prior-status restore); this only batches ids, reports progress and
 * folds the per-item results. A batch that never answered marks its own items
 * failed with the transport reason — it never pretends they were archived.
 */
import { callBackend } from '../api/backendClient'

export type BulkObjectType = 'inbox_thread' | 'opportunity' | 'campaign'
export type BulkAction = 'archive' | 'unarchive'
/** `unconfirmed`: the request got no answer in time — the write may still have landed (RC 8.3.2). */
export type BulkOutcome = 'archived' | 'unarchived' | 'unchanged' | 'blocked' | 'failed' | 'unconfirmed'

export interface BulkItemResult {
  id: string
  ok: boolean
  outcome: BulkOutcome
  reason?: string
  message?: string
  queued_sends?: number
  state?: string | null
}

export interface BulkSummary { requested: number; changed: number; unchanged: number; blocked: number; failed: number; unconfirmed?: number }

export interface BulkRunReport {
  objectType: BulkObjectType
  action: BulkAction
  results: BulkItemResult[]
  summary: BulkSummary
  /** ids the server actually changed (what Undo reverses) */
  changedIds: string[]
}

interface BulkResponse { ok: boolean; summary?: BulkSummary; results?: BulkItemResult[]; error?: string; message?: string }

export const BULK_BATCH_SIZE = 50

export type BulkPoster = (
  objectType: BulkObjectType,
  action: BulkAction,
  ids: string[],
  options?: { timeoutMs?: number },
) => Promise<{ ok: true; results: BulkItemResult[] } | { ok: false; status: number; message: string; timedOut?: boolean }>

export const postBulkArchive: BulkPoster = async (objectType, action, ids, options) => {
  const res = await callBackend<BulkResponse>('/api/cockpit/archive/bulk', {
    method: 'POST',
    body: JSON.stringify({ object_type: objectType, action, ids }),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  if (!res.ok) return { ok: false, status: res.status, message: res.message || res.error, timedOut: res.error === 'BACKEND_TIMEOUT' }
  const body = res.data
  if (!body?.ok || !Array.isArray(body.results)) return { ok: false, status: res.status, message: body?.message || body?.error || 'The server returned no per-item results.' }
  return { ok: true, results: body.results }
}

export function summarizeResults(results: readonly BulkItemResult[]): BulkSummary {
  const s: BulkSummary = { requested: results.length, changed: 0, unchanged: 0, blocked: 0, failed: 0 }
  for (const r of results) {
    if (r.outcome === 'archived' || r.outcome === 'unarchived') s.changed += 1
    else if (r.outcome === 'unchanged') s.unchanged += 1
    else if (r.outcome === 'blocked') s.blocked += 1
    else s.failed += 1
  }
  return s
}

export async function runBulkArchive({
  objectType, action, ids, onProgress, post = postBulkArchive, batchSize = BULK_BATCH_SIZE,
}: {
  objectType: BulkObjectType
  action: BulkAction
  ids: readonly string[]
  onProgress?: (done: number, total: number) => void
  post?: BulkPoster
  batchSize?: number
}): Promise<BulkRunReport> {
  const unique = [...new Set(ids)]
  const results: BulkItemResult[] = []
  let halted: string | null = null
  onProgress?.(0, unique.length)
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    if (halted) {
      for (const id of batch) results.push({ id, ok: false, outcome: 'failed', reason: 'not_attempted', message: halted })
    } else {
      const res = await post(objectType, action, batch)
      if (res.ok) {
        const byId = new Map(res.results.map((r) => [r.id, r]))
        for (const id of batch) results.push(byId.get(id) ?? { id, ok: false, outcome: 'failed', reason: 'no_result', message: 'The server returned no result for this item.' })
      } else {
        for (const id of batch) results.push({ id, ok: false, outcome: 'failed', reason: 'transport', message: res.message })
        // auth/operator refusals apply to every batch — stop instead of repeating them
        if (res.status === 401 || res.status === 403) halted = res.message
      }
    }
    onProgress?.(Math.min(i + batch.length, unique.length), unique.length)
  }
  const changedIds = results.filter((r) => r.outcome === 'archived' || r.outcome === 'unarchived').map((r) => r.id)
  return { objectType, action, results, summary: summarizeResults(results), changedIds }
}

/* ── PER-ITEM RUN (RC 8.3.2 hotfix, 2026-10-04) ──────────────────────────────
 * One 11-id request waited on a saturated database past the client's 120 s
 * deadline and every item was reported failed — although the database shows
 * all 11 archived (universal_lead_state_events bulk_archive, 07:55:24-07:59:18Z).
 *
 * Now each id is its own request (3 in flight, 30 s each), so progress moves
 * per item and every row gets its own ✓ / ✗ / unconfirmed. A timeout is
 * `unconfirmed`, never `failed`; unconfirmed ids are re-sent once at the end
 * (the server is idempotent: an item that did land answers `unchanged`, which
 * confirms it). An auth refusal stops the rest.
 */
export const BULK_ITEM_CONCURRENCY = 3
export const BULK_ITEM_TIMEOUT_MS = 30_000

export type BulkItemPhase = 'pending' | 'done' | 'recheck'

export function summarizeItems(results: readonly BulkItemResult[]): BulkSummary {
  const s: BulkSummary = { requested: results.length, changed: 0, unchanged: 0, blocked: 0, failed: 0, unconfirmed: 0 }
  for (const r of results) {
    if (r.outcome === 'archived' || r.outcome === 'unarchived') s.changed += 1
    else if (r.outcome === 'unchanged') s.unchanged += 1
    else if (r.outcome === 'blocked') s.blocked += 1
    else if (r.outcome === 'unconfirmed') s.unconfirmed = (s.unconfirmed ?? 0) + 1
    else s.failed += 1
  }
  return s
}

const changedOutcome = (action: BulkAction): BulkOutcome => (action === 'archive' ? 'archived' : 'unarchived')

async function postOne(
  post: BulkPoster, objectType: BulkObjectType, action: BulkAction, id: string, timeoutMs: number,
): Promise<{ result: BulkItemResult; halt: string | null }> {
  try {
    const res = await post(objectType, action, [id], { timeoutMs })
    if (res.ok) {
      return { result: res.results.find((r) => r.id === id) ?? { id, ok: false, outcome: 'failed', reason: 'no_result', message: 'The server returned no result for this item.' }, halt: null }
    }
    if (res.timedOut || res.status === 504) {
      return { result: { id, ok: false, outcome: 'unconfirmed', reason: 'no_answer', message: `No answer within ${Math.round(timeoutMs / 1000)} s — it may still have completed.` }, halt: null }
    }
    return { result: { id, ok: false, outcome: 'failed', reason: 'transport', message: res.message }, halt: res.status === 401 || res.status === 403 ? res.message : null }
  } catch (error) {
    return { result: { id, ok: false, outcome: 'failed', reason: 'transport', message: error instanceof Error ? error.message : 'Request failed' }, halt: null }
  }
}

export async function runBulkPerItem({
  objectType, action, ids, onItem, onProgress, post = postBulkArchive,
  concurrency = BULK_ITEM_CONCURRENCY, timeoutMs = BULK_ITEM_TIMEOUT_MS, recheck = true,
}: {
  objectType: BulkObjectType
  action: BulkAction
  ids: readonly string[]
  onItem?: (id: string, result: BulkItemResult | null, phase: BulkItemPhase) => void
  onProgress?: (done: number, total: number) => void
  post?: BulkPoster
  concurrency?: number
  timeoutMs?: number
  recheck?: boolean
}): Promise<BulkRunReport> {
  const unique = [...new Set(ids)]
  const results = new Map<string, BulkItemResult>()
  let halted: string | null = null
  let done = 0
  onProgress?.(0, unique.length)
  for (const id of unique) onItem?.(id, null, 'pending')

  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const id = unique[next++]
      if (halted) {
        results.set(id, { id, ok: false, outcome: 'failed', reason: 'not_attempted', message: halted })
      } else {
        const { result, halt } = await postOne(post, objectType, action, id, timeoutMs)
        if (halt) halted = halt
        results.set(id, result)
      }
      done += 1
      onItem?.(id, results.get(id) ?? null, 'done')
      onProgress?.(done, unique.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, worker))

  if (recheck && !halted) {
    const unconfirmed = unique.filter((id) => results.get(id)?.outcome === 'unconfirmed')
    for (const id of unconfirmed) {
      onItem?.(id, results.get(id) ?? null, 'recheck')
      const { result } = await postOne(post, objectType, action, id, timeoutMs)
      // the item had landed: the idempotent server now reports it already in place
      const settled = result.outcome === 'unchanged'
        ? { ...result, ok: true, outcome: changedOutcome(action), reason: 'confirmed_on_recheck' }
        : result
      results.set(id, settled)
      onItem?.(id, settled, 'done')
    }
  }

  const ordered = unique.map((id) => results.get(id) ?? { id, ok: false, outcome: 'failed' as const, reason: 'no_result' })
  const changedIds = ordered.filter((r) => r.outcome === 'archived' || r.outcome === 'unarchived').map((r) => r.id)
  return { objectType, action, results: ordered, summary: summarizeItems(ordered), changedIds }
}
