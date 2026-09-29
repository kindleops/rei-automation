/**
 * WORKFLOW ORCHESTRATOR RUNTIME — durable runs over immutable versions.
 *
 *   publishVersion   validate → immutable wf_versions row (n+1); running runs keep their version
 *   setWorkflowStatus draft | armed | paused | archived (armed requires a published version)
 *   tickOrchestrator  (cron) gate → ingest workflow_events past a durable cursor
 *                     (start runs + resolve waits) → claim due runs under a lease
 *                     → step each run → heartbeat
 *   deliverEvent      resolves matching open event waits exactly once
 *   decideApproval    operator decision on an approval wait (exactly once)
 *   resumeRun / cancelRun  operator control on held / live runs
 *
 * A run executes only its pinned version's graph. Every action goes through a
 * capability (capabilities.js) whose idempotency key makes a logical action
 * succeed at most once across retries, crashes and double delivery
 * (wf_run_steps_action_once). A condition whose canonical facts cannot be read
 * HOLDS the run — it never guesses a branch. Off unless both
 * system_control.workflow_orchestrator_enabled and env
 * WORKFLOW_ORCHESTRATOR_ENABLED are 'true'.
 */
import { createHash } from 'node:crypto'
import { CAPABILITIES, POLICY, STATUS } from './capabilities.js'
import { TRIGGERS, CONDITIONS, evaluateCondition } from './catalog.js'
import { validateGraph, diffGraphs, describeGraph } from './graph.js'
import { readConditionFacts } from './facts.js'

export const LIVE_STATES = Object.freeze(['running', 'waiting', 'awaiting_approval', 'held'])
const STEP_BUDGET = 25
const MAX_CATCHUP_HOURS = 24
const HOUR = 3600_000
const clean = (v) => String(v ?? '').trim()
const iso = (ms) => new Date(ms).toISOString()

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export const graphHash = (graph) => createHash('sha256').update(stable(graph)).digest('hex').slice(0, 32)

async function readControl(db, keys) {
  const { data, error } = await db.from('system_control').select('key, value').in('key', keys)
  if (error) return { error }
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]))
}
async function writeControl(db, key, value, now) {
  return db.from('system_control').upsert({ key, value: String(value), updated_at: now }, { onConflict: 'key' })
}

// ── versions ────────────────────────────────────────────────────────────────

export async function publishVersion(db, { workflow_key, name, domain = null, graph, actor, note = null, env = {}, reentry } = {}) {
  if (!clean(actor)) return { ok: false, code: 'actor_required' }
  const validation = validateGraph(graph, env)
  if (!validation.ok) return { ok: false, code: 'validation_failed', errors: validation.errors, warnings: validation.warnings }
  const existing = await db.from('wf_workflows').select('*').eq('workflow_key', workflow_key).maybeSingle()
  if (existing.error) return { ok: false, code: 'read_failed', error: existing.error.message }
  if (!existing.data) {
    const ins = await db.from('wf_workflows').insert({ workflow_key, name: clean(name) || workflow_key, domain, owner: actor, status: 'draft', ...(reentry ? { reentry } : {}) })
    if (ins.error && ins.error.code !== '23505') return { ok: false, code: 'write_failed', error: ins.error.message }
  }
  const prev = await db.from('wf_versions').select('version, graph, graph_hash').eq('workflow_key', workflow_key).order('version', { ascending: false }).limit(1).maybeSingle()
  if (prev.error) return { ok: false, code: 'read_failed', error: prev.error.message }
  const hash = graphHash(graph)
  if (prev.data?.graph_hash === hash) return { ok: true, unchanged: true, version: prev.data.version }
  const version = (prev.data?.version || 0) + 1
  const row = { workflow_key, version, graph, graph_hash: hash, description: describeGraph(graph), validation: { warnings: validation.warnings }, change_note: note, published_by: actor }
  const ins = await db.from('wf_versions').insert(row)
  if (ins.error) return { ok: false, code: ins.error.code === '23505' ? 'version_conflict' : 'write_failed', error: ins.error.message }
  // New runs start on the newest published version; running runs stay pinned.
  const upd = await db.from('wf_workflows').update({ live_version: version, updated_at: new Date().toISOString() }).eq('workflow_key', workflow_key)
  if (upd.error) return { ok: false, code: 'write_failed', error: upd.error.message }
  return { ok: true, version, diff: prev.data ? diffGraphs(prev.data.graph, graph) : [], warnings: validation.warnings }
}

