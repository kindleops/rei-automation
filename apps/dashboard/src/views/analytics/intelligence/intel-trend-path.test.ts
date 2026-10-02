import { describe, expect, it } from 'vitest'
import { trendSegments } from './intel-trend-path'

const N = null

describe('trendSegments — one continuous trend, no invented values', () => {
  it('reproduces the production reply-rate shape (30D to 2026-10-01): the line no longer stops after its first run', () => {
    // 09-01…10-01 daily reply rate: empty first week, a run 09-08…09-11, eleven empty days,
    // 09-23 (n=7, thin), 09-27 (n=1, thin), 09-28, empty 09-29, 09-30, empty today
    const cur: Array<number | null> = [N, N, N, N, N, N, N, 0.136, 0.09, 0.474, 0.474, N, N, N, N, N, N, N, N, N, N, N, 0.143, N, N, N, 1, 0.074, N, 0.122, N]
    const den = [0, 0, 0, 0, 0, 0, 0, 184, 145, 19, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 1, 285, 0, 189, 0]
    const sure = cur.map((v, i) => (v !== null && den[i] >= 10 ? v : null))
    const s = trendSegments(cur, sure)
    expect(s.solid).toEqual([[7, 8, 9, 10]])
    expect(s.bridge).toEqual([[10, 22], [22, 26], [27, 29]])
    expect(s.thin).toEqual([[26, 27]])
    // 09-28 and 09-30 were invisible before (one-point paths); now each is a dot on a connected line
    expect(s.lone).toEqual([27, 29])
    // the empty days inside a bridge know they are bridged; the leading week and today are not
    expect(s.bridged.get(15)).toEqual([10, 22])
    expect(s.bridged.has(3)).toBe(false)
    expect(s.bridged.has(30)).toBe(false)
    // the line the Lab draws for a rate: through credible days only — 09-23 (n=7) and 09-27 (1 of 1)
    // stay hollow dots beside it instead of yanking it to 100%
    const credible = trendSegments(sure, sure)
    expect(credible.solid).toEqual([[7, 8, 9, 10]])
    expect(credible.bridge).toEqual([[10, 27], [27, 29]])
    expect(credible.thin).toEqual([])
    expect(credible.bridged.get(22)).toEqual([10, 27])
  })

  it('a count series (zeros are real) is one solid run', () => {
    const s = trendSegments([0, 0, 4, 0, 2])
    expect(s.solid).toEqual([[0, 1, 2, 3, 4]])
    expect(s.bridge).toEqual([])
    expect(s.lone).toEqual([])
  })

  it('never draws before the first or after the last observed bucket, and never fills a gap', () => {
    const s = trendSegments([N, 0.2, N, N, 0.3, N])
    expect(s.solid).toEqual([])
    expect(s.bridge).toEqual([[1, 4]])
    expect([...s.bridged.keys()]).toEqual([2, 3])
    expect(s.lone).toEqual([1, 4])
  })

  it('an all-empty series draws nothing', () => {
    const s = trendSegments([N, N, N])
    expect(s).toMatchObject({ solid: [], thin: [], bridge: [], lone: [] })
  })
})
