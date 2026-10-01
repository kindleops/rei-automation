import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyNegotiationZone, toConfidenceFraction, NEGOTIATION_ZONES } from '../../src/lib/domain/seller-flow/negotiation-policy.js'
import { decisionRefreshResult, STATUS } from '../../src/lib/domain/workflow-studio/orchestrator/capabilities.js'
import { FOLLOWUP_MESSAGE_TYPES, loadInvariantWindows } from '../../src/app/api/internal/ops/autonomy-invariants-scan/route.js'

// ── P9: valuation confidence scale ────────────────────────────────────────
test('toConfidenceFraction reads 0–100 engine values and 0–1 fractions on one scale', () => {
  assert.equal(toConfidenceFraction(62), 0.62)
  assert.equal(toConfidenceFraction(0.8), 0.8)
  assert.equal(toConfidenceFraction(null), null)
  assert.equal(toConfidenceFraction(-5), null)
})

test('a 0–100 valuation confidence below 45 no longer passes the 0.45 offer gate', () => {
  const base = { current_ask: 90000, recommended_offer: 80000, authorized_offer_ceiling: 95000 }
  assert.equal(classifyNegotiationZone({ ...base, valuation_confidence: 30 }).zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE)
  assert.equal(classifyNegotiationZone({ ...base, valuation_confidence: 30 }).reason_code, 'VALUATION_CONFIDENCE_BELOW_POLICY')
  assert.equal(classifyNegotiationZone({ ...base, valuation_confidence: 62 }).zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY)
  // fractions keep their old meaning
  assert.equal(classifyNegotiationZone({ ...base, valuation_confidence: 0.2 }).zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE)
  assert.equal(classifyNegotiationZone({ ...base, valuation_confidence: 0.8 }).zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY)
})

// ── workflow capability: decision engine failure status ───────────────────
test('deal.ensure_decision treats decision_engine_failed as a retryable failure', () => {
  assert.equal(decisionRefreshResult({ status: 'decision_engine_failed' }).status, STATUS.RETRYABLE)
  assert.equal(decisionRefreshResult({ status: 'ENGINE_FAILED' }).status, STATUS.RETRYABLE)
  assert.deepEqual(decisionRefreshResult({ status: 'current' }), { status: STATUS.SUCCESS, outputs: { decision_state: 'current' } })
  assert.equal(decisionRefreshResult(null).status, STATUS.SUCCESS)
})

// ── invariant scan: follow-up message_type spellings ──────────────────────
test('invariant scan reads follow-ups under every spelling the writers use', async () => {
  const calls = []
  const builder = (table) => {
    const q = {
      _f: [],
      select() { return q },
      order() { return q },
      gte() { return q },
      or() { return q },
      in(col, vals) { q._f.push(['in', col, vals]); return q },
      eq(col, val) { q._f.push(['eq', col, val]); return q },
      limit() { calls.push({ table, filters: q._f }); return Promise.resolve({ data: [], error: null }) },
    }
    return q
  }
  await loadInvariantWindows({ from: builder }, { window_hours: 24, row_limit: 10, now_ms: Date.parse('2026-10-01T00:00:00Z') })
  const followups = calls.find((c) => c.table === 'send_queue' && c.filters.some((f) => f[1] === 'message_type'))
  assert.ok(followups, 'follow-up read present')
  const mt = followups.filters.find((f) => f[1] === 'message_type')
  assert.equal(mt[0], 'in')
  assert.deepEqual([...mt[2]].sort(), ['Follow-Up', 'follow_up', 'followup'].sort())
  assert.ok(FOLLOWUP_MESSAGE_TYPES.includes('followup'))
})
