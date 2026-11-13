#!/usr/bin/env node
// 8.5.21-b LIVE READ-ONLY PROOF. Production is read ONLY inside BEGIN READ ONLY (bounded
// statement_timeout), over the pooler, SELECT only; nothing is written to any database. Outputs
// are local files: counts, record ids (uuids) and encoded property refs — never a phone, a name,
// an address or message text.
//
//   PROOF_RO_DATABASE_URL=… node --import ./tests/register-aliases.mjs scripts/proof/rc821b-live-proof.mjs --phase <p> --out <dir>
//   phases:
//     valuation   the valuation refresh queue over the current pipeline (+ recovery linkage) and a
//                 DRY RUN of the existing engine entry point for every queued property → coverage gain
//     research    property.research end to end on N properties (memory runtime, real 25 s ticks,
//                 internal-first; web optional on ONE property when ANTHROPIC_API_KEY is in the env)
//     plan        the PROPOSED dead-deal correction plan (dry run) + misclassified counteroffers +
//                 failed automated replies
//     supervisor  supervisor checks + the daily brief from real reads (agent-schema sources unavailable)
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { createPgReadSupabase } from './lib/pg-read-supabase.mjs'
import * as ops from '../../src/lib/agent/operations/index.js'
import { buildDigest } from '../../src/lib/agent/missions/review-digest-handler.js'
import { buildValuationQueue, classifyValuationCandidate } from '../../src/lib/domain/valuation-refresh/valuation-queue.js'
import { createValuationSqlSource } from '../../src/lib/domain/valuation-refresh/valuation-source.js'
import { runValuationRefresh } from '../../src/lib/domain/valuation-refresh/dry-run.js'
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'
import { ownershipEvidenceFromThread, nurtureIntentFor } from '../../src/lib/agent/operations/ownership-evidence.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const PHASE = arg('--phase', 'valuation')
const OUT = arg('--out', '.')
const URL_ = process.env.PROOF_RO_DATABASE_URL
if (!URL_) { console.error('PROOF_RO_DATABASE_URL required'); process.exit(2) }
const stats = { queries: 0, rows: 0, max_ms: 0, refused: 0, transactions: 0 }
const WRITE_RE = /\b(insert\s+into|update\s+\w|delete\s+from|truncate|alter\s+table|drop\s|create\s|grant\s|revoke\s|merge\s|copy\s|vacuum|refresh\s)/i
// PostgREST-shaped values: numerics as numbers, timestamps / dates as ISO text (what supabase-js returns)
const types = { getTypeParser: (oid, format) => ([1700, 20, 700, 701].includes(oid) ? (v) => (v == null ? null : Number(v)) : [1114, 1184].includes(oid) ? (v) => (v == null ? null : new Date(v.includes('T') || /[+-]\d\d(:?\d\d)?$/.test(v) ? v : `${v}Z`).toISOString()) : oid === 1082 ? (v) => v : pg.types.getTypeParser(oid, format)) }

