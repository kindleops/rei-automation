// 8.5.20 part C — the daily operating brief (linkage, unavailable ≠ 0, the review_digest
// extension) and the drift guards: migration bodies = operations-sql.js, schedule seed =
// OPERATIONS_SCHEDULE_DEFINITIONS (all born disabled), handler wiring gates.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildOperatingBrief, renderBriefMarkdown, BRIEF_SECTIONS } from '../../src/lib/agent/operations/operating-brief.js'
import { buildDigest, createReviewDigestHandler } from '../../src/lib/agent/missions/review-digest-handler.js'
import { OPERATIONS_SQL, normalizeSql } from '../../src/lib/agent/operations/operations-sql.js'
import { OPERATIONS_SCHEDULE_DEFINITIONS, OPERATIONS_KINDS, operationsEnabled } from '../../src/lib/agent/operations/operations-kinds.js'
import { buildOperationsHandlers } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads, REVIEW_DIGEST_KIND } from '../../src/lib/agent/missions/index.js'
import { briefFacts, uuid, T0, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const digest = () => buildDigest({ activity: { jobs: [{ job_id: 'job_a', kind: 'mission.research', state: 'completed', cost_usd: 0.12 }], findings: [{ finding_type: 'discovery.candidate', n: 3 }] }, approvals: [], shadow: null, since: at(T0 - D), at: at(T0) })
const SECTION_IDS = BRIEF_SECTIONS.map(([id]) => id)

test('brief: the ten sections, in order', () => {
  assert.deepEqual(SECTION_IDS, ['work_completed', 'new_viable_opportunities', 'offers_prepared', 'negotiations_advanced', 'deals_awaiting_approval', 'followups_completed', 'recovered_opportunities', 'campaign_sender_changes', 'system_incidents', 'recommended_next_actions'])
})

test('brief: every line links to its source records (ids only)', () => {
  const conv = uuid()
  const wi = uuid()
  const b = buildOperatingBrief({
    digest: digest(), jobs: [{ job_id: 'job_a', kind: 'mission.research', state: 'completed' }],
    approvals: [{ approval_id: 'apr_1', capability_id: 'pipeline.propose_stage_change', created_at: at(T0 - 3600_000) }],
    facts: briefFacts(), recovery: { candidates: [{ conversation_id: conv, class: 'research_worthy', priority: 50 }, { conversation_id: uuid(), class: 'needs_human_review', priority: 70 }], scanned: 2 },
    workItems: { resolved: [{ work_item_id: uuid(), kind: 'recovery_review', resolved_by: OP }, { work_item_id: uuid(), kind: 'recovery_review', resolved_by: 'auto:condition_cleared' }], open: [{ work_item_id: wi, kind: 'escalation', escalated: true, title: 'HOT opportunity without a next action' }] },
    actionCenter: { counts: { needs_attention: 4 }, lost: 2, lost_ids: [conv], total: 30 }, supervisor: { counts: { critical: 1, warn: 2, unavailable: 0 }, job_id: 'job_s' },
  })
  assert.deepEqual(b.sections.map((s) => s.id), SECTION_IDS)
  for (const s of b.sections) {
    assert.equal(s.available, true, s.id)
    for (const l of s.lines) for (const k of l.links) assert.ok(k.source && (k.record_id || k.job_id || k.approval_id || k.work_item_id || k.opportunity_id || k.campaign_id || k.sender_id), `${s.id}: ${JSON.stringify(k)}`)
  }
  const sec = (id) => b.sections.find((s) => s.id === id)
  assert.deepEqual(sec('offers_prepared').lines[0].links.map((l) => l.source), ['public.seller_offers'])
  assert.equal(sec('recovered_opportunities').lines[0].value, 1, 'an AUTOMATIC resolution is not a recovered opportunity')
  assert.equal(sec('new_viable_opportunities').lines[0].links[0].record_id, conv)
  assert.ok(sec('recommended_next_actions').lines.some((l) => l.label.includes('lost conversation') && l.links[0].record_id === conv))
  assert.ok(sec('system_incidents').lines.some((l) => l.links.some((k) => k.work_item_id === wi)))
  assert.doesNotMatch(JSON.stringify(b), /\+1\d{10}|\(\d{3}\)\s?\d{3}-\d{4}/)
  const md = renderBriefMarkdown(b)
  assert.match(md, /## Offers prepared/)
  assert.match(md, /public\.seller_offers:/)
})

test('brief: missing data is "unavailable", never 0', () => {
  const b = buildOperatingBrief({ digest: digest(), approvals: { unavailable: 'APPROVALS_UNAVAILABLE' }, facts: { unavailable: 'SOURCE_NOT_APPLIED' }, recovery: { unavailable: 'RECOVERY_NOT_RUN' }, workItems: { unavailable: 'OPERATIONS_NOT_APPLIED' }, actionCenter: { unavailable: 'ACTION_CENTER_NOT_RUN' }, supervisor: { unavailable: 'SUPERVISOR_NOT_RUN' } })
  const by = Object.fromEntries(b.sections.map((s) => [s.id, s]))
  for (const id of ['new_viable_opportunities', 'offers_prepared', 'negotiations_advanced', 'deals_awaiting_approval', 'followups_completed', 'recovered_opportunities', 'campaign_sender_changes', 'system_incidents', 'recommended_next_actions']) {
    assert.equal(by[id].available, false, id)
    assert.ok(by[id].code, id)
    assert.deepEqual(by[id].lines, [], `${id} carries no number`)
  }
  assert.equal(by.work_completed.available, true, 'the runtime digest itself was read')
  // an unread runtime is not "0 jobs completed"
  const noRuntime = buildOperatingBrief({ digest: digest(), jobs: { unavailable: 'AGENT_SCHEMA_NOT_APPLIED' }, facts: briefFacts() })
  const wc = noRuntime.sections.find((x) => x.id === 'work_completed')
  assert.deepEqual([wc.available, wc.code, wc.lines], [false, 'AGENT_SCHEMA_NOT_APPLIED', []])
  const disc = noRuntime.sections.find((x) => x.id === 'new_viable_opportunities')
  assert.equal(disc.available, false, 'recovery not run either')
  const md = renderBriefMarkdown(b)
  assert.match(md, /## Offers prepared\n_unavailable_ \(SOURCE_NOT_APPLIED\)/)
  assert.doesNotMatch(md.split('## Offers prepared')[1].split('##')[0], /\*\*0\*\*/)
  // a real 0 (the table was read and had no rows) stays 0
  const zero = buildOperatingBrief({ digest: digest(), facts: briefFacts({ offers_prepared: { count: 0, record_ids: [], sent: 0 } }) })
  assert.equal(zero.sections.find((s) => s.id === 'offers_prepared').lines[0].value, 0)
})

test('conversation.review_digest carries the brief: with the operations read model, and — without it — every operations section unavailable', async () => {
  for (const withOps of [true, false]) {
    let t = T0
    const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [REVIEW_DIGEST_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
    const reads = createMissionMemoryReads(runtime, { now: () => t })
    const operations = withOps ? { source: createOperationsMemorySource({ brief: briefFacts() }), store: createOperationsMemoryStore({ runtime, now: () => t }) } : null
    const handler = createReviewDigestHandler({ reads, operations, now: () => t })
    await runtime.enqueue({ kind: REVIEW_DIGEST_KIND, idempotency_key: 'c'.repeat(64), input: { window_hours: 24 }, requested_by: OP })
    await runRuntimeTick({ store: runtime, handlers: { [REVIEW_DIGEST_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t })
    const job = [...runtime._state.jobs.values()][0]
    assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
    const f = [...runtime._state.findings.values()].find((x) => x.finding_type === 'digest.morning')
    assert.ok(f.value.brief, 'the brief is in the durable finding')
    assert.equal(job.result.brief_sections.length, 10)
    const offers = f.value.brief.sections.find((s) => s.id === 'offers_prepared')
    if (withOps) {
      assert.equal(offers.available, true)
      assert.equal(offers.lines[0].value, 1)
      assert.equal(f.value.brief.sections.find((s) => s.id === 'recommended_next_actions').available, true)
    } else {
      assert.deepEqual([offers.available, offers.code], [false, 'OPERATIONS_SOURCE_NOT_CONFIGURED'])
    }
    assert.ok(Buffer.byteLength(JSON.stringify(job.checkpoint)) < 16_000, 'the brief is never checkpointed')
  }
})

// ── drift guards ────────────────────────────────────────────────────────────
const MIG = new URL('../../../../supabase/migrations/PROPOSED_20261016140000_operations_action_center.sql', import.meta.url)
const SEED = new URL('../../../../supabase/migrations/PROPOSED_20261016140100_operations_schedules.sql', import.meta.url)

test('drift: every agent.ops_* read function embeds EXACTLY the operations-sql.js text', () => {
  const sql = fs.readFileSync(MIG, 'utf8')
  for (const [k, text] of Object.entries(OPERATIONS_SQL)) {
    const m = new RegExp(`/\\*sql:${k}\\*/([\\s\\S]*?)/\\*end\\*/`).exec(sql)
    assert.ok(m, `${k} body present`)
    assert.equal(normalizeSql(m[1]), normalizeSql(text), `${k} drifted`)
  }
  // nothing in the migration writes public
  assert.doesNotMatch(sql.replace(/\/\*sql:[\s\S]*?\/\*end\*\//g, ''), /\b(insert into|update|delete from|alter table|drop table)\s+public\./i)
})

test('drift: the schedule seed mirrors OPERATIONS_SCHEDULE_DEFINITIONS, every schedule born disabled; handlers gated by AGENT_OPERATIONS_ENABLED', () => {
  const sql = fs.readFileSync(SEED, 'utf8')
  const calls = [...sql.matchAll(/runtime_upsert_schedule\('([a-z-]+)', '([a-z._]+)', (\d+), :'owner_id', '([^']+)'::jsonb, (false|true),/g)]
  assert.deepEqual(calls.map((m) => [m[1], m[2], Number(m[3]), m[5]]), OPERATIONS_SCHEDULE_DEFINITIONS.map((d) => [d.name, d.kind, d.interval_seconds, 'false']))
  for (const [i, m] of calls.entries()) assert.deepEqual(JSON.parse(m[4]), JSON.parse(JSON.stringify(OPERATIONS_SCHEDULE_DEFINITIONS[i].input)))
  assert.deepEqual(OPERATIONS_SCHEDULE_DEFINITIONS.find((d) => d.kind === 'recovery.sweep').input.approved_programs, [], 'no re-engagement scope by default')
  assert.deepEqual(OPERATIONS_KINDS, ['recovery.sweep', 'inbox.action_center', 'pipeline.reconcile', 'ops.supervisor'])
  assert.equal(operationsEnabled({}), false)
  assert.equal(operationsEnabled({ AGENT_OPERATIONS_ENABLED: '1' }), true)
  assert.deepEqual(buildOperationsHandlers({ source: null, store: null, reads: null }), {})
  const posttest = fs.readFileSync(new URL('../../../../supabase/migrations/PROPOSED_20261016140100_operations_schedules_posttest.sql', import.meta.url), 'utf8')
  for (const d of OPERATIONS_SCHEDULE_DEFINITIONS) assert.match(posttest, new RegExp(`runtime_upsert_schedule\\('${d.name}', '${d.kind.replace('.', '\\.')}', ${d.interval_seconds}, op,`))
})
