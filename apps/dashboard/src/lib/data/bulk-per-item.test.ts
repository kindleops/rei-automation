import { describe, expect, it } from 'vitest'
import { runBulkPerItem, type BulkPoster } from './bulkArchiveData'
import { issuesOf, outcomeLine } from './useBulkArchive'

/**
 * RC 8.3.2 — the 10-04 repro: 11 threads in one request, no answer within the
 * deadline, all 11 reported failed while all 11 were in fact archived.
 */
describe('runBulkPerItem', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `+1555000${String(i).padStart(4, '0')}`)

  it('one request per item, progress per item, every row settled', async () => {
    const seen: string[][] = []
    const post: BulkPoster = async (_t, _a, batch) => {
      seen.push(batch)
      return { ok: true, results: batch.map((id) => ({ id, ok: true, outcome: 'archived' as const })) }
    }
    const progress: number[] = []
    const phases = new Map<string, string[]>()
    const report = await runBulkPerItem({
      objectType: 'inbox_thread', action: 'archive', ids, post,
      onProgress: (done) => progress.push(done),
      onItem: (id, _r, phase) => phases.set(id, [...(phases.get(id) ?? []), phase]),
    })
    expect(seen.every((b) => b.length === 1)).toBe(true)
    expect(seen).toHaveLength(11)
    expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect([...phases.values()].every((p) => p[0] === 'pending' && p[p.length - 1] === 'done')).toBe(true)
    expect(report.summary).toMatchObject({ requested: 11, changed: 11, failed: 0, unconfirmed: 0 })
  })

  it('a timeout is unconfirmed, never failed — and an item that landed is confirmed on recheck', async () => {
    const landed = new Set<string>()
    let firstPass = true
    const post: BulkPoster = async (_t, _a, [id]) => {
      if (firstPass) {
        landed.add(id) // the write lands…
        return { ok: false, status: 504, message: 'no answer', timedOut: true } // …but the answer never comes
      }
      return { ok: true, results: [{ id, ok: true, outcome: landed.has(id) ? 'unchanged' as const : 'archived' as const }] }
    }
    const pending = runBulkPerItem({ objectType: 'inbox_thread', action: 'archive', ids, post, onItem: (_id, r, phase) => { if (phase === 'recheck') firstPass = false; void r } })
    const report = await pending
    expect(report.summary.failed).toBe(0)
    expect(report.results.every((r) => r.outcome === 'archived' && r.reason === 'confirmed_on_recheck')).toBe(true)
    expect(report.changedIds).toHaveLength(11)
  })

  it('still no answer on recheck → stays unconfirmed and says so', async () => {
    const post: BulkPoster = async () => ({ ok: false, status: 504, message: 'no answer', timedOut: true })
    const report = await runBulkPerItem({ objectType: 'inbox_thread', action: 'archive', ids: ids.slice(0, 2), post })
    expect(report.results.map((r) => r.outcome)).toEqual(['unconfirmed', 'unconfirmed'])
    expect(outcomeLine(report, { one: 'conversation', many: 'conversations' })).toBe('0 conversations archived · 2 unconfirmed')
    expect(issuesOf(report, (id) => id)[0].message).toMatch(/^Unconfirmed/)
  })

  it('an auth refusal stops the rest without retrying', async () => {
    let calls = 0
    const post: BulkPoster = async () => { calls += 1; return { ok: false, status: 401, message: 'operator_unknown' } }
    const report = await runBulkPerItem({ objectType: 'inbox_thread', action: 'archive', ids: ids.slice(0, 6), post, concurrency: 1 })
    expect(calls).toBe(1)
    expect(report.results.slice(1).every((r) => r.reason === 'not_attempted')).toBe(true)
  })
})
