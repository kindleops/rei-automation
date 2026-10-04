/**
 * BULK LEAD-STATE client — POST /api/cockpit/lead-state/bulk, one id per
 * request through the shared per-item engine (runPerItem): progress per item,
 * ✓ / ✗ / unconfirmed per row. The server decides every guard.
 */
import { useCallback, useState } from 'react'
import { callBackend } from '../api/backendClient'
import { lcToast, type LCBulkIssue } from '../../shared/lc'
import { runPerItem, type BulkItemResult, type BulkSummary } from './bulkArchiveData'
import type { BulkItemState } from './useBulkArchive'

export type BulkLeadStateAction = 'stage' | 'status' | 'follow_up' | 'snooze' | 'unsnooze' | 'read' | 'unread'

interface Response { ok: boolean; results?: BulkItemResult[]; error?: string; message?: string }

export async function postBulkLeadState(action: BulkLeadStateAction, ids: string[], value: string | null, timeoutMs?: number) {
  const res = await callBackend<Response>('/api/cockpit/lead-state/bulk', {
    method: 'POST',
    body: JSON.stringify({ action, ids, ...(value != null ? { value } : {}) }),
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  if (!res.ok) return { ok: false as const, status: res.status, message: res.message || res.error || 'Request failed', timedOut: res.error === 'BACKEND_TIMEOUT' }
  const body = res.data
  if (!body?.ok || !Array.isArray(body.results)) return { ok: false as const, status: res.status, message: body?.message || body?.error || 'The server returned no per-item results.' }
  return { ok: true as const, results: body.results }
}

export const BULK_LEAD_VERBS: Record<BulkLeadStateAction, { running: string; done: string }> = {
  stage: { running: 'Moving stage', done: 'stage moved' },
  status: { running: 'Setting status', done: 'status set' },
  follow_up: { running: 'Setting follow-up', done: 'follow-up set' },
  snooze: { running: 'Snoozing', done: 'snoozed' },
  unsnooze: { running: 'Unsnoozing', done: 'unsnoozed' },
  read: { running: 'Marking read', done: 'marked read' },
  unread: { running: 'Marking unread', done: 'marked unread' },
}

export function leadOutcomeLine(action: BulkLeadStateAction, summary: BulkSummary, noun: { one: string; many: string }): string {
  const n = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? noun.one : noun.many}`
  const parts = [`${n(summary.changed)} ${BULK_LEAD_VERBS[action].done}`]
  if (summary.blocked) parts.push(`${summary.blocked.toLocaleString('en-US')} refused`)
  if (summary.failed) parts.push(`${summary.failed.toLocaleString('en-US')} failed`)
  if (summary.unconfirmed) parts.push(`${summary.unconfirmed.toLocaleString('en-US')} unconfirmed`)
  return parts.join(' · ')
}

export type PerItemPoster = (action: BulkLeadStateAction, ids: string[], value: string | null, timeoutMs?: number) => ReturnType<typeof postBulkLeadState>

export function useBulkLeadState({ noun, labelOf, onChanged, post = postBulkLeadState }: {
  noun: { one: string; many: string }
  labelOf: (id: string) => string
  onChanged: (changedIds: string[]) => void
  post?: PerItemPoster
}) {
  const [progress, setProgress] = useState<{ verb: string; done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<{ text: string; issues: LCBulkIssue[] } | null>(null)
  const [items, setItems] = useState<ReadonlyMap<string, BulkItemState>>(() => new Map())

  const run = useCallback(async (action: BulkLeadStateAction, ids: string[], value: string | null = null) => {
    if (!ids.length) return null
    const verb = BULK_LEAD_VERBS[action].running
    setOutcome(null)
    setItems(new Map())
    setProgress({ verb, done: 0, total: ids.length })
    try {
      const report = await runPerItem({
        ids,
        post: (id, ms) => post(action, [id], value, ms),
        confirmedOutcome: 'changed',
        onProgress: (done, total) => setProgress({ verb, done, total }),
        onItem: (id, result, phase) => setItems((prev) => {
          const next = new Map(prev)
          next.set(id, phase === 'done' && result ? { phase: 'done', result } : phase === 'recheck' ? { phase: 'recheck' } : { phase: 'pending' })
          return next
        }),
      })
      const issues: LCBulkIssue[] = report.results
        .filter((r) => r.outcome === 'blocked' || r.outcome === 'failed' || r.outcome === 'unconfirmed')
        .map((r) => ({ id: r.id, label: labelOf(r.id), outcome: r.outcome === 'blocked' ? 'blocked' : 'failed', message: r.outcome === 'unconfirmed' ? `Unconfirmed — ${r.message || 'no answer in time'}` : r.message || r.reason || 'Not changed.' }))
      const line = leadOutcomeLine(action, report.summary, noun)
      setOutcome(issues.length ? { text: line, issues } : null)
      lcToast({ severity: issues.length ? 'warning' : 'success', title: line, source: 'inbox' })
      if (report.changedIds.length) onChanged(report.changedIds)
      return report
    } finally {
      setProgress(null)
    }
  }, [labelOf, noun, onChanged, post])

  return { run, progress, outcome, items, clearItems: () => setItems(new Map()), dismissOutcome: () => setOutcome(null), busy: progress !== null }
}