export async function setWorkflowStatus(db, workflow_key, status, actor) {
  if (!['draft', 'armed', 'paused', 'archived'].includes(status)) return { ok: false, code: 'invalid_status' }
  if (!clean(actor)) return { ok: false, code: 'actor_required' }
  const wf = await db.from('wf_workflows').select('*').eq('workflow_key', workflow_key).maybeSingle()
  if (wf.error || !wf.data) return { ok: false, code: 'workflow_not_found' }
  if (status === 'armed' && !wf.data.live_version) return { ok: false, code: 'no_published_version' }
  const now = new Date().toISOString()
  const { error } = await db.from('wf_workflows').update({ status, status_changed_by: actor, status_changed_at: now, updated_at: now }).eq('workflow_key', workflow_key)
  return error ? { ok: false, code: 'write_failed', error: error.message } : { ok: true, status }
}

// ── subjects + starts ──────────────────────────────────────────────────────

/** The exact identity scope an event gives a trigger (never a loose string when canonical ids exist). */
export function scopeFor(triggerKey, event = {}) {
  const t = TRIGGERS[triggerKey]
  if (!t) return null
  const p = event.payload || {}
  const scope = {}
  for (const k of t.scope) {
    let v = p[k] ?? p.context?.[k] ?? null
    if (v == null && event.subject_type && k === `${event.subject_type}_id`) v = event.subject_id
    scope[k] = v == null ? null : String(v)
  }
  if (event.subject_type === 'opportunity' && event.subject_id && !scope.opportunity_id) scope.opportunity_id = String(event.subject_id)
  const kind = t.scope[0]
  return { kind, id: scope[kind], scope }
}

export const eventMatches = (triggerKey, eventType) => Boolean(TRIGGERS[triggerKey]?.event_types.includes(eventType))

async function loadVersion(db, key, version, cache) {
  const ck = `${key}@${version}`
  if (cache?.has(ck)) return cache.get(ck)
  const { data, error } = await db.from('wf_versions').select('workflow_key, version, graph').eq('workflow_key', key).eq('version', version).maybeSingle()
  if (error || !data) return null
  cache?.set(ck, data)
  return data
}

export async function startRunsForEvent(db, event, { now = new Date().toISOString(), cache = new Map() } = {}) {
  const wfs = await db.from('wf_workflows').select('workflow_key, live_version, reentry').eq('status', 'armed')
  if (wfs.error) return { ok: false, error: wfs.error.message, started: [] }
  const started = []
  const skipped = []
  for (const wf of wfs.data || []) {
    const v = await loadVersion(db, wf.workflow_key, wf.live_version, cache)
    if (!v || !eventMatches(v.graph.trigger?.type, event.event_type)) continue
    const subj = scopeFor(v.graph.trigger.type, event)
    if (!subj?.id) { skipped.push({ workflow_key: wf.workflow_key, reason: 'subject_missing' }); continue }
    const start_key = wf.reentry === 'once' ? `${wf.workflow_key}:${subj.kind}:${subj.id}` : `${wf.workflow_key}:event:${event.id}`
    const ins = await db.from('wf_runs').insert({
      workflow_key: wf.workflow_key, version: v.version, subject_kind: subj.kind, subject_id: subj.id,
      trigger_event_type: event.event_type, trigger_event_id: event.id ? String(event.id) : null, start_key,
      state: 'running', cursor: null, wake_at: now,
      context: { trigger: subj.scope, event: { id: event.id ?? null, type: event.event_type, at: event.created_at ?? now } },
      started_at: now, updated_at: now,
    }).select('id').maybeSingle()
    if (ins.error) skipped.push({ workflow_key: wf.workflow_key, reason: ins.error.code === '23505' ? 'already_running_or_started' : ins.error.message })
    else started.push({ workflow_key: wf.workflow_key, run_id: ins.data?.id, version: v.version })
  }
  return { ok: true, started, skipped }
}

