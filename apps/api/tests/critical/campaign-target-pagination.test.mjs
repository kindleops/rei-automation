import test from 'node:test'
import assert from 'node:assert/strict'

import { PAGE_SIZE, paginateRows, exactCount } from '@/lib/domain/campaigns/campaign-target-pagination.js'
import { fetchCampaignTargetStatusCounts } from '@/lib/domain/campaigns/campaign-recipient-metrics.js'

/**
 * Regression guard for the silent PostgREST truncation that made every campaign
 * count wrong.
 *
 * PostgREST clamps a response to its server-side max-rows (1000 here). A
 * client-side `.limit(100000)` does NOT raise that ceiling — the request is
 * capped with no error and no signal. Measured in production 2026-08-17:
 * `.limit(100000)` returned 1000 of 2359 rows, so the campaign list reported
 * ~1000 targets across ALL campaigns and attributed them to whichever sorted
 * first (Miami read "630 tgt / 10 ready" against a true 802).
 */

/** Fake PostgREST that enforces max-rows exactly as the real server does. */
function makeCappedSupabase(allRows, { maxRows = PAGE_SIZE } = {}) {
  let lastRange = null
  const builder = {
    select() { return builder },
    in() { return builder },
    eq() { return builder },
    is() { return builder },
    order() { return builder },
    limit(n) {
      // The real server ignores anything above max-rows.
      lastRange = { from: 0, to: Math.min(n, maxRows) - 1 }
      return builder
    },
    range(from, to) {
      lastRange = { from, to: Math.min(to, from + maxRows - 1) }
      return builder
    },
    then(resolve) {
      const { from, to } = lastRange ?? { from: 0, to: maxRows - 1 }
      const slice = allRows.slice(from, to + 1).slice(0, maxRows)
      return Promise.resolve({ data: slice, error: null }).then(resolve)
    },
  }
  return { from: () => builder }
}

const rows = (n, campaignId, status) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${campaignId}-${String(i).padStart(5, '0')}`,
    campaign_id: campaignId,
    target_status: status,
    block_reason: null,
  }))

test('paginateRows returns every row when the set exceeds max-rows', async () => {
  const all = rows(2359, 'c1', 'ready')
  const supabase = makeCappedSupabase(all)

  const single = await new Promise((r) => supabase.from().select('*').limit(100000).then(r))
  assert.equal(single.data.length, PAGE_SIZE, 'a single over-limit select is still capped at max-rows')

  const paged = await paginateRows((from, to) => supabase.from().select('*').order('id').range(from, to))
  assert.equal(paged.length, 2359, 'pagination must assemble the complete set')
  assert.equal(new Set(paged.map((r) => r.id)).size, 2359, 'no duplicated rows across pages')
})

test('paginateRows stops on a short page and does not loop forever', async () => {
  const paged = await paginateRows((from, to) =>
    makeCappedSupabase(rows(10, 'c1', 'ready')).from().select('*').range(from, to),
  )
  assert.equal(paged.length, 10)
})

test('paginateRows handles an exact multiple of the page size', async () => {
  const paged = await paginateRows((from, to) =>
    makeCappedSupabase(rows(PAGE_SIZE * 2, 'c1', 'ready')).from().select('*').range(from, to),
  )
  assert.equal(paged.length, PAGE_SIZE * 2, 'a full final page must still terminate correctly')
})

test('campaign status counts are complete and per-campaign across the cap', async () => {
  // Two campaigns whose combined targets exceed max-rows. Under the old single
  // capped query the second campaign lost most of its rows entirely.
  const all = [...rows(802, 'miami', 'ready'), ...rows(770, 'la', 'ready')]
  const supabase = makeCappedSupabase(all)

  const counts = await fetchCampaignTargetStatusCounts(['miami', 'la'], { supabase })

  assert.equal(counts.get('miami').total, 802, 'first campaign complete')
  assert.equal(counts.get('la').total, 770, 'second campaign must not be truncated by the shared cap')
  assert.equal(counts.get('miami').statuses.ready, 802)
  assert.equal(counts.get('la').statuses.ready, 770)
  assert.equal(
    counts.get('miami').total + counts.get('la').total,
    1572,
    'combined total must exceed the 1000-row cap',
  )
})

test('a campaign with zero targets reports 0 rather than being absent', async () => {
  const supabase = makeCappedSupabase([])
  const counts = await fetchCampaignTargetStatusCounts(['empty'], { supabase })
  assert.ok(counts.has('empty'), 'every requested campaign must be present in the map')
  assert.equal(counts.get('empty').total, 0)
})

test('exactCount reads the count and is not subject to max-rows', async () => {
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ count: 2359, error: null }) }),
    }),
  }
  const n = await exactCount(supabase, 'campaign_targets', (q) => q.eq('campaign_id', 'x'))
  assert.equal(n, 2359)
})
