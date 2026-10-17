// rc-8.5.21 (owner P0 2026-10-16) — the FOLLOW-UP EXECUTION PIPELINE state machine, in memory.
// "A follow_up_at field alone is not a scheduled action": every eligible follow-up becomes a job
// (runtime event at its due time), every dispatch re-checks, exactly one send row is ever
// written, outcomes are verified, transport failures retry (bounded), ambiguous accepts never do,
// and the reconciliation reports dates with no job / jobs with no outcome / duplicates.
// The same machine on a disposable PostgreSQL 17: followup-execution-8521-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FOLLOWUP_CODES as C, FOLLOWUP_KINDS as K, FOLLOWUP_DISPATCH_KIND, FOLLOWUP_EXECUTION_MODE_KEY, FOLLOWUP_MAX_ATTEMPTS, FOLLOWUP_LEDGER_SCOPE,
  classifyFollowUpOutcome, decodeDispatchInput, encodeDispatchInput, followUpIntentOf, followUpJobKey, planFollowUpSweep, reconcileFollowUps,
  resolveFollowUpExecutionMode, runFollowUpDispatch, runFollowUpReconcile, runFollowUpSweep, followUpExecutionRequested,
} from '../../src/lib/domain/followups/followup-execution.js'
import { evaluateSendTimeContactGuard } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { followupRuntimeHandlers, buildFollowUpHandlers } from '../../src/lib/ai/followup-runtime-wiring.js'

// fictional 555-01xx numbers only
const PHONE = '+13125550111'
const OURS = '+13125550199'
const SID = '0b5d7a52-3f0e-4b8e-9a51-6f1f6c2a0001'
const NOW = '2026-10-16T17:00:00.000Z' // 12:00 America/Chicago
const DUE = '2026-10-16T16:00:00.000Z'
const NO_HOLD = async () => ({ held: false, hold_type: null, reason: null, hold_id: null })

function world(over = {}) {
  const state = { id: SID, thread_key: PHONE, canonical_e164: PHONE, property_id: 'p1', master_owner_id: 'm1', prospect_id: 'pr1', follow_up_at: DUE, disposition: 'not_interested', stage: 'offer_interest', lifecycle_stage: 'offer_interest', is_suppressed: false, last_inbound_at: '2026-09-16T15:00:00.000Z', updated_at: '2026-09-16T15:00:01.000Z', our_number: OURS, ...over.state }
  const w = {
    state,
    switches: { [FOLLOWUP_EXECUTION_MODE_KEY]: 'live', queue_processor_mode: 'live', followup_automation_mode: 'full_live', ...over.switches },
    queue: [...(over.queue || [])], // send_queue rows
    ledger: new Map(), // scope:key → { status, started_at }
    jobs: [], // runtime enqueues
    guardFacts: over.guardFacts || {},
    language: over.language === undefined ? 'English' : over.language,
    templates: over.templates === undefined ? true : over.templates,
    senderStatus: over.senderStatus === undefined ? 'active' : over.senderStatus,
    writes: 0,
    crashAfterClaim: false,
    crashAfterWrite: false,
    clock: Date.parse(over.now || NOW),
  }
  return w
}

