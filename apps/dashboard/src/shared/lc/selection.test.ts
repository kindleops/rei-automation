import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  allState,
  applyGesture,
  orderedSelection,
  pruneToView,
  rangeTo,
  rowSelectionGesture,
  selectAllInView,
  toggleKey,
} from './selection'
import { runBulkArchive, summarizeResults, type BulkPoster } from '../../lib/data/bulkArchiveData'
import { issuesOf, outcomeLine } from '../../lib/data/useBulkArchive'

const order = ['a', 'b', 'c', 'd', 'e']

describe('selection model', () => {
  it('row gestures: a checkbox always selects; a modified row click selects only while a selection is active', () => {
    expect(rowSelectionGesture({}, false, true)).toBe('toggle')
    expect(rowSelectionGesture({ shiftKey: true }, false, true)).toBe('range')
    // nothing selected: ⇧/⌘ keep their object meaning (inspect / open beside)
    expect(rowSelectionGesture({ shiftKey: true }, false)).toBeNull()
    expect(rowSelectionGesture({ metaKey: true }, false)).toBeNull()
    expect(rowSelectionGesture({}, true)).toBeNull()
    expect(rowSelectionGesture({ shiftKey: true }, true)).toBe('range')
    expect(rowSelectionGesture({ metaKey: true }, true)).toBe('toggle')
    expect(rowSelectionGesture({ ctrlKey: true }, true)).toBe('toggle')
  })

  it('toggle sets the anchor; shift extends the range from it in view order, both directions', () => {
    let s = toggleKey(EMPTY_SELECTION, 'b')
    expect([...s.selected]).toEqual(['b'])
    expect(s.anchor).toBe('b')
    s = rangeTo(s, 'd', order)
    expect(orderedSelection(s, order)).toEqual(['b', 'c', 'd'])
    s = rangeTo(toggleKey(EMPTY_SELECTION, 'd'), 'a', order)
    expect(orderedSelection(s, order)).toEqual(['a', 'b', 'c', 'd'])
    // toggling again removes
    expect(toggleKey(toggleKey(EMPTY_SELECTION, 'c'), 'c').selected.size).toBe(0)
  })

  it('a range with no anchor (or an anchor out of view) toggles the one row', () => {
    expect(orderedSelection(rangeTo(EMPTY_SELECTION, 'c', order), order)).toEqual(['c'])
    expect(orderedSelection(rangeTo({ selected: new Set(), anchor: 'zz' }, 'c', order), order)).toEqual(['c'])
    expect(orderedSelection(applyGesture(EMPTY_SELECTION, 'toggle', 'e', order), order)).toEqual(['e'])
  })

  it('select all in view, all-state and pruning never keep rows the operator cannot see', () => {
    const all = selectAllInView(order)
    expect(allState(all, order)).toBe('all')
    expect(allState(toggleKey(all, 'a'), order)).toBe('some')
    expect(allState(EMPTY_SELECTION, order)).toBe('none')
    const pruned = pruneToView(all, ['a', 'c'])
    expect(orderedSelection(pruned, ['a', 'c'])).toEqual(['a', 'c'])
    expect(pruneToView(EMPTY_SELECTION, order)).toBe(EMPTY_SELECTION)
    // unchanged selection keeps identity (no re-render churn)
    const two = toggleKey(toggleKey(EMPTY_SELECTION, 'a'), 'b')
    expect(pruneToView(two, order)).toBe(two)
    // the anchor drops with its row
    expect(pruneToView({ selected: new Set(['a', 'b']), anchor: 'b' }, ['a']).anchor).toBeNull()
  })
})

describe('bulk archive client', () => {
  it('batches, reports progress and folds per-item results', async () => {
    const seen: string[][] = []
    const post: BulkPoster = async (_t, _a, ids) => {
      seen.push(ids)
      return { ok: true, results: ids.map((id) => (id === 'x3' ? { id, ok: false, outcome: 'blocked' as const, reason: 'queued_sends', message: '2 sends are still queued.' } : { id, ok: true, outcome: 'archived' as const })) }
    }
    const progress: Array<[number, number]> = []
    const ids = Array.from({ length: 5 }, (_, i) => `x${i}`)
    const report = await runBulkArchive({ objectType: 'inbox_thread', action: 'archive', ids: [...ids, 'x0'], post, batchSize: 2, onProgress: (d, t) => progress.push([d, t]) })
    expect(seen).toEqual([['x0', 'x1'], ['x2', 'x3'], ['x4']])
    expect(progress).toEqual([[0, 5], [2, 5], [4, 5], [5, 5]])
    expect(report.summary).toEqual({ requested: 5, changed: 4, unchanged: 0, blocked: 1, failed: 0 })
    expect(report.changedIds).toEqual(['x0', 'x1', 'x2', 'x4'])
  })

  it('a batch that never answered fails its own items; an auth refusal stops the rest', async () => {
    let calls = 0
    const flaky: BulkPoster = async (_t, _a, ids) => {
      calls += 1
      if (calls === 1) return { ok: false, status: 504, message: 'timed out' }
      return { ok: true, results: ids.map((id) => ({ id, ok: true, outcome: 'archived' as const })) }
    }
    const r1 = await runBulkArchive({ objectType: 'campaign', action: 'archive', ids: ['a', 'b', 'c'], post: flaky, batchSize: 2 })
    expect(r1.results.map((r) => r.outcome)).toEqual(['failed', 'failed', 'archived'])
    expect(r1.results[0].message).toBe('timed out')

    let authCalls = 0
    const denied: BulkPoster = async () => { authCalls += 1; return { ok: false, status: 401, message: 'operator_unknown' } }
    const r2 = await runBulkArchive({ objectType: 'campaign', action: 'archive', ids: ['a', 'b', 'c'], post: denied, batchSize: 1 })
    expect(authCalls).toBe(1)
    expect(r2.results.map((r) => r.reason)).toEqual(['transport', 'not_attempted', 'not_attempted'])
    expect(r2.changedIds).toEqual([])
  })

  it('a missing per-item result is a failure, never a silent success', async () => {
    const partial: BulkPoster = async () => ({ ok: true, results: [{ id: 'a', ok: true, outcome: 'archived' }] })
    const r = await runBulkArchive({ objectType: 'opportunity', action: 'archive', ids: ['a', 'b'], post: partial })
    expect(r.results[1]).toMatchObject({ id: 'b', outcome: 'failed', reason: 'no_result' })
  })

  it('outcome line and issues speak the result plainly', () => {
    const results = [
      { id: 'a', ok: true, outcome: 'archived' as const },
      { id: 'b', ok: true, outcome: 'unchanged' as const },
      { id: 'c', ok: false, outcome: 'blocked' as const, message: '1 send is still queued.' },
      { id: 'd', ok: false, outcome: 'failed' as const, reason: 'not_found' },
    ]
    const report = { objectType: 'inbox_thread' as const, action: 'archive' as const, results, summary: summarizeResults(results), changedIds: ['a'] }
    expect(outcomeLine(report, { one: 'conversation', many: 'conversations' })).toBe('1 conversation archived · 1 already archived · 1 blocked · 1 failed')
    expect(issuesOf(report, (id) => `Seller ${id}`)).toEqual([
      { id: 'c', label: 'Seller c', outcome: 'blocked', message: '1 send is still queued.' },
      { id: 'd', label: 'Seller d', outcome: 'failed', message: 'not_found' },
    ])
  })
})
