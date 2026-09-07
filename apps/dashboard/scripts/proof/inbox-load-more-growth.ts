/**
 * inbox-load-more-growth.ts
 *
 * Load More for cursorless buckets grows the PAGE, and each click must ask for
 * a strictly larger page than the last.
 *
 * These buckets (new_replies, waiting, cold, all_messages) are post-filtered
 * server-side, so a 50-row page can yield 16 visible rows. The growth base was
 * the number of rows that SURVIVED filtering, so Math.max(16, 25) * 2 produced
 * 50 -- the same request that had just returned those 16 rows. Load More
 * re-issued an identical query, appended nothing, and then vanished as though
 * the bucket were exhausted. Measured on staging: New Replies showed 16 of 164.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const CAP = 500

/** The corrected rule: grow from the last REQUESTED page size. */
const nextLimit = (lastLimit: number, loaded: number): number =>
  Math.min(Math.max(lastLimit, loaded, 25) * 2, CAP)

/** The old rule, kept only to prove the defect it caused. */
const oldNextLimit = (loaded: number): number => Math.min(Math.max(loaded, 25) * 2, CAP)

console.log('\nLOAD MORE PAGE GROWTH')

check('the old rule repeated the same request forever', () => {
  // Exactly the staging trace: page 30 -> 10 rows, page 50 -> 16 rows.
  assert.equal(oldNextLimit(10), 50)
  assert.equal(oldNextLimit(16), 50, 'second click asked for the same page it already had')
  assert.equal(oldNextLimit(24), 50, 'and so did every click until 25 rows survived filtering')
})

check('each click now asks for a strictly larger page', () => {
  const sequence: number[] = []
  let limit = 30
  // A deliberately poor yield: ~1 visible row per 3 fetched, so `loaded` never
  // catches up with the page size. This is the case the old rule broke on.
  for (let i = 0; i < 6; i += 1) {
    const loaded = Math.floor(limit / 3)
    limit = nextLimit(limit, loaded)
    sequence.push(limit)
  }
  assert.deepEqual(sequence, [60, 120, 240, 480, 500, 500])

  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i - 1] >= CAP) break
    assert.ok(sequence[i] > sequence[i - 1], `click ${i + 1} must ask for more than click ${i}`)
  }
})

check('a healthy bucket still grows from its row count', () => {
  // When filtering discards little, `loaded` can exceed the last page size and
  // should drive growth -- the original intent, preserved.
  assert.equal(nextLimit(50, 300), 500)
  assert.equal(nextLimit(25, 40), 80)
})

check('growth is capped and then stops', () => {
  assert.equal(nextLimit(480, 100), 500)
  assert.equal(nextLimit(500, 100), 500)
  // At the cap the next request would be identical, so the caller stops rather
  // than spinning on a no-op.
  const lastLimit = 500
  assert.ok(lastLimit >= CAP && nextLimit(lastLimit, 100) <= lastLimit, 'exhausted')
})

check('the very first Load More still opens up the page', () => {
  // Boot page is 30 and yields 10; the first click must exceed 30.
  assert.ok(nextLimit(30, 10) > 30)
  assert.equal(nextLimit(30, 10), 60)
})

check('the growth base must come from the RECORDED request, not lastFetchRef', () => {
  // Second staging failure: the fix read lastFetchRef.limit, but that ref is
  // written by `refresh` and Load More calls runLoad directly -- so it stayed
  // at the bucket-switch value of 30 and every click asked for 60. Measured:
  // 30 -> 10 rows, click 1 -> limit 60 (21 rows), click 2 -> limit 60 again.
  const source = readFileSync(
    new URL('../../src/modules/inbox/inbox.adapter.ts', import.meta.url), 'utf8')

  assert.ok(
    /lastRequestedLimitRef\.current\[bucketKey\] = requestedLimit/.test(source),
    'runLoad must record the page size it actually requested',
  )
  assert.ok(
    /const recordedLimit = lastRequestedLimitRef\.current\[stateRef\.current\.activeBucketKey\]/.test(source),
    'loadMore must grow from that recorded value',
  )
  // Simulate the real sequence with a recorded base that advances.
  let recorded = 30
  const seen: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const loaded = Math.floor(recorded / 3)
    recorded = nextLimit(recorded, loaded)
    seen.push(recorded)
  }
  assert.deepEqual(seen, [60, 120, 240, 480], 'each click must advance')
})

console.log(`\nPASS  ${passed} checks\n`)
