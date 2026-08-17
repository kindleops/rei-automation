import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_GRAPH_INTEGRITY_THRESHOLDS,
  evaluateGraphCommitIntegrity,
  measureGraphCommitState,
} from '@/lib/domain/campaigns/campaign-target-graph-integrity.js'

/**
 * Production measurements, 2026-08-17. These are the numbers the guard exists
 * to catch — the state in which `refresh_campaign_target_graph()` would have
 * replaced a 124,046-row two-pass graph with a 41,532-row single-pass one and
 * reported success.
 */
const PROD = {
  liveRows: 124046,
  liveWithOwner: 94723,
  sourceUniverse: 169797,
  ownerLinkedProperties: 41532,
}

const gates = (r) => r.violations.map((v) => v.gate)

test('blocks the real production single-pass rebuild', () => {
  const r = evaluateGraphCommitIntegrity({
    stagedRows: PROD.ownerLinkedProperties,
    stagedDistinctProperties: PROD.ownerLinkedProperties,
    stagedWithOwner: PROD.ownerLinkedProperties,
    liveRows: PROD.liveRows,
    liveWithOwner: PROD.liveWithOwner,
    sourceUniverse: PROD.sourceUniverse,
  })
  assert.equal(r.ok, false, 'the -67% rebuild must be refused')
  assert.ok(gates(r).includes('row_count_delta'), 'row-count delta gate must fire')
  assert.ok(gates(r).includes('source_coverage'), 'source coverage gate must fire')
  assert.ok(gates(r).includes('owner_absolute'), 'absolute owner-row loss must fire')
  assert.equal(r.metrics.row_delta, PROD.ownerLinkedProperties - PROD.liveRows)
  assert.equal(r.metrics.row_delta, -82514, 'exact production delta')
})

test('owner coverage percentage alone does not rescue a shrinking graph', () => {
  // 100% owner-linked, but two thirds of the owner universe lost. Percentage
  // improves while the graph gets materially worse — the trap this gate exists
  // for. Reach depends on absolute owner-linked rows, not the ratio.
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 41532,
    stagedDistinctProperties: 41532,
    stagedWithOwner: 41532,
    liveRows: 124046,
    liveWithOwner: 94723,
    sourceUniverse: 169797,
  })
  assert.equal(r.metrics.staged_owner_coverage_pct, 100)
  assert.ok(r.metrics.live_owner_coverage_pct < 100)
  assert.equal(r.ok, false)
  assert.ok(gates(r).includes('owner_absolute'))
})

test('blocks a semantically degraded rebuild that keeps row count', () => {
  // Same size, owner linkage stripped. Row-count gates pass; this must not.
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 124046,
    stagedDistinctProperties: 124046,
    stagedWithOwner: 12000,
    liveRows: 124046,
    liveWithOwner: 94723,
    sourceUniverse: 124046,
  })
  assert.equal(r.ok, false)
  assert.ok(gates(r).includes('owner_coverage'))
  assert.ok(gates(r).includes('owner_absolute'))
  assert.ok(!gates(r).includes('row_count_delta'), 'row count is fine here')
})

test('blocks an empty stage', () => {
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 0, stagedDistinctProperties: 0, stagedWithOwner: 0,
    liveRows: 124046, liveWithOwner: 94723, sourceUniverse: 169797,
  })
  assert.equal(r.ok, false)
  assert.ok(gates(r).includes('empty_stage'))
})

test('blocks duplicate property rows in the stage', () => {
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 170000, stagedDistinctProperties: 169797, stagedWithOwner: 100000,
    liveRows: 124046, liveWithOwner: 94723, sourceUniverse: 169797,
  })
  assert.equal(r.ok, false)
  assert.ok(gates(r).includes('uniqueness'))
  assert.equal(r.metrics.staged_duplicates, 203)
})

test('fails closed on an unreadable measurement', () => {
  for (const bad of [undefined, null, NaN, -1, 'many']) {
    const r = evaluateGraphCommitIntegrity({
      stagedRows: bad, stagedDistinctProperties: 1, stagedWithOwner: 1,
      liveRows: 124046, liveWithOwner: 94723, sourceUniverse: 169797,
    })
    assert.equal(r.ok, false, `unreadable stagedRows (${String(bad)}) must block`)
    assert.ok(gates(r).includes('measurement'))
  }
})

test('allows a correct two-pass rebuild that grows the graph', () => {
  // What a fixed pipeline should produce: full source coverage, owner linkage
  // preserved, graph grows by the 45,751 properties added since June.
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 169797,
    stagedDistinctProperties: 169797,
    stagedWithOwner: 124140, // owner-side linkage, per master_owners
    liveRows: PROD.liveRows,
    liveWithOwner: PROD.liveWithOwner,
    sourceUniverse: PROD.sourceUniverse,
  })
  assert.equal(r.ok, true, `a healthy rebuild must pass; got ${JSON.stringify(r.violations)}`)
  assert.equal(r.metrics.row_delta, 45751)
  assert.equal(r.metrics.source_coverage, 1)
})

test('allows a first-ever build when the live graph is empty', () => {
  const r = evaluateGraphCommitIntegrity({
    stagedRows: 169797, stagedDistinctProperties: 169797, stagedWithOwner: 124140,
    liveRows: 0, liveWithOwner: 0, sourceUniverse: 169797,
  })
  assert.equal(r.ok, true, 'no live graph means no shrink to protect against')
})

test('thresholds are overridable without editing the gate', () => {
  const measurements = {
    stagedRows: 100000, stagedDistinctProperties: 100000, stagedWithOwner: 80000,
    liveRows: 124046, liveWithOwner: 94723, sourceUniverse: 124046,
  }
  assert.equal(evaluateGraphCommitIntegrity(measurements).ok, false)
  const relaxed = evaluateGraphCommitIntegrity(measurements, {
    minRowRatio: 0.5, minSourceCoverage: 0.5, maxOwnerCoverageDropPoints: 20,
  })
  assert.equal(relaxed.ok, true)
  assert.equal(relaxed.thresholds.minRowRatio, 0.5)
})

test('default thresholds refuse any material shrink', () => {
  assert.ok(DEFAULT_GRAPH_INTEGRITY_THRESHOLDS.minRowRatio >= 0.9)
  assert.ok(DEFAULT_GRAPH_INTEGRITY_THRESHOLDS.minSourceCoverage >= 0.9)
  assert.equal(DEFAULT_GRAPH_INTEGRITY_THRESHOLDS.minAbsoluteRows >= 1, true)
})

test('measureGraphCommitState counts with head:true and never fetches rows', async () => {
  const seen = []
  const supabase = {
    from(table) {
      const q = {
        select(_cols, opts) { seen.push({ table, opts }); return q },
        not() { return q },
        neq() { return q },
        then(resolve) { return Promise.resolve({ count: 7, error: null }).then(resolve) },
      }
      return q
    },
  }
  const m = await measureGraphCommitState(supabase)
  assert.equal(m.liveRows, 7)
  assert.ok(seen.length >= 5, 'measures stage, stage-owner, live, live-owner, source')
  for (const s of seen) {
    assert.equal(s.opts?.head, true, `${s.table} must be a head-only count`)
    assert.equal(s.opts?.count, 'exact')
  }
})