/** Resolve every open event / loop-stop wait this event satisfies — each exactly once. */
export async function deliverEvent(db, event, { now = new Date().toISOString() } = {}) {
  const p = event.payload || {}
  const ids = [...new Set([event.subject_id, p.thread_key, p.opportunity_id, p.closing_case_id, p.property_id, p.master_owner_id, p.campaign_id, p.queue_row_id].filter(Boolean).map(String))]
  if (!ids.length) return { ok: true, resolved: 0 }
  const { data, error } = await db.from('wf_waits').select('id, run_id, node_id, kind, event_type, subject_kind, subject_id').eq('status', 'open').in('kind', ['event', 'loop_stop']).in('subject_id', ids).limit(500)
  if (error) return { ok: false, error: error.message, resolved: 0 }
  let resolved = 0
  for (const w of data || []) {
    if (!eventMatches(w.event_type, event.event_type)) continue
    const subj = scopeFor(w.event_type, event)
    if (subj?.kind !== w.subject_kind || subj?.id !== w.subject_id) continue
    const upd = await db.from('wf_waits').update({ status: 'resolved', resolution: 'Event', resolved_by: `event:${event.event_type}`, resolved_at: now, payload: { event_id: event.id ?? null } }).eq('id', w.id).eq('status', 'open').select('id')
    if (upd.error || !(upd.data || []).length) continue
    resolved++
    await db.from('wf_runs').update({ wake_at: now, updated_at: now }).eq('id', w.run_id).in('state', ['waiting'])
  }
  return { ok: true, resolved }
}

export async function decideApproval(db, { run_id, node_id, decision, actor, note = null, now = new Date().toISOString() }) {
  if (!['Approved', 'Rejected'].includes(decision)) return { ok: false, code: 'invalid_decision' }
  if (!clean(actor)) return { ok: false, code: 'actor_required' }
  const upd = await db.from('wf_waits').update({ status: 'resolved', resolution: decision, resolved_by: actor, resolved_at: now, payload: note ? { note } : null }).eq('run_id', run_id).eq('node_id', node_id).eq('kind', 'approval').eq('status', 'open').select('id')
  if (upd.error) return { ok: false, code: 'write_failed', error: upd.error.message }
  if (!(upd.data || []).length) return { ok: false, code: 'approval_not_open' }
  await db.from('wf_runs').update({ wake_at: now, updated_at: now }).eq('id', run_id).eq('state', 'awaiting_approval')
  return { ok: true, decision }
}

export async function resumeRun(db, run_id, actor, now = new Date().toISOString()) {
  if (!clean(actor)) return { ok: false, code: 'actor_required' }
  const upd = await db.from('wf_runs').update({ state: 'running', reason: null, wake_at: now, updated_at: now }).eq('id', run_id).eq('state', 'held').select('id, context')
  if (upd.error) return { ok: false, code: 'write_failed' }
  if (!(upd.data || []).length) return { ok: false, code: 'run_not_held' }
  return { ok: true }
}

export async function cancelRun(db, run_id, actor, reason = 'cancelled_by_operator', now = new Date().toISOString()) {
  if (!clean(actor)) return { ok: false, code: 'actor_required' }
  const upd = await db.from('wf_runs').update({ state: 'cancelled', outcome: 'cancelled', reason: `${reason} (${actor})`, finished_at: now, wake_at: null, updated_at: now }).eq('id', run_id).in('state', LIVE_STATES).select('id')
  if (upd.error) return { ok: false, code: 'write_failed' }
  if (!(upd.data || []).length) return { ok: false, code: 'run_not_live' }
  await db.from('wf_waits').update({ status: 'cancelled', resolved_at: now, resolved_by: actor }).eq('run_id', run_id).eq('status', 'open')
  return { ok: true }
}

// ── stepping ───────────────────────────────────────────────────────────────

function lookup(path, run, now) {
  const [head, ...rest] = path.split('.')
  if (head === 'trigger') return rest.length ? run.context?.trigger?.[rest.join('.')] ?? null : run.context?.trigger ?? null
  if (head === 'nodes') return rest.slice(1).reduce((o, k) => (o == null ? o : o[k]), run.context?.nodes?.[rest[0]]) ?? null
  if (path === 'system.now') return now
  return null
}
export function resolveInputs(v, run, now) {
  if (Array.isArray(v)) return v.map((x) => resolveInputs(x, run, now))
  if (v && typeof v === 'object') {
    if (typeof v.var === 'string') return lookup(v.var, run, now)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveInputs(x, run, now)]))
  }
  return v
}

