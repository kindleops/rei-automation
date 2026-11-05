// 8.5.21-b — the supervisor monitors research status, valuation coverage, overdue offers and
// negotiation authority (unavailable, never 0); the brief carries them; the MCP-safe read-only
// status tool for Agntei; the snapshot SQL is the migration's function body (drift guard).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'
import { buildOperatingBrief, renderBriefMarkdown } from '../../src/lib/agent/operations/operating-brief.js'
import { buildDigest } from '../../src/lib/agent/missions/review-digest-handler.js'
import { opsIntelTool, containsContactValue, OPS_INTEL_TOOL_NAME } from '../../src/lib/agent/operations/ops-intel-capability.js'
import { RESEARCH_VALUATION_SNAPSHOT_SQL } from '../../src/lib/agent/operations/research-valuation-sql.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { T0, H, D, at, uuid } from '../helpers/operations-fixtures.mjs'

const RV = (o = {}) => ({ at: at(T0), valuation: { live: 40, with_score: 30, offer_ready: 12, missing: 10, stale_30d: 4, by_tier: { AUTO_HARD_OFFER: 8, AUTO_RANGE_OFFER: 4, CREATIVE_TERMS: 14, REVIEW_REQUIRED: 4, none: 10 }, ...(o.valuation || {}) }, offers: { sent_30d: 6, overdue_no_reply_72h: 2, overdue_opportunity_ids: [uuid(), uuid()], ...(o.offers || {}) }, negotiations: { envelopes: null, live_envelopes: null, ledger_events_7d: null, send_authorizations: null, in_negotiation_stage: 9, ...(o.negotiations || {}) } })
const ids = ['research_status', 'valuation_coverage', 'overdue_offers', 'negotiation_authority']
const check = (ev, id) => ev.checks.find((c) => c.id === id)

test('supervisor: research status, valuation coverage, overdue offers and negotiation authority are measured from their sources', () => {
  const runtime = { jobs: [{ kind: 'property.research', state: 'completed' }, { kind: 'property.research', state: 'budget_blocked' }, { kind: 'valuation.refresh', state: 'completed' }] }
  const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, runtime, researchValuation: RV(), valuationBatch: { at: at(T0 - 3 * H), queued: 25, gained_offer_ready: 7, gained_valuation: 10, mode: 'dry_run' }, now: T0 })
  const rs = check(ev, 'research_status')
  assert.deepEqual([rs.status, rs.value.jobs_24h, rs.value.failed_or_blocked], ['warn', 3, 1])
  const vc = check(ev, 'valuation_coverage')
  assert.deepEqual([vc.status, vc.value.offer_ready, vc.value.live, vc.value.missing, vc.value.offer_ready_share], ['warn', 12, 40, 10, 0.3])
  assert.deepEqual([vc.value.last_dry_run.gained_offer_ready, vc.value.last_dry_run.age_hours, vc.value.last_dry_run.mode], [7, 3, 'dry_run'])
  const od = check(ev, 'overdue_offers')
  assert.deepEqual([od.status, od.value.overdue_no_reply_72h, od.value.opportunity_ids.length], ['warn', 2, 2])
  const na = check(ev, 'negotiation_authority')
  assert.deepEqual([na.status, na.code, na.value.in_negotiation_stage], ['unavailable', 'NEGOTIATION_TABLES_NOT_APPLIED', 9], 'tables not applied ⇒ unavailable, never 0 envelopes')
  assert.ok(ev.issues.some((i) => i.dedupe_key === 'supervisor:valuation_coverage' && i.remediation.action === 'run_valuation_refresh_queue_dry_run'))
  assert.ok(ev.issues.some((i) => i.dedupe_key === 'supervisor:overdue_offers'))
  // applied tables ⇒ counted
  const ev2 = evaluateSupervisor({ snapshot: { unavailable: 'X' }, runtime, researchValuation: RV({ negotiations: { envelopes: 3, live_envelopes: 1, ledger_events_7d: 4, send_authorizations: 0 } }), now: T0 })
  assert.deepEqual([check(ev2, 'negotiation_authority').status, check(ev2, 'negotiation_authority').value.envelopes], ['ok', 3])
})

test('supervisor: a missing source is "unavailable" — never ok, never 0 (and all_clear stays false)', () => {
  const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, now: T0 })
  for (const id of ids) assert.equal(check(ev, id).status, 'unavailable', id)
  assert.equal(check(ev, 'valuation_coverage').code, 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE')
  assert.equal(check(ev, 'valuation_coverage').value, undefined, 'no fabricated counts')
  const none = evaluateSupervisor({ snapshot: { unavailable: 'X' }, runtime: { jobs: [{ kind: 'ops.health_check', state: 'completed' }] }, now: T0 })
  assert.deepEqual([check(none, 'research_status').status, check(none, 'research_status').code], ['unavailable', 'NO_RESEARCH_JOBS_24H'], 'no research jobs ⇒ unavailable, not "0 failures, ok"')
  assert.equal(ev.all_clear, false)
})

