/**
 * useBulkArchive — the one confirm → progress → result → Undo flow every list
 * uses for bulk archive. The surface supplies the object type, nouns, a label
 * per id (for the per-item reasons) and what to do once items changed (hide
 * them, refresh its counts). The server decides everything else.
 */
import { useCallback, useState } from 'react'
import { lcConfirm, lcToast, type LCBulkIssue, type LCEffect } from '../../shared/lc'
import { runBulkArchive, type BulkAction, type BulkObjectType, type BulkRunReport, type BulkPoster, postBulkArchive } from './bulkArchiveData'

export interface BulkNoun { one: string; many: string }

export interface UseBulkArchiveOptions {
  objectType: BulkObjectType
  noun: BulkNoun
  /** what archiving this kind of object does, in the operator's words */
  consequences: LCEffect[]
  labelOf: (id: string) => string
  /** called after every run that changed something (archive or undo) */
  onChanged: (report: BulkRunReport) => void
  source: string
  post?: BulkPoster
}

const n = (count: number, noun: BulkNoun) => `${count.toLocaleString('en-US')} ${count === 1 ? noun.one : noun.many}`

export function outcomeLine(report: BulkRunReport, noun: BulkNoun): string {
  const { summary, action } = report
  const parts = [`${n(summary.changed, noun)} ${action === 'archive' ? 'archived' : 'restored'}`]
  if (summary.unchanged) parts.push(`${summary.unchanged.toLocaleString('en-US')} already ${action === 'archive' ? 'archived' : 'active'}`)
  if (summary.blocked) parts.push(`${summary.blocked.toLocaleString('en-US')} blocked`)
  if (summary.failed) parts.push(`${summary.failed.toLocaleString('en-US')} failed`)
  return parts.join(' · ')
}

export function issuesOf(report: BulkRunReport, labelOf: (id: string) => string): LCBulkIssue[] {
  return report.results
    .filter((r) => r.outcome === 'blocked' || r.outcome === 'failed')
    .map((r) => ({ id: r.id, label: labelOf(r.id), outcome: r.outcome as 'blocked' | 'failed', message: r.message || r.reason || 'Not changed.' }))
}

export function useBulkArchive({ objectType, noun, consequences, labelOf, onChanged, source, post = postBulkArchive }: UseBulkArchiveOptions) {
  const [progress, setProgress] = useState<{ verb: string; done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<{ text: string; issues: LCBulkIssue[] } | null>(null)

  const execute = useCallback(async (ids: string[], action: BulkAction): Promise<BulkRunReport> => {
    const verb = action === 'archive' ? 'Archiving' : 'Restoring'
    setOutcome(null)
    setProgress({ verb, done: 0, total: ids.length })
    try {
      const report = await runBulkArchive({ objectType, action, ids, post, onProgress: (done, total) => setProgress({ verb, done, total }) })
      const issues = issuesOf(report, labelOf)
      setOutcome(issues.length ? { text: outcomeLine(report, noun), issues } : null)
      if (report.changedIds.length) onChanged(report)
      return report
    } finally {
      setProgress(null)
    }
  }, [labelOf, noun, objectType, onChanged, post])

  const undo = useCallback(async (ids: string[]) => {
    const report = await execute(ids, 'unarchive')
    const partial = report.summary.blocked + report.summary.failed > 0
    lcToast({
      severity: partial ? 'warning' : 'success',
      title: `Restored ${n(report.summary.changed, noun)}`,
      detail: partial ? outcomeLine(report, noun) : undefined,
      source,
    })
  }, [execute, noun, source])

  const archive = useCallback(async (ids: string[]) => {
    if (!ids.length) return null
    const ok = await lcConfirm({
      title: `Archive ${n(ids.length, noun)}?`,
      effects: [
        ...consequences,
        { kind: 'keeps', text: 'Nothing is deleted. Unarchive brings every item back with its history.' },
        { kind: 'note', text: 'Items with sends still queued are not archived; they are listed with the reason.' },
      ],
      confirmLabel: `Archive ${ids.length.toLocaleString('en-US')}`,
      tone: 'primary',
      nativeText: `Archive ${n(ids.length, noun)}? Nothing is deleted; items with queued sends are skipped.`,
    })
    if (!ok) return null
    const report = await execute(ids, 'archive')
    const { summary } = report
    const partial = summary.blocked + summary.failed > 0
    if (summary.changed > 0) {
      const changed = report.changedIds
      lcToast({
        severity: partial ? 'warning' : 'success',
        title: `Archived ${n(summary.changed, noun)}`,
        detail: partial ? outcomeLine(report, noun) : 'They left every count. Nothing was deleted.',
        source,
        dismissMs: 10000,
        action: { label: 'Undo', onClick: () => { void undo(changed) } },
      })
    } else {
      lcToast({ severity: 'warning', title: `Nothing archived`, detail: outcomeLine(report, noun), source })
    }
    return report
  }, [consequences, execute, noun, source, undo])

  return { archive, undo, progress, outcome, dismissOutcome: () => setOutcome(null), busy: progress !== null }
}