/** In-memory deps with the real semantics: the ledger's lease / reclaim rules, the writer's deterministic queue_key. */
function deps(w, { hold = NO_HOLD } = {}) {
  return {
    now: () => new Date(w.clock).toISOString(),
    readSwitch: async (k) => w.switches[k] ?? null,
    automationHoldChecker: hold,
    enqueueAt: async (o) => {
      if (w.jobs.some((j) => j.kind === o.kind && j.event_key === o.event_key)) return { ok: true, deduped: true }
      w.jobs.push(o); return { ok: true, deduped: false }
    },
    loadDueIntents: async ({ until }) => (w.state && w.state.follow_up_at && Date.parse(w.state.follow_up_at) <= Date.parse(until) ? [structuredClone(w.state)] : []),
    loadIntent: async (id) => (w.state && w.state.id === id ? structuredClone(w.state) : null),
    loadThreadFollowUpRows: async (keys) => new Map(keys.map((k) => [k, w.queue.filter((r) => r.thread_key === k).map((r) => structuredClone(r))])),
    languageFor: async () => w.language,
    templatesAvailable: async () => w.templates,
    senderStatus: async () => w.senderStatus,
    guard: async (row) => evaluateSendTimeContactGuard(row, w.guardFacts),
    reservations: {
      async begin({ scope, key, lease_ms }) {
        const k = `${scope}:${key}`; const r = w.ledger.get(k)
        if (!r) { w.ledger.set(k, { status: 'processing', started_at: w.clock }); return { ok: true, duplicate: false, reason: 'event_claimed' } }
        if (r.status === 'completed') return { ok: true, duplicate: true, reason: 'duplicate_event_ignored' }
        if (r.status === 'processing' && w.clock - r.started_at <= lease_ms) return { ok: true, duplicate: true, reason: 'event_already_processing' }
        Object.assign(r, { status: 'processing', started_at: w.clock }); return { ok: true, duplicate: false, reason: 'stale_or_failed_event_reclaimed' }
      },
      async complete({ scope, key, metadata }) { w.ledger.get(`${scope}:${key}`).status = 'completed'; w.ledger.get(`${scope}:${key}`).metadata = metadata; return { ok: true } },
      async release({ scope, key }) { w.ledger.get(`${scope}:${key}`).status = 'failed'; return { ok: true } },
    },
    writeFollowUp: async (intent, threadKey, ctx) => {
      if (w.crashAfterClaim) { w.crashAfterClaim = false; throw Object.assign(new Error('process killed before the write'), { simulatedCrash: true }) }
      const queue_key = `followup:${ctx.followup_dedupe_scope}`
      const existing = w.queue.find((r) => r.queue_key === queue_key)
      if (existing) return { ok: false, skipped: true, reason: 'duplicate_followup_exists', queue_row_id: existing.id }
      w.writes += 1
      const row = { id: `q${w.queue.length + 1}`, queue_key, thread_key: threadKey, queue_status: 'scheduled', type: 'followup', message_type: 'followup', scheduled_for: ctx.scheduled_for_at, scheduled_for_utc: ctx.scheduled_for_at, use_case_template: intent === 'stage_no_reply' ? ctx.followup_use_case : `nurture_${intent}`, created_at: new Date(w.clock).toISOString(), metadata: { deferred_message_resolution: true, intent, followup_job_key: ctx.followup_job_key, followup_kind: ctx.followup_kind, followup_attempt: ctx.followup_attempt, source: ctx.source, language: ctx.language } }
      w.queue.push(row)
      if (w.crashAfterWrite) { w.crashAfterWrite = false; throw Object.assign(new Error('process killed after the write'), { simulatedCrash: true }) }
      return { ok: true, followup_created: true, queue_row_id: row.id, scheduled_for: ctx.scheduled_for_at }
    },
  }
}
const job = (w, over = {}) => ({ state_id: w.state.id, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: w.state.follow_up_at, attempt: 1, ...over })

// ── born OFF ────────────────────────────────────────────────────────────────
test('born OFF: no mode key (or an invalid one) = off; no env flag = no handlers; off writes and enqueues nothing', async () => {
  assert.equal(resolveFollowUpExecutionMode(null), 'off')
  assert.equal(resolveFollowUpExecutionMode('LIVE!'), 'off')
  assert.equal(resolveFollowUpExecutionMode(' Live '), 'live')
  assert.equal(followUpExecutionRequested({}), false)
  assert.deepEqual(followupRuntimeHandlers({}), {})
  const w = world({ switches: { [FOLLOWUP_EXECUTION_MODE_KEY]: null } })
  const d = deps(w)
  assert.equal((await runFollowUpSweep(d)).code, C.OFF)
  assert.equal((await runFollowUpDispatch(job(w), d)).code, C.OFF)
  assert.equal((await runFollowUpReconcile(d)).code, C.OFF)
  assert.equal(w.jobs.length + w.writes, 0)
})

test('kinds: not-interested nurture, seller callback, stage silence; terminal / suppressed intents never become jobs', () => {
  const base = { follow_up_at: DUE }
  assert.equal(followUpIntentOf({ ...base, disposition: 'not_interested' }).kind, K.NOT_INTERESTED_NURTURE)
  assert.equal(followUpIntentOf({ ...base, disposition: 'not_ready' }).kind, K.SELLER_CALLBACK)
  const silence = followUpIntentOf({ ...base, disposition: null, lifecycle_stage: 'asking_price' })
  assert.deepEqual([silence.kind, silence.use_case], [K.STAGE_SILENCE, 'asking_price_follow_up'])
  for (const d of ['suppressed', 'opt_out', 'wrong_number', 'not_owner', 'property_specific_non_owner']) assert.equal(followUpIntentOf({ ...base, disposition: d }).kind, null, d)
  assert.equal(followUpIntentOf({ ...base, disposition: 'not_interested', is_suppressed: true }).skip, 'thread_suppressed')
  assert.equal(followUpIntentOf({ disposition: 'not_interested' }).skip, 'no_follow_up_at')
})

