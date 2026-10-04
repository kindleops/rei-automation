import { describe, expect, it } from 'vitest'
import { isLoadMoreExhausted, shouldShowLoadMore, type LoadMoreProbe } from './ledger-model'

/**
 * RC 8.3.2 — the 10-04 repro: Priority counted 20, the list returned 9, every
 * Load more re-read the same 9 and the button never went away.
 */
describe('Load more terminates', () => {
  const key = 'priority|'

  it('repro: before the fix the footer offered Load more forever (count 20 > 9 rows)', () => {
    expect(shouldShowLoadMore({ rowCount: 9, canLoadMore: false, lensTotal: 20, exhausted: false })).toBe(true)
  })

  it('a load that settles with no new rows exhausts the lens', () => {
    const probe: LoadMoreProbe = { key, before: 9, settled: true }
    const exhausted = isLoadMoreExhausted(probe, key, 9)
    expect(exhausted).toBe(true)
    expect(shouldShowLoadMore({ rowCount: 9, canLoadMore: true, lensTotal: 20, exhausted })).toBe(false)
  })

  it('an in-flight load is not yet a verdict', () => {
    expect(isLoadMoreExhausted({ key, before: 9, settled: false }, key, 9)).toBe(false)
  })

  it('a load that added rows keeps paging', () => {
    expect(isLoadMoreExhausted({ key, before: 30, settled: true }, key, 60)).toBe(false)
  })

  it('a different lens or filter is a new question', () => {
    expect(isLoadMoreExhausted({ key, before: 9, settled: true }, 'new_replies|', 9)).toBe(false)
  })

  it('no rows, no footer', () => {
    expect(shouldShowLoadMore({ rowCount: 0, canLoadMore: true, lensTotal: 20, exhausted: false })).toBe(false)
  })
})
