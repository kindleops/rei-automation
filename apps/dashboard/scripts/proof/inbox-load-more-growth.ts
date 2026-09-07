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

console.log(`\nPASS  ${passed} checks\n`)