function transform(op, i) {
  switch (op) {
    case 'format_money': return Number.isFinite(Number(i.value)) ? `$${Math.round(Number(i.value)).toLocaleString('en-US')}` : null
    case 'format_date': return i.value ? new Date(i.value).toISOString().slice(0, 10) : null
    case 'duration_between': return i.from && i.to ? (Date.parse(i.to) - Date.parse(i.from)) / HOUR : null
    case 'map_label': return i.map?.[i.value] ?? i.fallback ?? null
    case 'pick_first': return (i.values || []).find((x) => x != null && x !== '') ?? null
    default: return null
  }
}

async function addStep(db, run, step, now) {
  const { error } = await db.from('wf_run_steps').insert({ run_id: run.id, at: now, ...step })
  if (error && error.code === '23505' && step.status === 'succeeded') return { duplicate: true }
  if (error) throw new Error(`step_write_failed:${error.message}`)
  return { duplicate: false }
}

async function openWait(db, run, nodeId, row, now) {
  const got = await db.from('wf_waits').select('*').eq('run_id', run.id).eq('node_id', nodeId).maybeSingle()
  if (got.error) throw new Error(`wait_read_failed:${got.error.message}`)
  if (got.data) return got.data
  const ins = await db.from('wf_waits').insert({ run_id: run.id, node_id: nodeId, status: 'open', created_at: now, ...row }).select('*').maybeSingle()
  if (ins.error && ins.error.code !== '23505') throw new Error(`wait_write_failed:${ins.error.message}`)
  if (ins.data) return { ...ins.data, _new: true }
  return (await db.from('wf_waits').select('*').eq('run_id', run.id).eq('node_id', nodeId).maybeSingle()).data
}

/** Time out an open wait exactly once; if an event/decision won the race, report that instead. */
async function expireWait(db, wait, now) {
  const upd = await db.from('wf_waits').update({ status: 'timed_out', resolution: 'Timeout', resolved_by: 'timer', resolved_at: now }).eq('id', wait.id).eq('status', 'open').select('id')
  if (!upd.error && (upd.data || []).length) return 'Timeout'
  const again = await db.from('wf_waits').select('status, resolution').eq('id', wait.id).maybeSingle()
  return again.data?.status === 'resolved' ? again.data.resolution : 'Timeout'
}

const retryDelay = (cap, attempt) => (cap.retry.backoffSeconds || 60) * 1000 * 2 ** Math.max(0, attempt - 1)