test('job input carries identifiers only (letter-encoded) and round-trips', () => {
  const input = encodeDispatchInput({ state_id: SID, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: DUE, attempt: 2 })
  assert.ok(!/\d{7,}/.test(JSON.stringify(input).replace(/"due_at":"[^"]+"/, '')), 'no digit runs (agent.payload_is_clean)')
  assert.deepEqual(decodeDispatchInput(input), { state_id: SID, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: DUE, attempt: 2 })
  assert.equal(decodeDispatchInput({ ...input, followup_kind: 'spam' }), null)
  assert.equal(decodeDispatchInput(encodeDispatchInput({ state_id: SID, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: DUE, attempt: FOLLOWUP_MAX_ATTEMPTS + 1 })), null)
})

// ── the sweep ───────────────────────────────────────────────────────────────
test('sweep: a due intent with no live row gets ONE dispatch job at its due time; a live row is adopted; beyond the horizon waits', async () => {
  const w = world()
  const d = deps(w)
  const r = await runFollowUpSweep(d)
  assert.equal(r.counts.enqueued, 1)
  assert.equal(w.jobs[0].kind, FOLLOWUP_DISPATCH_KIND)
  assert.equal(w.jobs[0].not_before, NOW, 'overdue ⇒ now')
  const again = await runFollowUpSweep(d)
  assert.equal(again.counts.deduped, 1, 'the same day re-sweep dedupes')
  assert.equal(w.jobs.length, 1)
  // adopted: a live nurture row written by the inbound path already executes it
  const w2 = world({ queue: [{ id: 'live1', thread_key: PHONE, queue_status: 'scheduled', type: 'followup', use_case_template: 'nurture_not_interested', metadata: {} }] })
  assert.equal((await runFollowUpSweep(deps(w2))).counts.adopted, 1)
  assert.equal(w2.jobs.length, 0)
  const plan = planFollowUpSweep({ intents: [{ ...w.state, follow_up_at: '2026-10-20T16:00:00.000Z' }], now: Date.parse(NOW) })
  assert.equal(plan[0].decision, 'not_yet')
})

test('sweep: a held thread gets no job (hold consulted at ENQUEUE); a registry error is a hold', async () => {
  for (const hold of [async () => ({ held: true, hold_type: 'operator_hold', reason: 'x', hold_id: 'h1' }), async () => { throw new Error('down') }]) {
    const w = world()
    const r = await runFollowUpSweep(deps(w, { hold }))
    assert.equal(r.counts.held, 1)
    assert.equal(w.jobs.length, 0)
  }
})

// ── the dispatch ────────────────────────────────────────────────────────────
test('dispatch: re-checks, then exactly ONE claimed write; a second dispatch is a DUPLICATE and writes nothing', async () => {
  const w = world()
  const d = deps(w)
  const r = await runFollowUpDispatch(job(w), d)
  assert.equal(r.code, C.ENQUEUED, JSON.stringify(r))
  assert.equal(w.writes, 1)
  const row = w.queue[0]
  assert.equal(row.metadata.followup_kind, K.NOT_INTERESTED_NURTURE)
  assert.equal(row.metadata.deferred_message_resolution, true, 'the body comes from an approved sms_templates row at send time')
  assert.equal(row.metadata.source, 'followup_execution_pipeline')
  assert.equal(row.scheduled_for, NOW, 'inside the recipient-local window ⇒ now')
  assert.equal((await runFollowUpDispatch(job(w), d)).code, C.DUPLICATE, 'the ledger key is completed')
  w.queue[0].queue_status = 'sent'; w.queue[0].sent_at = NOW
  assert.equal((await runFollowUpDispatch(job(w), d)).code, C.DUPLICATE)
  assert.equal(w.writes, 1)
})

test('crash after the claim, before the write: within the lease the retry yields; after it the claim is reclaimed and ONE row is written', async () => {
  const w = world()
  const d = deps(w)
  w.crashAfterClaim = true
  await assert.rejects(runFollowUpDispatch(job(w), d), /process killed/)
  // the release marks the claim failed ⇒ reclaimable at once; simulate a HARD crash (no release)
  w.ledger.forEach((r) => { r.status = 'processing'; r.started_at = w.clock })
  await assert.rejects(runFollowUpDispatch(job(w), d), (e) => e.code === 'FOLLOWUP_IN_PROGRESS' && e.retryable === true)
  w.clock += 6 * 60_000 // past the 5-minute lease
  const r = await runFollowUpDispatch(job(w), d)
  assert.equal(r.code, C.ENQUEUED)
  assert.equal(w.writes, 1)
  assert.equal(w.queue.length, 1)
})

test('crash after the write, before the ledger completes: the retry replays onto the SAME row (deterministic queue_key)', async () => {
  const w = world()
  const d = deps(w)
  w.crashAfterWrite = true
  await assert.rejects(runFollowUpDispatch(job(w), d), /process killed/)
  w.ledger.forEach((r) => { r.status = 'processing' })
  w.clock += 6 * 60_000
  const r = await runFollowUpDispatch(job(w), d)
  assert.equal(r.code, C.ADOPTED)
  assert.equal(w.queue.length, 1)
  assert.equal(w.writes, 1)
  assert.equal([...w.ledger.values()][0].status, 'completed')
})

test('concurrent duplicate dispatch jobs: one claim wins, one row', async () => {
  const w = world()
  const d = deps(w)
  const [a, b] = await Promise.allSettled([runFollowUpDispatch(job(w), d), runFollowUpDispatch(job(w), d)])
  const codes = [a, b].map((x) => (x.status === 'fulfilled' ? x.value.code : x.reason.code))
  assert.ok(codes.includes(C.ENQUEUED), codes.join(','))
  assert.equal(w.queue.length, 1)
})

test('suppression changes BEFORE dispatch: opt-out, suppression list, wrong number, ownership denial (store / text) — no row', async () => {
  const cases = {
    opt_out_list: { suppressions: [{ phone_e164: PHONE, is_active: true }] },
    automation_suppression: { automation_suppressions: [{ phone_e164: PHONE, status: 'active' }] },
    wrong_number: { phones: [{ canonical_e164: PHONE, phone_contact_status: 'wrong_number' }] },
    store_denial: { contact_property_resolution: [{ property_id: 'p1', contact_phone_e164: PHONE, contact_property_role: 'not_owner', suppression_scope: 'contact_property_pair', rejected_at: '2026-09-01T00:00:00Z' }] },
    // the 105-thread cohort shape: a bare "No" to the ownership question, stored as not_interested
    text_denial: { thread_messages: [
      { id: 'o1', direction: 'outbound', message_body: 'Hi Pat, this is Jake. Do you still own 1 Main St?', created_at: '2026-09-16T14:00:00Z', property_id: 'p1' },
      { id: 'i1', direction: 'inbound', message_body: 'No', created_at: '2026-09-16T15:00:00Z' },
    ] },
  }
  for (const [name, guardFacts] of Object.entries(cases)) {
    const w = world({ guardFacts })
    const r = await runFollowUpDispatch(job(w), deps(w))
    assert.equal(r.code, C.BLOCKED, `${name}: ${JSON.stringify(r)}`)
    assert.equal(w.writes, 0, name)
  }
  // thread suppressed / disposition moved to a terminal value after the job was enqueued
  const s = world(); s.state.is_suppressed = true
  assert.equal((await runFollowUpDispatch(job(s), deps(s))).code, C.SUPPRESSED)
  const t = world(); t.state.disposition = 'opt_out'
  assert.equal((await runFollowUpDispatch(job(t), deps(t))).code, C.TERMINAL)
})

test('a hold placed before dispatch (or an unanswerable registry) stops the dispatch', async () => {
  const w = world()
  const r = await runFollowUpDispatch(job(w), deps(w, { hold: async () => ({ held: true, hold_type: 'deal_hold', reason: 'x', hold_id: 'h2' }) }))
  assert.deepEqual([r.code, r.reason], [C.HELD, 'deal_hold'])
  const r2 = await runFollowUpDispatch(job(w), deps(w, { hold: async () => { throw new Error('down') } }))
  assert.deepEqual([r2.code, r2.reason], [C.HELD, 'lookup_error'])
  assert.equal(w.writes, 0)
})

test('superseded: a changed follow_up_at or a seller message at/after the due time — no row', async () => {
  const w = world()
  const stale = job(w, { follow_up_at: '2026-10-15T16:00:00.000Z' })
  assert.equal((await runFollowUpDispatch(stale, deps(w))).code, C.SUPERSEDED)
  const v = world({ state: { last_inbound_at: '2026-10-16T16:30:00.000Z' } })
  assert.deepEqual(Object.values(await runFollowUpDispatch(job(v), deps(v))).slice(0, 2), [C.SUPERSEDED, 'newer_inbound'])
  const gone = world(); const j = job(gone); gone.state.follow_up_at = null
  assert.equal((await runFollowUpDispatch(j, deps(gone))).code, C.INTENT_GONE)
  assert.equal(w.writes + v.writes + gone.writes, 0)
})

test('template origin: no approved sms_templates row (or unknown language) holds for a human — never code copy', async () => {
  const a = world({ templates: false })
  assert.deepEqual(Object.values(await runFollowUpDispatch(job(a), deps(a))).slice(0, 2), [C.HOLD_FOR_HUMAN, 'no_approved_template'])
  const b = world({ language: null })
  assert.deepEqual(Object.values(await runFollowUpDispatch(job(b), deps(b))).slice(0, 2), [C.HOLD_FOR_HUMAN, 'language_unknown'])
  assert.equal(a.writes + b.writes, 0)
})

test('outbound mode and sender health: paused processor / follow-ups / emergency stop ⇒ no row; an unhealthy sticky sender is dropped', async () => {
  for (const sw of [{ queue_processor_mode: 'paused' }, { followup_automation_mode: 'off' }, { queue_emergency_stop_at: '2026-10-16T10:00:00Z' }]) {
    const w = world({ switches: sw })
    assert.equal((await runFollowUpDispatch(job(w), deps(w))).code, C.OUTBOUND_PAUSED, JSON.stringify(sw))
    assert.equal(w.writes, 0)
  }
  const w = world({ senderStatus: 'blocked' })
  let ctxSeen = null
  const d = deps(w); const write = d.writeFollowUp
  d.writeFollowUp = async (i, t, ctx) => { ctxSeen = ctx; return write(i, t, ctx) }
  assert.equal((await runFollowUpDispatch(job(w), d)).code, C.ENQUEUED)
  assert.equal(ctxSeen.from_phone_number, null, 'the processor routes a healthy approved sender')
})

test('contact window: outside 08–21 recipient-local the row is pinned to the next lawful instant', async () => {
  const w = world({ now: '2026-10-17T04:30:00.000Z' }) // 23:30 Chicago
  w.state.follow_up_at = '2026-10-17T04:00:00.000Z'
  const r = await runFollowUpDispatch(job(w), deps(w))
  assert.equal(r.code, C.ENQUEUED)
  assert.equal(r.send_at, '2026-10-17T13:00:00.000Z', '08:00 Chicago')
  assert.equal(w.queue[0].scheduled_for, r.send_at)
})

test('dry run computes the full decision and writes nothing', async () => {
  const w = world({ switches: { [FOLLOWUP_EXECUTION_MODE_KEY]: 'dry_run' } })
  assert.equal((await runFollowUpDispatch(job(w), deps(w))).code, C.DRY_RUN)
  const s = await runFollowUpSweep(deps(w))
  assert.equal(s.counts.dry_run, 1)
  assert.equal(w.writes + w.jobs.length, 0)
})

// ── outcomes, retries, reconciliation ──────────────────────────────────────
test('outcome classification: delivered / accepted / transport (retryable) / ambiguous / terminal / held / overdue', () => {
  const now = Date.parse(NOW)
  const c = (row) => classifyFollowUpOutcome(row, { now })
  assert.equal(c({ queue_status: 'delivered' }).outcome, 'delivered')
  assert.equal(c({ queue_status: 'sent', sent_at: NOW, provider_message_id: 'SM1' }).outcome, 'provider_accepted')
  assert.equal(c({ queue_status: 'sent', sent_at: '2026-10-15T00:00:00Z' }).outcome, 'accepted_unconfirmed')
  assert.deepEqual(c({ queue_status: 'failed_transport' }), { outcome: 'transport_failure', retryable: true })
  assert.deepEqual(c({ queue_status: 'failed', failed_reason: 'provider timeout' }), { outcome: 'transport_failure', retryable: true })
  assert.deepEqual(c({ queue_status: 'failed', failed_reason: 'SEND FAILED - NO SID' }), { outcome: 'ambiguous', retryable: false })
  assert.deepEqual(c({ queue_status: 'failed', provider_message_id: 'SM9', failed_reason: 'timeout' }), { outcome: 'provider_accepted', retryable: false }, 'a provider id is an accept: never retried')
  assert.equal(c({ queue_status: 'failed', failed_reason: '21610 unsubscribed' }).outcome, 'terminal_failure')
  assert.equal(c({ queue_status: 'paused_deferred_unresolved' }).outcome, 'held_for_human')
  assert.equal(c({ queue_status: 'scheduled', scheduled_for: '2026-10-15T00:00:00Z' }).outcome, 'overdue_no_outcome')
})

test('reconcile: a due date with no job is reported; a transport failure retries ONCE (bounded); an ambiguous accept never retries', async () => {
  // missing job
  const m = world({ state: { follow_up_at: '2026-10-16T05:00:00.000Z' } })
  const rm = reconcileFollowUps({ intents: [m.state], rowsByThread: new Map(), now: Date.parse(NOW) })
  assert.equal(rm.counts.missing_job, 1)
  // transport failure on attempt 1 → one retry job (attempt 2) → its failure is final
  const w = world()
  const d = deps(w)
  await runFollowUpDispatch(job(w), d)
  Object.assign(w.queue[0], { queue_status: 'failed_transport', failed_reason: 'network error' })
  const r = await runFollowUpReconcile(d)
  assert.equal(r.counts.retry_scheduled, 1)
  assert.equal(r.counts.retries_enqueued, 1)
  const retry = decodeDispatchInput(w.jobs.at(-1).input)
  assert.equal(retry.attempt, 2)
  const r2 = await runFollowUpDispatch(retry, d)
  assert.equal(r2.code, C.ENQUEUED)
  assert.equal(w.queue.length, 2, 'attempt 2 is its own row')
  assert.ok(w.ledger.has(`${FOLLOWUP_LEDGER_SCOPE}:${followUpJobKey({ state_id: SID, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: DUE, attempt: 2 })}`))
  Object.assign(w.queue[1], { queue_status: 'failed_transport' })
  const r3 = await runFollowUpReconcile(d)
  assert.equal(r3.counts.retry_scheduled, 0)
  assert.equal(r3.counts.retries_exhausted, 1)
  // ambiguous
  const a = world()
  const da = deps(a)
  await runFollowUpDispatch(job(a), da)
  Object.assign(a.queue[0], { queue_status: 'failed', failed_reason: 'SEND FAILED - NO SID' })
  const ra = await runFollowUpReconcile(da)
  assert.equal(ra.counts.retry_scheduled, 0)
  assert.equal(ra.counts.ambiguous, 1)
  assert.equal(ra.ambiguous_refs.length, 1)
})

test('reconcile: duplicates (two live rows for one follow-up) and overdue rows without an outcome are reported', () => {
  const w = world()
  const rows = [
    { id: 'a', thread_key: PHONE, queue_status: 'scheduled', type: 'followup', scheduled_for: '2026-10-15T00:00:00Z', metadata: {} },
    { id: 'b', thread_key: PHONE, queue_status: 'queued', type: 'followup', scheduled_for: NOW, metadata: {} },
  ]
  const r = reconcileFollowUps({ intents: [w.state], rowsByThread: new Map([[PHONE, rows]]), now: Date.parse(NOW) })
  assert.equal(r.counts.duplicates, 1)
  assert.deepEqual(r.no_outcome, ['a'])
})

test('runtime handlers: dispatch decodes identifiers only and reports codes; input tampering is refused', async () => {
  const w = world()
  const h = buildFollowUpHandlers({ deps: deps(w) })
  const ctx = (input) => ({ job: { job_id: 'j1', input }, step: async () => {} })
  const ok = await h[FOLLOWUP_DISPATCH_KIND].run(ctx(encodeDispatchInput({ state_id: SID, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: DUE })))
  assert.equal(ok.result.code, C.ENQUEUED)
  assert.ok(!JSON.stringify(ok.result).includes(PHONE))
  const bad = await h[FOLLOWUP_DISPATCH_KIND].run(ctx({ state_ref: 'zz', followup_kind: 'x' }))
  assert.equal(bad.result.code, 'FOLLOWUP_INPUT_INVALID')
})
