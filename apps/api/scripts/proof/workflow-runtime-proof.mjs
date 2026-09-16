#!/usr/bin/env node
/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B — canonical event -> run -> scheduler proof.
 *
 * Proves the repaired runtime end to end, starting from a CANONICAL acquisition
 * domain event emitted through the same application path production uses
 * (`emitAutomationEvent` -> runAutomationEngine -> automation_events).
 *
 * §31 — WHAT IS AND IS NOT SYNTHETIC. The SUBJECT is test-owned: a synthetic
 * thread key, property id and master_owner_id that exist in no production
 * table. The RUNTIME HISTORY is not synthetic: nothing here inserts into
 * workflow_runs, workflow_run_steps or workflow_events, sets a run complete, or
 * writes a step result. Every row asserted below is produced by the real
 * bridge, matcher, runner and scheduled-task worker.
 *
 * The fixture workflows subscribe fixture-only trigger kinds that acquisition
 * never emits, so this cannot enroll a production seller.
 *
 * Usage (from apps/api):
 *   node --import ./scripts/proof/register-aliases-live.mjs scripts/proof/workflow-runtime-proof.mjs
 *   ... --phase bridge,idempotency,scheduler,suppression,review
 *   ... --cleanup
 */
import { readFile } from 'node:fs/promises'
import crypto from 'node:crypto'

// ─────────────────────────────────────────────────────────── env bootstrap

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await readFile(file, 'utf8')
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
        if (!m) continue
        const [, key, rawValue] = m
        if (process.env[key]) continue
        process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '')
      }
    } catch { /* next */ }
  }
}
await loadEnv()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const PHASES = arg('phase', 'bridge,idempotency,scheduler,suppression,review').split(',')
const wants = (p) => PHASES.includes(p)

// ───────────────────────────────────────────────────────── the test subject

/**
 * Test-owned identity. The thread key is deliberately in a reserved-for-testing
 * form and the ids are namespaced, so a stray row is obvious and greppable.
 */
const SUBJECT = {
  thread_key: 'wfproof:thread:0f7e1a00-runtime-proof-a',
  property_id: 'WFPROOF-PROPERTY-A',
  master_owner_id: 'wfproof-owner-a',
}
const REVIEW_SUBJECT = {
  thread_key: 'wfproof:thread:0f7e1a00-runtime-proof-review',
  property_id: 'WFPROOF-PROPERTY-REVIEW',
  master_owner_id: 'wfproof-owner-review',
}
const SUPPRESSED_SUBJECT = {
  thread_key: 'wfproof:thread:0f7e1a00-runtime-proof-dnc',
  property_id: 'WFPROOF-PROPERTY-DNC',
  master_owner_id: 'wfproof-owner-dnc',
}

const FIXTURE_A = '0f7e1a00-0000-4000-8000-000000000001'
const FIXTURE_B = '0f7e1a00-0000-4000-8000-000000000002'
const ALL_SUBJECTS = [SUBJECT, REVIEW_SUBJECT, SUPPRESSED_SUBJECT]

// ──────────────────────────────────────────────────────────────── plumbing

const { createClient } = await import('@supabase/supabase-js')
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const { emitAutomationEvent } = await import('@/lib/domain/automation/automation-events.js')
const { drainCanonicalEventsToWorkflow, processDueWorkflowTasks, runWorkflowRuntimeTick } =
  await import('@/lib/domain/workflow-v2/workflow-runtime-worker.js')

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ check: name, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
  return ok
}