async function invokeAction(db, run, node, capKey, inputs, nodeKey, deps, now) {
  const cap = (deps.capabilities || CAPABILITIES)[capKey]
  if (!cap) return { hold: `unknown_capability:${capKey}` }
  const avail = cap.availability(deps.env || {})
  if (avail.state !== 'AVAILABLE') return { hold: `capability_${avail.state.toLowerCase()}:${capKey}` }
  // Defense in depth: publish-time validation already requires an Approval on every path.
  if (cap.policy === POLICY.APPROVAL && !run.context.approved_by) return { hold: `approval_missing:${capKey}` }
  if (cap.policy === POLICY.MANUAL) return { hold: `manual_only:${capKey}` }
  const ctx = { runId: run.id, nodeId: nodeKey, workflowKey: run.workflow_key, version: run.version, deps: { supabase: db, ...(deps.capabilityDeps || {}) } }
  const key = cap.idempotencyKey(inputs, ctx) || `wf:${run.id}:${nodeKey}`
  let r
  try { r = await cap.invoke(inputs, ctx) } catch (e) { r = { status: STATUS.RETRYABLE, reason: clean(e?.message).slice(0, 200) || 'invoke_threw' } }
  const attempts = (run.context.attempts ||= {})
  const attempt = (attempts[nodeKey] || 0) + 1
  if (r.status === STATUS.SUCCESS) {
    await addStep(db, run, { node_id: nodeKey, kind: 'action', capability: capKey, status: 'succeeded', idempotency_key: key, reason: r.reason || null, outputs: r.outputs ? JSON.parse(JSON.stringify(r.outputs)) : null, attempt }, now)
    delete attempts[nodeKey]
    ;(run.context.nodes ||= {})[node.id] = r.outputs || {}
    return { ok: true }
  }
  if (r.status === STATUS.RETRYABLE && attempt < cap.retry.max) {
    attempts[nodeKey] = attempt
    await addStep(db, run, { node_id: nodeKey, kind: 'action', capability: capKey, status: 'retrying', reason: r.reason, attempt }, now)
    return { park: { state: 'waiting', wake_at: iso(Date.parse(now) + retryDelay(cap, attempt)), reason: `retrying:${r.reason}` } }
  }
  if (r.status === STATUS.WAITING) {
    await addStep(db, run, { node_id: nodeKey, kind: 'action', capability: capKey, status: 'waiting', reason: r.reason, attempt }, now)
    return { park: { state: 'waiting', wake_at: iso(Date.parse(now) + 15 * 60_000), reason: `waiting_external:${r.reason}` } }
  }
  delete attempts[nodeKey]
  const status = r.status === STATUS.BLOCKED ? 'blocked' : 'failed'
  await addStep(db, run, { node_id: nodeKey, kind: 'action', capability: capKey, status, reason: r.reason || status, attempt }, now)
  return { failed: true, blocked: status === 'blocked', reason: `${status}:${capKey}:${r.reason || ''}` }
}