async function withRo(fn, { timeoutMs = 60_000 } = {}) {
  const c = new pg.Client({ connectionString: URL_, ssl: { rejectUnauthorized: false }, types })
  await c.connect()
  try {
    await c.query('BEGIN READ ONLY')
    await c.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`)
    if ((await c.query('show transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('not read only')
    stats.transactions += 1
    const query = async (sql, params = []) => {
      if (WRITE_RE.test(String(sql).replace(/'[^']*'/g, '').replace(/--[^\n]*/g, ''))) { stats.refused += 1; throw new Error('read-only proof: select only') }
      const t = Date.now()
      const r = await c.query(sql, params)
      stats.queries += 1; stats.rows += r.rows.length; stats.max_ms = Math.max(stats.max_ms, Date.now() - t)
      return r.rows
    }
    return await fn({ query, client: c })
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1))
const now = Date.now()
const nowIso = new Date(now).toISOString()

async function allConversationFacts() {
  return withRo(async ({ query }) => {
    const source = ops.createOperationsSqlSource({ query })
    const out = []
    let cur = { after_at: null, after_id: null }
    for (;;) {
      const rows = await source.conversationFacts({ ...cur, limit: 500 })
      out.push(...rows)
      if (rows.length < 500) break
      const last = rows[rows.length - 1]
      cur = { after_at: last.cursor_at, after_id: last.conversation_id }
    }
    return out.map(ops.normalizeConversationFacts)
  }, { timeoutMs: 60_000 })
}

// ── valuation ───────────────────────────────────────────────────────────────
async function phaseValuation() {
  const facts = await allConversationFacts()
  const cands = facts.map((f) => ({ ...ops.classifyRecoveryCandidate(f, { now, approved_programs: [] }), property_id: f.property_id }))
  const links = ops.recoveryLinkRequests(cands)
  const rows = await withRo(({ query }) => createValuationSqlSource({ query }).candidates({ limit: 2000 }))
  const live = rows.length
  // the bounded queue the job takes (≤ 200 entries; ≤ 50 per run) — the proof dry-runs EVERY needing property
  const queue = buildValuationQueue([...rows, ...links.valuation], { now, limit: 200 })
  const full = queue
  const needing = []
  const seen = new Set()
  for (const r of [...rows, ...links.valuation]) {
    const c = classifyValuationCandidate(r, { now })
    if (c.queued && !seen.has(String(r.property_id))) { seen.add(String(r.property_id)); needing.push({ property_id: String(r.property_id), class: c.class, rank: c.rank, need: c.need }) }
  }
  needing.sort((a, b) => a.rank - b.rank)
  const max = Number(arg('--max', needing.length))
  const results = []
  const t0 = Date.now()
  for (let i = 0; i < Math.min(max, needing.length); i += 15) {
    const batch = needing.slice(i, Math.min(i + 15, max))
    const part = await withRo(async ({ client }) => {
      const sb = createPgReadSupabase({ client })
      const out = []
      for (const e of batch) {
        const t = Date.now()
        const r = await runValuationRefresh({ property_id: e.property_id, client: sb, now: new Date(now), engineDeps: { v3Enabled: true } }).catch((err) => ({ ok: false, error: String(err?.code || err?.message || 'ENGINE_ERROR').slice(0, 120), before: { present: false }, after: { present: false } }))
        out.push({ ref: encodePropertyRef(e.property_id), class: e.class, need: e.need, ms: Date.now() - t, ok: r.ok, status: r.status || null, ran: r.ran ?? null, error: r.error || null, reads_refused: r.reads?.refused ?? null, writes: r.writes ?? 0,
          before: { present: r.before?.present, tier: r.before?.decision_tier ?? null, offer_ready: r.before?.offer_ready ?? false },
          after: { present: r.after?.present, tier: r.after?.decision_tier ?? null, offer_ready: r.after?.offer_ready ?? false, reason: r.after?.offer_ready_reason ?? null, comp_count: r.after?.comp_count ?? null, valuation_confidence: r.after?.valuation_confidence ?? null }, owner_question: r.after?.owner_question || null })
      }
      return out
    }, { timeoutMs: 60_000 })
    results.push(...part)
    process.stdout.write(`valuation ${results.length}/${Math.min(max, needing.length)}\n`)
  }
  // live-pipeline coverage: every live opportunity's current engine row (projection only)
  const liveCoverage = await withRo(({ query }) => query(`select count(*)::int live, count(s.property_id)::int with_row,
      count(*) filter (where s.decision_tier in ('AUTO_HARD_OFFER','AUTO_RANGE_OFFER') and s.computed_at > now() - interval '30 days' and s.computed_at >= '2026-09-12')::int offer_ready_tier_current
    from public.acquisition_opportunities o
    left join lateral (select property_id, decision_tier, computed_at from public.property_acquisition_scores x where x.property_id = o.primary_property_id order by computed_at desc nulls last limit 1) s on true
    where o.opportunity_status in ('active','nurture') and o.primary_property_id is not null`))
  const count = (f) => results.filter(f).length
  const byTierAfter = {}
  for (const r of results) byTierAfter[r.after.tier || 'none'] = (byTierAfter[r.after.tier || 'none'] || 0) + 1
  const byReason = {}
  for (const r of results.filter((x) => x.after.present && !x.after.offer_ready)) byReason[r.after.reason || 'unknown'] = (byReason[r.after.reason || 'unknown'] || 0) + 1
  const errors = {}
  for (const r of results.filter((x) => !x.ok)) errors[r.error || 'unknown'] = (errors[r.error || 'unknown'] || 0) + 1
  const summary = {
    at: nowIso, mode: 'dry_run', read_only: true, production_writes: 0, engine: 'ensurePropertyAcquisitionDecision → scoreProperty (v3Enabled: true, as in production rows)',
    live_pipeline: liveCoverage[0], live_candidate_rows: live, recovery_linkage_valuation_requests: links.valuation.length,
    queue: { considered: queue.considered, needing: queue.needing, by_class_all_needing: full.by_class, excluded: queue.excluded, first_run_bounded_to: queue.entries.length },
    dry_run: { properties: results.length, ok: count((r) => r.ok), failed: count((r) => !r.ok), ran: count((r) => r.ran), reused_current: count((r) => r.ok && r.ran === false), writes: results.reduce((a, r) => a + Number(r.writes || 0), 0), reads_refused_writes: results.reduce((a, r) => a + Number(r.reads_refused || 0), 0), minutes: Math.round((Date.now() - t0) / 600) / 100, median_ms: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] || null },
    coverage: {
      before_valued: count((r) => r.before.present), after_valued: count((r) => r.after.present), gained_valuation: count((r) => r.after.present && !r.before.present),
      before_offer_ready: count((r) => r.before.offer_ready), after_offer_ready: count((r) => r.after.offer_ready), gained_offer_ready: count((r) => r.after.offer_ready && !r.before.offer_ready),
      after_by_tier: byTierAfter, after_not_offer_ready_by_reason: byReason, by_class: Object.fromEntries(['active_negotiation', 'offer_request', 'motivated_plausible_ask', 'recoverable_conversation', 'investigate_missing_financials'].map((k) => [k, { n: count((r) => r.class === k), gained_offer_ready: count((r) => r.class === k && r.after.offer_ready && !r.before.offer_ready) }])),
      owner_question_sfr_repairs_rows: count((r) => r.owner_question),
    },
    errors,
    prod: stats,
  }
  write('valuation-dry-run.json', { summary, results })
  console.log(JSON.stringify(summary, null, 1))
}

// ── plan ────────────────────────────────────────────────────────────────────
async function phasePlan() {
  const facts0 = await allConversationFacts()
  // 8.5.21-b owner fix: canonical-ledger ownership evidence for the closed-after-not-interested candidates
  // (bodies read in-process only, never written out; bounded to those candidates)
  const first = ops.buildNotInterestedCorrectionPlan(facts0, { now })
  const candIds = first.entries.map((e) => e.conversation_id)
  const evidence = {}
  for (let i = 0; i < candIds.length; i += 100) {
    const part = await withRo(({ query }) => query(`select t.id::text conversation_id, coalesce(jsonb_agg(jsonb_build_object('id', m.id::text, 'direction', m.direction, 'message_body', m.message_body, 'created_at', m.created_at, 'detected_intent', m.detected_intent) order by m.created_at) filter (where m.id is not null), '[]') msgs
      from public.inbox_thread_state t left join lateral (select id, direction, message_body, created_at, detected_intent from public.message_events me where me.thread_key = t.thread_key order by created_at desc limit 60) m on true
      where t.id = any($1::uuid[]) group by t.id`, [candIds.slice(i, i + 100)]))
    for (const r of part) evidence[r.conversation_id] = ownershipEvidenceFromThread(r.msgs, { now: nowIso })
  }
  const facts = facts0.map((f) => (evidence[f.conversation_id]?.ownership ? { ...f, ownership_evidence: evidence[f.conversation_id].ownership } : f))
  const evidenceCounts = {}
  for (const id of candIds) { const k = `ownership:${evidence[id]?.ownership ?? 'none'}|interest:${evidence[id]?.interest ?? 'none'}`; evidenceCounts[k] = (evidenceCounts[k] || 0) + 1 }
  const plan = ops.buildNotInterestedCorrectionPlan(facts, { now })
  const sql = ops.renderCorrectionSql(plan, { tag: nowIso.slice(0, 10).replace(/-/g, '') })
  const cands = facts.map((f) => ops.classifyRecoveryCandidate(f, { now, approved_programs: [] }))
  const nurture = { intents: 0, by_reason: {} }
  facts.forEach((f, i) => { const ni = nurtureIntentFor(f, cands[i], { now }); if (ni.intent) nurture.intents += 1; else if (ni.reason !== 'not_disinterest') nurture.by_reason[ni.reason] = (nurture.by_reason[ni.reason] || 0) + 1 })
  const failed = cands.filter((c) => c.detections.some((d) => d.code === 'failed_automated_response'))
  const failedSplit = { total: failed.length, provider_accepted: failed.filter((c) => c.detections.some((d) => d.code === 'failed_automated_response' && d.provider_accepted)).length, internal_only: failed.filter((c) => c.detections.some((d) => d.code === 'failed_automated_response' && d.internal_only)).length }
  // misclassified counteroffers: inbound bodies are read here and NEVER written out (ids + counts only)
  // threads whose FINAL classification would lose a counteroffer (the thread's last intent, or its disposition)
  const losing = facts.filter((f) => ops.COUNTER_LOSING_INTENTS.includes(f.thread.last_intent || '') || ['former_owner', 'unclear'].includes(f.thread.disposition || ''))
  const ids = losing.map((f) => f.conversation_id)
  const mis = []
  for (let i = 0; i < ids.length; i += 200) {
    const part = await withRo(({ query }) => query(`select t.id::text as conversation_id, t.last_intent, t.disposition,
        coalesce(jsonb_agg(jsonb_build_object('id', m.id::text, 'direction', m.direction, 'body', m.message_body, 'intent', m.detected_intent) order by m.created_at) filter (where m.id is not null), '[]'::jsonb) msgs
      from public.inbox_thread_state t
      left join lateral (select id, direction, message_body, detected_intent, created_at from public.message_events me where me.thread_key = t.thread_key and me.direction = 'inbound' order by created_at desc limit 20) m on true
      where t.id = any($1::uuid[]) group by t.id, t.last_intent, t.disposition`, [ids.slice(i, i + 200)]))
    for (const r of part) {
      const d = ops.detectMisclassifiedCounteroffer({ messages: r.msgs, final_intent: r.last_intent, disposition: r.disposition })
      if (d.misclassified) mis.push({ conversation_id: r.conversation_id, final_intent: d.final_intent, priced_messages: d.priced_messages, not_classified_as_price: d.priced_messages_not_classified_as_price, message_ids: d.message_ids })
    }
  }
  const byFinal = {}
  for (const m of mis) byFinal[m.final_intent || 'null'] = (byFinal[m.final_intent || 'null'] || 0) + 1
  const out = { at: nowIso, read_only: true, applied: false, conversations: facts.length, correction_plan: { before_ownership_fix: first.count, ownership_evidence: evidenceCounts, status: plan.status, scope: plan.scope, count: plan.count, by_before_status: plan.by_before_status, stage_changes: plan.stage_changes, due_now: plan.due_now, skipped: plan.skipped }, misclassified_counteroffers: { candidates_scanned: ids.length, flagged: mis.length, by_final_intent: byFinal, examples: mis.slice(0, 10) }, failed_automated_replies: failedSplit, nurture_intents_recent_only: nurture, prod: stats }
  write('dead-deal-correction-plan.json', { ...plan, entries: plan.entries })
  write('dead-deal-correction-APPLY.PROPOSED.sql', sql.apply_sql)
  write('dead-deal-correction-ROLLBACK.PROPOSED.sql', sql.rollback_sql)
  write('plan-proof.json', { ...out, misclassified_counteroffers: { ...out.misclassified_counteroffers, all: mis } })
  console.log(JSON.stringify(out, null, 1))
}

// ── supervisor + brief ──────────────────────────────────────────────────────
async function phaseSupervisor() {
  const facts = await allConversationFacts()
  const r = await withRo(async ({ query }) => {
    const source = ops.createOperationsSqlSource({ query })
    const snapshot = await source.supervisorSnapshot({ now: nowIso })
    const researchValuation = await source.researchValuationSnapshot({ now: nowIso })
    const hk = await query(`select coalesce(jsonb_object_agg(key, left(value, 64)), '{}'::jsonb) keys from public.system_control where key = any($1::text[])`, [['queue_processor_heartbeat_at', 'campaign_feeder_heartbeat_at', 'followup_no_response_heartbeat_at', 'seller_state_reconcile_heartbeat_at', 'webhook_delivery_recovery_last_at', 'queue_processor_mode', 'queue_execution_mode']])
    const lastDel = await query(`select max(delivered_at) d from public.send_queue where delivered_at is not null and delivered_at > now() - interval '7 days'`, [])
    const since = new Date(now - 86_400_000).toISOString()
    const briefFacts = await source.briefFacts({ since, until: nowIso })
    return { snapshot, researchValuation, health: { at: nowIso, keys: hk[0].keys, deliveries: { last_delivered_at: lastDel[0].d || null }, queue: {} }, briefFacts, since }
  })
  const classes = facts.map((f) => ops.classifyRecoveryCandidate(f, { now, approved_programs: [] }))
  const byClass = Object.fromEntries(ops.RECOVERY_CLASSES.map((c) => [c, 0]))
  for (const c of classes) byClass[c.class] += 1
  const states = facts.map((f) => ops.deriveActionState(f, { now, approvals: [], work: [] }))
  const ac = ops.summarizeActionStates(states)
  const lost = states.filter(ops.isLostConversation)
  let valuationBatch = { unavailable: 'VALUATION_REFRESH_NOT_RUN' }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(OUT, 'valuation-dry-run.json'), 'utf8')).summary
    valuationBatch = { at: v.at, mode: 'dry_run', queued: v.dry_run.properties, gained_offer_ready: v.coverage.gained_offer_ready, gained_valuation: v.coverage.gained_valuation }
  } catch { /* the valuation phase has not run */ }
  const UN = 'AGENT_RUNTIME_NOT_APPLIED_IN_PRODUCTION'
  const supervisor = ops.evaluateSupervisor({ snapshot: r.snapshot, health: r.health, actionCenter: { ...ac, computed_at: nowIso }, recovery: { by_class: byClass, at: nowIso, scanned: classes.length }, runtime: { unavailable: UN }, spend: { unavailable: UN }, approvals: { unavailable: UN }, researchValuation: r.researchValuation, valuationBatch, now })
  const digest = buildDigest({ activity: { jobs: [], findings: [] }, approvals: [], shadow: { available: false, code: 'SOURCE_NOT_APPLIED' }, since: r.since, at: nowIso })
  const rec24 = classes.filter((c) => ['research_worthy', 'eligible_for_approved_followup', 'needs_human_review'].includes(c.class)).map((c) => ({ conversation_id: c.conversation_id, class: c.class, priority: ops.recoveryPriority(c) }))
  const brief = ops.buildOperatingBrief({ digest, jobs: { unavailable: UN }, approvals: { unavailable: UN }, facts: r.briefFacts, recovery: { candidates: rec24, scanned: classes.length }, workItems: { unavailable: UN }, actionCenter: { ...ac, computed_at: nowIso, lost_ids: lost.slice(0, 10).map((s) => s.conversation_id) }, supervisor: { counts: supervisor.counts }, researchValuation: r.researchValuation, valuationBatch: valuationBatch.unavailable ? valuationBatch : { ...valuationBatch, job_id: null } })
  const tool = await ops.opsIntelTool.run({}, { store: { latestFinding: async ({ finding_type }) => (finding_type === 'supervisor.summary' ? { retrieved_at: nowIso, value: { counts: supervisor.counts, all_clear: supervisor.all_clear, statuses: Object.fromEntries(supervisor.checks.map((c) => [c.id, c.status])) } } : finding_type === 'valuation.refresh_batch' && !valuationBatch.unavailable ? { retrieved_at: valuationBatch.at, value: valuationBatch } : null) }, source: { researchValuationSnapshot: async () => r.researchValuation }, now: () => now })
  write('brief.md', ops.renderBriefMarkdown(brief, { title: 'LeadCommand daily operating brief — live read-only proof (8.5.21-b)' }))
  const out = { at: nowIso, read_only: true, supervisor: { counts: supervisor.counts, all_clear: supervisor.all_clear, statuses: Object.fromEntries(supervisor.checks.map((c) => [c.id, c.status])), new_checks: supervisor.checks.filter((c) => ['research_status', 'valuation_coverage', 'overdue_offers', 'negotiation_authority', 'missing_valuations', 'hot_opportunities', 'unhandled_inbounds'].includes(c.id)) }, research_valuation_snapshot: r.researchValuation, brief_sections: brief.sections.map((s) => ({ id: s.id, available: s.available, code: s.code || null, lines: s.lines.length })), ops_intel_tool: { refused: tool.refused || null, sections: Object.fromEntries(Object.entries(tool.sections).map(([k, v]) => [k, v.available])) }, prod: stats }
  write('supervisor-proof.json', { ...out, checks: supervisor.checks, issues: supervisor.issues, tool })
  console.log(JSON.stringify(out, null, 1))
}

if (PHASE === 'valuation') await phaseValuation()
else if (PHASE === 'plan') await phasePlan()
else if (PHASE === 'supervisor') await phaseSupervisor()
else if (PHASE === 'research') await (await import('./rc821b-research-proof.mjs')).run({ withRo, write, now, arg, stats })
else { console.error(`unknown phase ${PHASE}`); process.exit(2) }