const runsFor = async (definitionId, subjectId) => {
  const { data, error } = await supabase
    .from('workflow_runs')
    .select('id, status, dedupe_key, started_at, completed_at, enrollment_id')
    .eq('workflow_definition_id', definitionId)
    .eq('prospect_id', subjectId)
    .order('started_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

const enrollmentsFor = async (definitionId, subjectId) => {
  const { data, error } = await supabase
    .from('workflow_enrollments')
    .select('id, status, current_node_id, next_execution_at, context')
    .eq('workflow_definition_id', definitionId)
    .eq('subject_id', subjectId)
  if (error) throw error
  return data ?? []
}

const stepsFor = async (runIds) => {
  if (!runIds.length) return []
  const { data, error } = await supabase
    .from('workflow_run_steps')
    .select('id, workflow_run_id, node_key, node_type, status, block_reason, created_at')
    .in('workflow_run_id', runIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

const tasksFor = async (enrollmentIds) => {
  if (!enrollmentIds.length) return []
  const { data, error } = await supabase
    .from('workflow_scheduled_tasks')
    .select('id, status, task_type, scheduled_for, enrollment_id, completed_at, reason')
    .in('enrollment_id', enrollmentIds)
    .order('scheduled_for', { ascending: true })
  if (error) throw error
  return data ?? []
}

/** Emit a canonical acquisition event through the real production path. */
const emitCanonical = async (eventType, subject, extra = {}) => {
  const result = await emitAutomationEvent({
    event_type: eventType,
    source: 'workflow_runtime_proof',
    dedupe_key: extra.dedupe_key ?? `wfproof:${eventType}:${subject.thread_key}:${extra.nonce ?? 'fixed'}`,
    conversation_thread_id: subject.thread_key,
    property_id: subject.property_id,
    master_owner_id: subject.master_owner_id,
    payload: {
      thread_key: subject.thread_key,
      property_id: subject.property_id,
      master_owner_id: subject.master_owner_id,
      test_owned: true,
      proof: 'WORKFLOW-STUDIO-MOBILE-LOCK-1B',
      ...(extra.payload ?? {}),
    },
  }, { supabase })
  return result
}

/**
 * Clear TEST-OWNED runtime state so the proof is re-runnable.
 *
 * This deletes only rows scoped to the fixture definitions and the synthetic
 * subjects. It is not part of any assertion: every row the proof then checks is
 * created afterwards by the real engine. Without it the second run of this
 * script proves nothing — the canonical event is correctly recognised as a
 * duplicate and the engine is never invoked.
 */
const resetTestState = async () => {
  const threadKeys = ALL_SUBJECTS.map((s) => s.thread_key)
  const ownerIds = ALL_SUBJECTS.map((s) => s.master_owner_id)

  const enrollmentIds = []
  for (const def of [FIXTURE_A, FIXTURE_B]) {
    const { data } = await supabase
      .from('workflow_enrollments')
      .select('id')
      .eq('workflow_definition_id', def)
      .in('subject_id', threadKeys)
    enrollmentIds.push(...(data ?? []).map((r) => r.id))
  }

  const { data: runRows } = await supabase
    .from('workflow_runs')
    .select('id')
    .in('workflow_definition_id', [FIXTURE_A, FIXTURE_B])
    .in('prospect_id', threadKeys)
  const runIds = (runRows ?? []).map((r) => r.id)

  if (runIds.length) {
    await supabase.from('workflow_run_steps').delete().in('workflow_run_id', runIds)
    await supabase.from('workflow_run_events').delete().in('workflow_run_id', runIds)
    await supabase.from('workflow_runs').delete().in('id', runIds)
  }
  if (enrollmentIds.length) {
    await supabase.from('workflow_scheduled_tasks').delete().in('enrollment_id', enrollmentIds)
    await supabase.from('workflow_enrollments').delete().in('id', enrollmentIds)
  }
  await supabase.from('workflow_events').delete().in('subject_id', threadKeys)
  await supabase.from('automation_events').delete().in('conversation_thread_id', threadKeys)
  await supabase.from('message_events').delete().in('master_owner_id', ownerIds)

  console.log(`  reset: ${runIds.length} run(s), ${enrollmentIds.length} enrollment(s), test events and opt-outs cleared`)
  console.log('')
}

// ─────────────────────────────────────────────────────────────── the proof

console.log('WORKFLOW RUNTIME PROOF')
if (has('reset')) await resetTestState()
console.log(`  subject          ${SUBJECT.thread_key}`)
console.log(`  fixture A        ${FIXTURE_A}`)
console.log(`  fixture B        ${FIXTURE_B}`)
console.log('')

// ── §8 canonical event -> exactly one run
let runIdA = null
let enrollmentIdA = null

if (wants('bridge')) {
  console.log('§8 CANONICAL EVENT -> RUN CREATION')

  const before = await runsFor(FIXTURE_A, SUBJECT.thread_key)
  check('no run exists before the event', before.length === 0, `${before.length} pre-existing`)

  const emitted = await emitCanonical('TEST_WORKFLOW_RUNTIME_PROOF', SUBJECT)
  check('canonical event accepted by the real emit path', emitted?.ok !== false,
    JSON.stringify(emitted).slice(0, 200))

  const { data: canonicalRow } = await supabase
    .from('automation_events')
    .select('id, event_type, dedupe_key, conversation_thread_id')
    .eq('conversation_thread_id', SUBJECT.thread_key)
    .eq('event_type', 'TEST_WORKFLOW_RUNTIME_PROOF')
    .maybeSingle()
  check('canonical event landed on the canonical bus', Boolean(canonicalRow?.id),
    'no automation_events row')
  console.log(`      canonical_event_id  ${canonicalRow?.id}`)
  console.log(`      canonical_dedupe    ${canonicalRow?.dedupe_key}`)

  const bridge = await drainCanonicalEventsToWorkflow({ lookback_minutes: 10 })
  console.log(`      bridge  scanned=${bridge.scanned} bridged=${bridge.bridged} dup=${bridge.duplicates} unmapped=${bridge.unmapped} matched=${bridge.matched}`)
  check('bridge reported no errors', (bridge.errors ?? []).length === 0,
    JSON.stringify(bridge.errors).slice(0, 300))

  const runs = await runsFor(FIXTURE_A, SUBJECT.thread_key)
  check('exactly one run was created', runs.length === 1, `${runs.length} runs`)
  runIdA = runs[0]?.id ?? null

  const enrollments = await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key)
  check('exactly one enrollment was created', enrollments.length === 1, `${enrollments.length}`)
  enrollmentIdA = enrollments[0]?.id ?? null
  console.log(`      run_id              ${runIdA}`)
  console.log(`      enrollment_id       ${enrollmentIdA}`)

  // §1 containment: the published workflows must NOT have been touched.
  const { count: publishedRuns } = await supabase
    .from('workflow_runs')
    .select('id', { count: 'exact', head: true })
    .eq('prospect_id', SUBJECT.thread_key)
    .neq('workflow_definition_id', FIXTURE_A)
  check('no non-fixture workflow ran for the test subject', (publishedRuns ?? 0) === 0,
    `${publishedRuns} runs in other definitions`)
  console.log('')
}

// ── §5 replay the same canonical event
if (wants('idempotency')) {
  console.log('§5 DUPLICATE EVENT CANNOT DUPLICATE A RUN')

  const runsBefore = await runsFor(FIXTURE_A, SUBJECT.thread_key)
  const enrollBefore = await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key)

  // Same dedupe_key: this is the SAME canonical event arriving again.
  const replay = await emitCanonical('TEST_WORKFLOW_RUNTIME_PROOF', SUBJECT)
  const bridgeReplay = await drainCanonicalEventsToWorkflow({ lookback_minutes: 10 })
  console.log(`      replay emit ok=${replay?.ok !== false}  bridge dup=${bridgeReplay.duplicates} bridged=${bridgeReplay.bridged}`)

  const runsAfter = await runsFor(FIXTURE_A, SUBJECT.thread_key)
  const enrollAfter = await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key)
  check('replaying the event created no additional run',
    runsAfter.length === runsBefore.length, `${runsBefore.length} -> ${runsAfter.length}`)
  check('replaying the event created no additional enrollment',
    enrollAfter.length === enrollBefore.length, `${enrollBefore.length} -> ${enrollAfter.length}`)
  check('the duplicate was recognised as a duplicate, not silently dropped',
    bridgeReplay.duplicates >= 1, `duplicates=${bridgeReplay.duplicates}`)

  const { count: eventRows } = await supabase
    .from('workflow_events')
    .select('id', { count: 'exact', head: true })
    .eq('subject_id', SUBJECT.thread_key)
  check('only one workflow event row exists for the subject', (eventRows ?? 0) === 1,
    `${eventRows} workflow_events rows`)
  console.log('')
}

// ── §9/§10 current step and durable history
if (wants('bridge')) {
  console.log('§9/§10 CURRENT STEP AND DURABLE HISTORY')
  const runs = await runsFor(FIXTURE_A, SUBJECT.thread_key)
  const steps = await stepsFor(runs.map((r) => r.id))
  const enrollments = await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key)
  const enrollment = enrollments[0]

  console.log('      history:')
  for (const s of steps) console.log(`        ${String(s.status).padEnd(10)} ${String(s.node_key).padEnd(20)} ${s.node_type}`)

  check('history was generated by the engine, not written by this script', steps.length >= 2,
    `${steps.length} steps`)
  check('the trigger node is recorded', steps.some((s) => s.node_key === 'trig'), 'no trigger step')
  check('the run parked on the wait node', steps.some((s) => s.node_key === 'wait_proof' && s.status === 'waiting'),
    steps.map((s) => `${s.node_key}=${s.status}`).join(', '))
  check('the enrollment is waiting with a due time',
    enrollment?.status === 'waiting' && Boolean(enrollment?.next_execution_at),
    `status=${enrollment?.status} next=${enrollment?.next_execution_at}`)
  check('the trigger node is recorded as triggered, not scaffolded',
    steps.find((s) => s.node_key === 'trig')?.status === 'triggered',
    `trig status=${steps.find((s) => s.node_key === 'trig')?.status}`)

  // §9 — the projection the surface reads must say where the run actually is.
  // `current_node_id` is a RESUME pointer: on a timing pause the runner
  // advances it to the NEXT node and then parks. Reporting it as the position
  // claimed the run sat at `guard_suppression`, which had never executed.
  const { getWorkflowLiveState } = await import('@/lib/domain/workflow-v2/workflow-studio-bridge.js')
  const live = await getWorkflowLiveState(FIXTURE_A, { supabase })
  const token = (live.tokens ?? []).find((t) => t.subject_id === SUBJECT.thread_key)
  check('live state has a token for the subject', Boolean(token), 'no token')
  check('current step is the wait node the run is parked on',
    token?.step_key === 'wait_proof', `step_key=${token?.step_key}`)
  check('the resume pointer is reported separately as the next step',
    token?.next_step_key === 'guard_suppression', `next_step_key=${token?.next_step_key}`)
  check('completed nodes list what the engine finished',
    (token?.completed_node_keys ?? []).includes('trig'),
    JSON.stringify(token?.completed_node_keys))
  check('the token is reported as waiting', token?.status === 'waiting', `status=${token?.status}`)
  console.log(`      current step        ${token?.step_key} (${token?.step_status})`)
  console.log(`      next step           ${token?.next_step_key}`)
  console.log(`      completed           ${JSON.stringify(token?.completed_node_keys)}`)
  console.log(`      next_execution_at   ${enrollment?.next_execution_at}`)
  console.log('')
}