async function execNode(db, run, node, deps, now) {
  const c = node.config || {}
  const nowMs = Date.parse(now)
  switch (node.kind) {
    case 'action': {
      const inputs = resolveInputs(c.inputs || {}, run, now)
      const r = await invokeAction(db, run, node, c.capability, inputs, node.id, deps, now)
      if (r.hold) return { hold: r.hold }
      if (r.park) return r
      const hasFailedExit = c.on_failure === 'branch'
      if (r.ok) return { exit: hasFailedExit ? 'Success' : 'Next' }
      return hasFailedExit ? { exit: 'Failed' } : { hold: r.reason }
    }
    case 'condition': {
      const facts = await (deps.readFacts || readConditionFacts)(c.condition, run, { supabase: db, now, ...(deps.factDeps || {}) })
      if (!facts || !CONDITIONS[c.condition]) return { hold: `facts_unavailable:${c.condition}` }
      const exit = evaluateCondition(c.condition, { now: nowMs, ...facts })
      await addStep(db, run, { node_id: node.id, kind: 'condition', status: 'resolved', exit, reason: CONDITIONS[c.condition].reads, outputs: facts }, now)
      return { exit }
    }
    case 'wait': {
      if (c.mode === 'contact_window') {
        await addStep(db, run, { node_id: node.id, kind: 'wait', status: 'resolved', exit: 'Next', reason: 'contact window is enforced by the send authority at dispatch' }, now)
        return { exit: 'Next' }
      }
      if (c.mode === 'duration' || c.mode === 'until') {
        const timers = (run.context.timers ||= {})
        if (!timers[node.id]) {
          // anchor 'trigger': the duration counts from the triggering event, so a run
          // that starts late (outage, catch-up) still fires at the right moment.
          const base = c.anchor === 'trigger' && Date.parse(run.context.event?.at) ? Date.parse(run.context.event.at) : nowMs
          const until = c.mode === 'duration' ? base + Number(c.duration_hours) * HOUR : Date.parse(resolveInputs(c.until, run, now))
          if (!Number.isFinite(until)) return { hold: 'wait_until_unresolved' }
          timers[node.id] = iso(until)
          await addStep(db, run, { node_id: node.id, kind: 'wait', status: 'waiting', reason: `until ${timers[node.id]}` }, now)
        }
        if (Date.parse(timers[node.id]) > nowMs) return { park: { state: 'waiting', wake_at: timers[node.id] } }
        await addStep(db, run, { node_id: node.id, kind: 'wait', status: 'resolved', exit: 'Next', reason: `elapsed ${timers[node.id]}` }, now)
        delete timers[node.id]
        return { exit: 'Next' }
      }
      // event wait with mandatory timeout
      const t = TRIGGERS[c.event]
      const kind = t?.scope[0]
      const subjectId = kind ? run.context.trigger?.[kind] : null
      if (!subjectId) return { hold: `wait_subject_missing:${kind || c.event}` }
      const w = await openWait(db, run, node.id, { kind: 'event', event_type: c.event, subject_kind: kind, subject_id: subjectId, timeout_at: iso(nowMs + Number(c.timeout_hours) * HOUR) }, now)
      if (w._new) await addStep(db, run, { node_id: node.id, kind: 'wait', status: 'waiting', reason: `for ${c.event} until ${w.timeout_at}` }, now)
      let exit = w.status === 'resolved' ? 'Event' : w.status === 'timed_out' ? 'Timeout' : null
      if (!exit && Date.parse(w.timeout_at) <= nowMs) exit = await expireWait(db, w, now)
      if (!exit) return { park: { state: 'waiting', wake_at: w.timeout_at } }
      await addStep(db, run, { node_id: node.id, kind: 'wait', status: 'resolved', exit }, now)
      return { exit }
    }
    case 'approval': {
      const timeout = Number(c.timeout_hours) > 0 ? iso(nowMs + Number(c.timeout_hours) * HOUR) : null
      const w = await openWait(db, run, node.id, { kind: 'approval', title: clean(c.title), subject_kind: run.subject_kind, subject_id: run.subject_id, timeout_at: timeout }, now)
      if (w._new) await addStep(db, run, { node_id: node.id, kind: 'approval', status: 'waiting', reason: c.title }, now)
      let exit = w.status === 'resolved' ? w.resolution : w.status === 'timed_out' ? 'Timeout' : null
      if (!exit && w.timeout_at && Date.parse(w.timeout_at) <= nowMs) exit = await expireWait(db, w, now)
      if (!exit) return { park: { state: 'awaiting_approval', wake_at: w.timeout_at || null } }
      if (exit === 'Approved') run.context.approved_by = w.resolved_by || 'operator'
      await addStep(db, run, { node_id: node.id, kind: 'approval', status: 'resolved', exit, reason: w.resolved_by ? `by ${w.resolved_by}` : null }, now)
      return { exit }
    }
    case 'follow_up_loop': {
      const loops = (run.context.loops ||= {})
      const st = (loops[node.id] ||= { attempts: 0, next_at: now })
      const stopKey = `${node.id}:stop`
      let stopWait = null
      if (c.stop?.event) {
        const kind = TRIGGERS[c.stop.event]?.scope[0]
        const sid = kind ? run.context.trigger?.[kind] : null
        if (!sid) return { hold: `loop_stop_subject_missing:${kind || c.stop.event}` }
        stopWait = await openWait(db, run, stopKey, { kind: 'loop_stop', event_type: c.stop.event, subject_kind: kind, subject_id: sid, timeout_at: null }, now)
      }
      let stopped = stopWait?.status === 'resolved'
      if (!stopped && c.stop?.condition) {
        const facts = await (deps.readFacts || readConditionFacts)(c.stop.condition, run, { supabase: db, now, ...(deps.factDeps || {}) })
        if (!facts) return { hold: `facts_unavailable:${c.stop.condition}` }
        stopped = evaluateCondition(c.stop.condition, { now: nowMs, ...facts }) === c.stop.when
      }
      const finish = async (exit) => {
        if (stopWait?.status === 'open') await db.from('wf_waits').update({ status: 'cancelled', resolved_at: now, resolved_by: 'loop_finished' }).eq('id', stopWait.id).eq('status', 'open')
        await addStep(db, run, { node_id: node.id, kind: 'follow_up_loop', status: 'resolved', exit, reason: `${st.attempts} attempt${st.attempts === 1 ? '' : 's'}` }, now)
        delete loops[node.id]
        return { exit }
      }
      if (stopped) return finish('Stopped')
      if (Date.parse(st.next_at) > nowMs) return { park: { state: 'waiting', wake_at: st.next_at } }
      if (st.attempts >= Number(c.max_attempts)) return finish('Exhausted')
      const inputs = resolveInputs(c.action?.inputs || {}, run, now)
      const r = await invokeAction(db, run, node, c.action?.capability, inputs, `${node.id}#${st.attempts + 1}`, deps, now)
      if (r.hold) return { hold: r.hold }
      if (r.park) return r
      if (!r.ok) return { hold: r.reason }
      st.attempts += 1
      // After the last attempt the loop still waits one cadence for the stop signal.
      st.next_at = iso(nowMs + Number(c.cadence_hours) * HOUR)
      return { park: { state: 'waiting', wake_at: st.next_at } }
    }
    case 'transform': {
      const value = transform(c.op, resolveInputs(c.inputs || {}, run, now))
      ;(run.context.nodes ||= {})[node.id] = { value }
      return { exit: 'Next' }
    }
    case 'terminate':
      return { end: { state: 'completed', outcome: clean(c.outcome) || 'completed' } }
    default:
      return { exit: 'Next' }
  }
}

