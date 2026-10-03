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
export type BulkOutcome = 'archived' | 'unarchived' | 'unchanged' | 'blocked' | 'failed'

export interface BulkItemResult {
  id: string
  ok: boolean
  outcome: BulkOutcome
  reason?: string
  message?: string
  queued_sends?: number
  state?: string | null
}

export interface BulkSummary { requested: number; changed: number; unchanged: number; blocked: number; failed: number }

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

export type BulkPoster = (objectType: BulkObjectType, action: BulkAction, ids: string[]) => Promise<{ ok: true; results: BulkItemResult[] } | { ok: false; status: number; message: string }>

export const postBulkArchive: BulkPoster = async (objectType, action, ids) => {
  const res = await callBackend<BulkResponse>('/api/cockpit/archive/bulk', {
    method: 'POST',
    body: JSON.stringify({ object_type: objectType, action, ids }),
  })
  if (!res.ok) return { ok: false, status: res.status, message: res.message || res.error }
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