// ── §11/§12 durable scheduler
if (wants('scheduler')) {
  console.log('§11/§12 SCHEDULED EXECUTION THROUGH THE WORKER')

  const enrollments = await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key)
  const enrollment = enrollments[0]
  if (!enrollment) {
    check('an enrollment exists to advance', false, 'run the bridge phase first')
  } else {
    // Time travel on TEST-OWNED state only: make the wait due now rather than
    // sleeping a minute. The engine still decides what advancing means.
    const { error: dueErr } = await supabase
      .from('workflow_enrollments')
      .update({ next_execution_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', enrollment.id)
    check('test-owned wait could be made due', !dueErr, dueErr?.message)

    const tick = await runWorkflowRuntimeTick({ lookback_minutes: 10 })
    console.log(`      tick  enrollments processed=${tick.enrollments?.processed} tasks due=${tick.scheduled?.due} processed=${tick.scheduled?.processed}`)
    check('the tick reported no send', tick.live_send_blocked === true && tick.no_outbound_messages_sent === true,
      JSON.stringify({ l: tick.live_send_blocked, n: tick.no_outbound_messages_sent }))

    const runs = await runsFor(FIXTURE_A, SUBJECT.thread_key)
    const steps = await stepsFor(runs.map((r) => r.id))
    const after = (await enrollmentsFor(FIXTURE_A, SUBJECT.thread_key))[0]

    console.log('      history after tick:')
    for (const s of steps) console.log(`        ${String(s.status).padEnd(10)} ${String(s.node_key).padEnd(20)} ${s.node_type}`)

    check('the run advanced past the wait',
      steps.some((s) => s.node_key === 'guard_suppression'),
      steps.map((s) => s.node_key).join(', '))
    check('the suppression gate passed for a clean subject',
      steps.some((s) => s.node_key === 'guard_suppression' && s.status === 'completed'),
      steps.filter((s) => s.node_key === 'guard_suppression').map((s) => `${s.status}/${s.block_reason}`).join(', '))

    const tasks = await tasksFor([enrollment.id])
    console.log(`      scheduled tasks: ${tasks.length}`)
    for (const t of tasks) console.log(`        ${String(t.status).padEnd(10)} ${t.task_type} due=${t.scheduled_for}`)
    check('the schedule_follow_up node created exactly one scheduled task', tasks.length === 1,
      `${tasks.length} tasks`)

    if (tasks.length === 1) {
      // Make the task due, then drive it through the worker.
      await supabase
        .from('workflow_scheduled_tasks')
        .update({ scheduled_for: new Date(Date.now() - 1000).toISOString() })
        .eq('id', tasks[0].id)

      const first = await processDueWorkflowTasks({})
      const second = await processDueWorkflowTasks({})
      console.log(`      task worker: first processed=${first.processed} advanced=${first.advanced} | second processed=${second.processed} claimed=${second.already_claimed}`)

      check('the due task was processed exactly once', first.processed === 1, `${first.processed}`)
      check('a second tick did not reprocess it', second.processed === 0,
        `second tick processed ${second.processed}`)

      const afterTasks = await tasksFor([enrollment.id])
      check('the task is no longer pending',
        afterTasks.every((t) => t.status !== 'pending'),
        afterTasks.map((t) => t.status).join(', '))
    }

    console.log(`      enrollment status   ${after?.status}`)
  }
  console.log('')
}

// ── §15 DNC interrupts a run mid-flight
if (wants('suppression')) {
  console.log('§15 DNC INTERRUPTS EXECUTION MID-RUN')

  const emitted = await emitCanonical('TEST_WORKFLOW_RUNTIME_PROOF', SUPPRESSED_SUBJECT)
  check('suppression-subject event accepted', emitted?.ok !== false, JSON.stringify(emitted).slice(0, 160))
  await drainCanonicalEventsToWorkflow({ lookback_minutes: 10 })

  const enrollments = await enrollmentsFor(FIXTURE_A, SUPPRESSED_SUBJECT.thread_key)
  const enrollment = enrollments[0]
  check('the suppression subject enrolled and is waiting', enrollment?.status === 'waiting',
    `status=${enrollment?.status}`)

  if (enrollment) {
    // The run is parked on the wait. NOW the subject becomes DNC, through the
    // same signal the production guard reads: an opt-out message_event for the
    // owner. Nothing about the workflow is touched.
    // message_events has message_body, not body, and requires message_event_key
    // / direction / event_type NOT NULL. Getting this wrong is not cosmetic:
    // the first attempt used `body`, the insert failed, no opt-out signal
    // existed, and the guard then passed for the right reason about the wrong
    // world. Only checking the insert error caught it.
    const { error: dncErr } = await supabase.from('message_events').insert({
      message_event_key: `wfproof-optout:${SUPPRESSED_SUBJECT.master_owner_id}:${Date.now()}`,
      master_owner_id: SUPPRESSED_SUBJECT.master_owner_id,
      is_opt_out: true,
      direction: 'inbound',
      event_type: 'workflow_runtime_proof_opt_out',
      message_body: 'STOP',
      created_at: new Date().toISOString(),
    })
    check('opt-out signal recorded for the test owner', !dncErr, dncErr?.message)

    await supabase
      .from('workflow_enrollments')
      .update({ next_execution_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', enrollment.id)

    await runWorkflowRuntimeTick({ lookback_minutes: 10 })

    const runs = await runsFor(FIXTURE_A, SUPPRESSED_SUBJECT.thread_key)
    const steps = await stepsFor(runs.map((r) => r.id))
    console.log('      history:')
    for (const s of steps) console.log(`        ${String(s.status).padEnd(10)} ${String(s.node_key).padEnd(20)} ${s.block_reason ?? ''}`)

    const guardStep = steps.find((s) => s.node_key === 'guard_suppression')
    check('the suppression gate blocked the run', guardStep?.status === 'blocked',
      `status=${guardStep?.status} reason=${guardStep?.block_reason}`)
    check('the block reason names suppression', /suppress/i.test(String(guardStep?.block_reason ?? '')),
      String(guardStep?.block_reason))
    check('nothing past the gate executed',
      !steps.some((s) => s.node_key === 'schedule_proof' || s.node_key === 'notify_done'),
      steps.map((s) => s.node_key).join(', '))

    const tasks = await tasksFor([enrollment.id])
    check('no follow-up was scheduled for a suppressed subject', tasks.length === 0,
      `${tasks.length} tasks`)
  }
  console.log('')
}

// ── §18 human review holds
if (wants('review')) {
  console.log('§18 HUMAN REVIEW HOLDS THE RUN')

  const emitted = await emitCanonical('TEST_WORKFLOW_REVIEW_PROOF', REVIEW_SUBJECT)
  check('review event accepted', emitted?.ok !== false, JSON.stringify(emitted).slice(0, 160))
  await drainCanonicalEventsToWorkflow({ lookback_minutes: 10 })

  const runs = await runsFor(FIXTURE_B, REVIEW_SUBJECT.thread_key)
  check('exactly one review run was created', runs.length === 1, `${runs.length}`)
  const steps = await stepsFor(runs.map((r) => r.id))
  console.log('      history:')
  for (const s of steps) console.log(`        ${String(s.status).padEnd(10)} ${String(s.node_key).padEnd(22)} ${s.block_reason ?? ''}`)

  const guardStep = steps.find((s) => s.node_key === 'guard_approval')
  check('the approval gate blocked the run', guardStep?.status === 'blocked',
    `status=${guardStep?.status}`)
  check('the reason names human approval', /approval/i.test(String(guardStep?.block_reason ?? '')),
    String(guardStep?.block_reason))
  check('automation did not continue past review',
    !steps.some((s) => s.node_key === 'notify_after_review'),
    steps.map((s) => s.node_key).join(', '))
  console.log('')
}

// ── send safety, always asserted
console.log('§28 LIVE SENDS REMAIN DISABLED')
{
  const { data: queueRows } = await supabase
    .from('send_queue')
    .select('id, queue_status, metadata')
    .in('master_owner_id', ALL_SUBJECTS.map((s) => s.master_owner_id))
  const rows = queueRows ?? []
  console.log(`      send_queue rows for test subjects: ${rows.length}`)
  check('no test subject produced a sendable queue row',
    rows.every((r) => r.metadata?.no_send === true || r.metadata?.sms_eligible === false),
    rows.map((r) => `${r.id}:${r.queue_status}`).join(', '))

  const { count: liveDefs } = await supabase
    .from('workflow_definitions')
    .select('id', { count: 'exact', head: true })
    .eq('live_send_enabled', true)
  check('no workflow definition has live sends enabled', (liveDefs ?? 0) === 0, `${liveDefs}`)

  const { data: activeDefs } = await supabase
    .from('workflow_definitions')
    .select('name, status')
    .eq('status', 'active')
  const nonTest = (activeDefs ?? []).filter((d) => !/^TEST|^Test WF/.test(d.name))
  check('only test-owned definitions are active', nonTest.length === 0,
    nonTest.map((d) => d.name).join(', '))
}
console.log('')

// ── §32 cleanup
if (has('cleanup')) {
  console.log('§32 CLEANUP')
  const enrollAll = []
  for (const def of [FIXTURE_A, FIXTURE_B]) {
    for (const s of ALL_SUBJECTS) {
      const e = await enrollmentsFor(def, s.thread_key)
      enrollAll.push(...e.map((x) => x.id))
    }
  }
  const { count: cancelledTasks } = await supabase
    .from('workflow_scheduled_tasks')
    .update({ status: 'cancelled', reason: 'runtime_proof_cleanup' }, { count: 'exact' })
    .in('enrollment_id', enrollAll.length ? enrollAll : ['none'])
    .eq('status', 'pending')
  console.log(`      cancelled pending test tasks: ${cancelledTasks ?? 0}`)

  for (const def of [FIXTURE_A, FIXTURE_B]) {
    await supabase.from('workflow_definitions').update({ status: 'archived' }).eq('id', def)
  }
  console.log('      fixture definitions archived (no longer matchable)')

  const { data: stillActive } = await supabase
    .from('workflow_definitions').select('name').eq('status', 'active')
  console.log(`      remaining active definitions: ${(stillActive ?? []).map((d) => d.name).join(', ') || 'none'}`)
  console.log('')
}

// ─────────────────────────────────────────────────────────────── verdict
console.log(findings.length === 0
  ? 'RUNTIME PROOF: all checks passed'
  : `RUNTIME PROOF: ${findings.length} finding(s)`)
for (const f of findings) console.log(`  FAIL ${f.check}: ${f.detail}`)
process.exit(findings.length === 0 ? 0 : 1)