export async function stepRun(db, run, deps = {}) {
  const now = deps.now || new Date().toISOString()
  const worker = deps.worker
  const v = await loadVersion(db, run.workflow_key, run.version, deps.cache)
  const persist = async (patch) => {
    const q = db.from('wf_runs').update({ ...patch, context: run.context, lease_owner: null, lease_until: null, updated_at: now }).eq('id', run.id)
    const { error } = await (worker ? q.eq('lease_owner', worker) : q)
    if (error) throw new Error(`run_write_failed:${error.message}`)
  }
  run.context = run.context || {}
  if (!v) { await persist({ state: 'held', reason: 'version_missing', wake_at: null }); return { run_id: run.id, state: 'held', reason: 'version_missing' } }
  const wfStatus = deps.workflowStatus?.[run.workflow_key]
  if (wfStatus === 'paused' || wfStatus === 'archived') {
    await persist({ wake_at: iso(Date.parse(now) + 10 * 60_000) })
    return { run_id: run.id, state: run.state, reason: `workflow_${wfStatus}` }
  }
  const graph = v.graph
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const next = (id, exit = 'Next') => (graph.edges || []).find((e) => e.from === id && (e.exit || 'Next') === exit)?.to || null
  let cursor = run.cursor || next('trigger')
  let result = null
  let steps = 0
  try {
    while (steps++ < STEP_BUDGET) {
      const node = cursor && byId.get(cursor)
      if (!node) { result = { end: { state: 'completed', outcome: 'completed' } }; break }
      const r = await execNode(db, run, node, deps, now)
      if (r.exit) {
        const to = next(node.id, r.exit)
        if (!to) { result = { end: { state: 'completed', outcome: node.kind === 'terminate' ? clean(node.config?.outcome) || 'completed' : 'completed' } }; break }
        cursor = to
        continue
      }
      result = r
      break
    }
  } catch (e) {
    result = { hold: `runtime_error:${clean(e?.message).slice(0, 160)}` }
  }
  if (!result) result = { park: { state: 'running', wake_at: now } } // step budget: continue next tick
  if (result.end) {
    await db.from('wf_waits').update({ status: 'cancelled', resolved_at: now, resolved_by: 'run_finished' }).eq('run_id', run.id).eq('status', 'open')
    await persist({ state: result.end.state, outcome: result.end.outcome, cursor, wake_at: null, finished_at: now, reason: null })
    return { run_id: run.id, state: result.end.state, outcome: result.end.outcome }
  }
  if (result.hold) {
    await addStep(db, run, { node_id: cursor || 'trigger', kind: byId.get(cursor)?.kind || 'trigger', status: 'held', reason: result.hold }, now).catch(() => {})
    await persist({ state: 'held', reason: result.hold, cursor, wake_at: null })
    return { run_id: run.id, state: 'held', reason: result.hold }
  }
  await persist({ state: result.park.state, cursor, wake_at: result.park.wake_at ?? null, reason: result.park.reason || null })
  return { run_id: run.id, state: result.park.state, wake_at: result.park.wake_at ?? null }
}

// ── tick ───────────────────────────────────────────────────────────────────