test('brief: a "Research & valuation coverage" section from real reads; unavailable lines when its read is missing; next actions for overdue offers + missing valuations', () => {
  const digest = buildDigest({ activity: { jobs: [{ job_id: 'job_r', kind: 'property.research', state: 'completed', cost_usd: 0 }], findings: [] }, approvals: [], shadow: null, since: at(T0 - D), at: at(T0) })
  const jobs = [{ job_id: 'job_r', kind: 'property.research', state: 'completed' }]
  const b = buildOperatingBrief({ digest, jobs, approvals: [], researchValuation: RV(), valuationBatch: { at: at(T0 - H), queued: 25, gained_offer_ready: 7, mode: 'dry_run', job_id: 'job_v' } })
  const s = b.sections.find((x) => x.id === 'research_and_valuation')
  assert.equal(s.available, true)
  assert.deepEqual(s.lines.map((l) => l.value), [12, 10, 2, 1, 7])
  assert.equal(s.lines[0].of, 40)
  assert.ok(s.lines[2].links.every((l) => l.source === 'public.acquisition_opportunities'))
  const rec = b.sections.find((x) => x.id === 'recommended_next_actions')
  assert.ok(rec.lines.some((l) => /overdue offer/.test(l.label)))
  assert.ok(rec.lines.some((l) => /valuation refresh dry run/.test(l.label)))
  assert.match(renderBriefMarkdown(b), /Live opportunities offer-ready \(engine\): \*\*12 of 40\*\*/)
  const missing = buildOperatingBrief({ digest, jobs, approvals: [], researchValuation: { unavailable: 'SOURCE_NOT_APPLIED' }, valuationBatch: { unavailable: 'VALUATION_REFRESH_NOT_RUN' } })
  const m = missing.sections.find((x) => x.id === 'research_and_valuation')
  assert.equal(m.lines[0].value, null)
  assert.equal(m.lines[0].unavailable, 'SOURCE_NOT_APPLIED')
  assert.equal(m.lines[4].unavailable, 'VALUATION_REFRESH_NOT_RUN')
  const none = buildOperatingBrief({ digest, jobs: { unavailable: 'RUNTIME_UNAVAILABLE' }, approvals: [] })
  assert.equal(none.sections.find((x) => x.id === 'research_and_valuation').available, false)
})

test('MCP-safe status tool: read-only annotations, closed input, every section from its source, unavailable-not-zero, contact values refused', async () => {
  assert.equal(opsIntelTool.name, OPS_INTEL_TOOL_NAME)
  assert.deepEqual(opsIntelTool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  assert.equal(opsIntelTool.inputSchema.additionalProperties, false)
  const findings = { 'supervisor.summary': { job_id: 'j1', retrieved_at: at(T0), value: { counts: { ok: 10 }, all_clear: false } }, 'valuation.refresh_batch': { job_id: 'j2', retrieved_at: at(T0), value: { queued: 25, gained_offer_ready: 7 } }, 'recovery.batch': { job_id: 'j3', retrieved_at: at(T0), value: { by_class: { research_worthy: 3 } } }, 'recovery.linkage': { job_id: 'j3', retrieved_at: at(T0), value: { research: { requested: 3 }, valuation_requests: [{}, {}], by_next_action: { a: 1 } } } }
  const store = { latestFinding: async ({ finding_type }) => findings[finding_type] || null }
  const source = createOperationsMemorySource({ researchValuation: RV() })
  const r = await opsIntelTool.run({}, { store, source, now: () => T0 })
  assert.equal(r.read_only, true)
  assert.deepEqual(Object.keys(r.sections), ['supervisor', 'research_valuation', 'valuation_dry_run', 'recovery'])
  assert.equal(r.sections.research_valuation.value.valuation.offer_ready, 12)
  assert.deepEqual(r.sections.recovery.linkage, { research: { requested: 3 }, valuation_requests: 2, by_next_action: { a: 1 } })
  const empty = await opsIntelTool.run({ sections: ['supervisor', 'research_valuation'] }, { store: { latestFinding: async () => null }, now: () => T0 })
  assert.deepEqual(empty.sections.supervisor, { available: false, code: 'SUPERVISOR_NOT_RUN' })
  assert.deepEqual(empty.sections.research_valuation, { available: false, code: 'RESEARCH_VALUATION_SOURCE_NOT_CONFIGURED' })
  const leaky = await opsIntelTool.run({ sections: ['supervisor'] }, { store: { latestFinding: async () => ({ value: { note: 'call +1 214 555 0147' } }) }, now: () => T0 })
  assert.equal(leaky.refused, 'CONTACT_VALUE_IN_OUTPUT')
  assert.equal(containsContactValue({ id: '00000000-0000-4000-8000-000000000123', at: at(T0) }), false)
  assert.equal(containsContactValue({ e: 'owner@example.com' }), true)
})

test('drift: agent.ops_research_valuation_snapshot embeds EXACTLY research-valuation-sql.js; the text reads public relations only and writes nothing', () => {
  const sql = fs.readFileSync(new URL('../../../../supabase/migrations/PROPOSED_20261016162000_ops_research_valuation_snapshot.sql', import.meta.url), 'utf8')
  const m = /\/\*sql:research_valuation_snapshot\*\/([\s\S]*?)\/\*end\*\//.exec(sql)
  assert.ok(m)
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  assert.equal(norm(m[1]), norm(RESEARCH_VALUATION_SNAPSHOT_SQL))
  assert.doesNotMatch(RESEARCH_VALUATION_SNAPSHOT_SQL, /\b(insert\s+into|update\s+public\.|delete\s+from|truncate|alter\s+table|create\s+table)\b/i)
  assert.doesNotMatch(RESEARCH_VALUATION_SNAPSHOT_SQL, /\bagent\./, 'runs unchanged where the agent schema is absent (live read-only proof)')
  assert.doesNotMatch(RESEARCH_VALUATION_SNAPSHOT_SQL, /phone|message_body|owner_name|address/i)
})