async function ingestEvents(db, now, limit) {
  const ctl = await readControl(db, ['workflow_orchestrator_cursor'])
  if (ctl.error) return { error: ctl.error.message }
  const nowMs = Date.parse(now)
  let cursor = ctl.workflow_orchestrator_cursor ? JSON.parse(ctl.workflow_orchestrator_cursor) : null
  if (!cursor) {
    // First run starts NOW — never replays history into new workflows.
    await writeControl(db, 'workflow_orchestrator_cursor', JSON.stringify({ at: now, ids: [] }), now)
    return { events: 0, started: 0, resolved: 0, first_run: true }
  }
  let gap = null
  if (nowMs - Date.parse(cursor.at) > MAX_CATCHUP_HOURS * HOUR) {
    gap = { from: cursor.at, to: iso(nowMs - MAX_CATCHUP_HOURS * HOUR) }
    cursor = { at: gap.to, ids: [] }
  }
  const seen = new Set(cursor.ids || [])
  // Read past the already-consumed rows sharing the cursor timestamp, or a burst
  // larger than one batch at a single instant would stall the cursor forever.
  const { data, error } = await db.from('workflow_events').select('id, event_type, subject_type, subject_id, payload, created_at').gte('created_at', cursor.at).order('created_at', { ascending: true }).limit(limit + seen.size)
  if (error) return { error: error.message }
  const fresh = (data || []).filter((e) => !(e.created_at === cursor.at && seen.has(String(e.id)))).slice(0, limit)
  let started = 0
  let resolved = 0
  const cache = new Map()
  for (const e of fresh) {
    const s = await startRunsForEvent(db, e, { now, cache })
    started += s.started?.length || 0
    const d = await deliverEvent(db, e, { now })
    resolved += d.resolved || 0
  }
  if (fresh.length) {
    const lastAt = fresh[fresh.length - 1].created_at
    const ids = fresh.filter((e) => e.created_at === lastAt).map((e) => String(e.id))
    await writeControl(db, 'workflow_orchestrator_cursor', JSON.stringify({ at: lastAt, ids: lastAt === cursor.at ? [...seen, ...ids] : ids }), now)
  } else if (gap) {
    await writeControl(db, 'workflow_orchestrator_cursor', JSON.stringify(cursor), now)
  }
  return { events: fresh.length, started, resolved, gap }
}

export async function tickOrchestrator(deps = {}) {
  const db = deps.supabase
  const now = deps.now || new Date().toISOString()
  const env = deps.env || process.env
  const worker = deps.worker || `wf-${Math.random().toString(36).slice(2, 10)}`
  const ctl = await readControl(db, ['workflow_orchestrator_enabled'])
  const enabled = !ctl.error && ctl.workflow_orchestrator_enabled === 'true' && String(env.WORKFLOW_ORCHESTRATOR_ENABLED || '') === 'true'
  const summary = { at: now, enabled, worker }
  if (!enabled) {
    await writeControl(db, 'workflow_orchestrator_heartbeat_at', now, now)
    await writeControl(db, 'workflow_orchestrator_last_summary', JSON.stringify({ ...summary, skipped: 'disabled' }), now)
    return { ok: true, skipped: 'disabled' }
  }
  summary.ingest = await ingestEvents(db, now, deps.eventLimit || 200)
  const claim = await db.rpc('wf_claim_runs', { p_limit: deps.limit || 50, p_worker: worker, p_now: now, p_lease_seconds: 120 })
  if (claim.error) summary.claim_error = claim.error.message
  const runs = claim.data || []
  const wfs = await db.from('wf_workflows').select('workflow_key, status')
  const workflowStatus = Object.fromEntries((wfs.data || []).map((w) => [w.workflow_key, w.status]))
  const cache = new Map()
  const outcomes = {}
  for (const run of runs) {
    try {
      const r = await stepRun(db, run, { ...deps, env, now, worker, cache, workflowStatus })
      outcomes[r.state] = (outcomes[r.state] || 0) + 1
    } catch (e) {
      outcomes.error = (outcomes.error || 0) + 1
      summary.last_error = clean(e?.message).slice(0, 200)
    }
  }
  summary.claimed = runs.length
  summary.outcomes = outcomes
  await writeControl(db, 'workflow_orchestrator_heartbeat_at', now, now)
  await writeControl(db, 'workflow_orchestrator_last_summary', JSON.stringify(summary), now)
  return { ok: true, ...summary }
}
