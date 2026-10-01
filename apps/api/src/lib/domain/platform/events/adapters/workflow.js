/**
 * WORKFLOW adapter — the Workflow Observatory, read through its own runtime
 * adapters (the same loads, activity filters, statuses, results and reasons
 * Workflow Studio shows). One envelope per automation RUN at its start:
 * "Seller conversation · Jane D. — Reply drafted, awaiting approval".
 *
 *   seller_inbound      every run (one per inbound seller message)
 *   campaign_execution  exceptions only (stalled / start missed / failed) — the
 *                       lifecycle itself is the campaigns adapter's
 *   email_dispatch      every send attempt (email.sent / email.failed)
 *   studio (wf_runs)    every run
 * Not projected (another ledger owns the fact, or it is background):
 * queue_dispatch (= message_events), notifications, event bridge, reconcilers,
 * opt-out / negotiation / decision sub-flows (lead_state + pipeline own them).
 *
 * Replay of a workflow run (subject workflow = "<workflow_key>:<run_id>")
 * projects the run's own timeline (getRun) as workflow.step events.
 */
import { SYSTEM_ADAPTERS, REGISTRY } from '@/lib/domain/workflow-studio/observatory/registry.js'
import { studioAdapter } from '@/lib/domain/workflow-studio/observatory/adapters/studio.js'
import { getRun } from '@/lib/domain/workflow-studio/observatory/service.js'
import { canonicalTime, envelope, links, refs, humanize, capFirst } from '../envelope.js'
import { cmpKey } from '../keyset.js'

const GLOBAL_KEYS = ['seller_inbound', 'campaign_execution', 'email_dispatch']
const EXCEPTION_ONLY = { campaign_execution: new Set(['needs_you', 'held', 'failed']) }
const DAY = 864e5

function typeOf(key, status) {
  if (key === 'email_dispatch') return status === 'failed' ? 'email.failed' : status === 'completed' ? 'email.sent' : status === 'needs_you' || status === 'held' ? 'workflow.held' : 'workflow.waiting'
  if (status === 'needs_you' || status === 'held') return 'workflow.held'
  if (status === 'failed') return 'workflow.failed'
  if (status === 'waiting' || status === 'running') return 'workflow.waiting'
  return 'workflow.completed'
}

const subjectRefs = (s, raw) => {
  if (!s?.id) return []
  if (s.kind === 'seller') return [refs.seller(s.id, s.name), refs.property(raw?.property_id, s.address)]
  if (s.kind === 'campaign') return [refs.campaign(s.id, s.name)]
  if (s.kind === 'closing') return [refs.closing(s.id, s.address)]
  return []
}

/** Pure: one observed run → envelope. */
export function workflowRunEvent(o, { workflowKey, workflowName }) {
  const r = o.run
  const type = typeOf(workflowKey, r.status)
  const s = r.subject || null
  const who = s?.name || s?.address || null
  return envelope({
    event_id: `wf:${workflowKey}:${r.run_id}`, occurred_at: r.started_at,
    source_system: workflowKey === 'email_dispatch' ? 'email' : 'workflow', event_type: type,
    severity: type === 'workflow.held' ? 'attention' : type === 'workflow.failed' || type === 'email.failed' ? 'warning' : 'info',
    actor: { kind: 'automation', label: workflowName },
    entity_refs: [...subjectRefs(s, o.raw), refs.workflow(workflowKey, r.run_id, workflowName)],
    thread_key: s?.kind === 'seller' ? s.id : null, property_id: o.raw?.property_id || null, campaign_id: s?.kind === 'campaign' ? s.id : null, closing_id: s?.kind === 'closing' ? s.id : null,
    workflow_run_id: r.run_id,
    summary: `${workflowName}${who ? ` · ${who}` : ''} — ${r.result || r.status_label || humanize(r.status)}`,
    details: {
      workflow_key: workflowKey, status: r.status, result: r.result || null, reason: r.reason || null, trigger: r.trigger || null,
      focus_node: r.current_node || r.final_node || null, needs_you: Boolean(r.human) || r.status === 'needs_you',
      finished_at: r.finished_at || null, steps: Array.isArray(o.events) ? o.events.length : null,
      // deterministic causal link: the inbound message this run handled
      source_message_id: o.raw?.source_message_id || null,
      facts: Array.isArray(o.facts) ? o.facts.slice(0, 6) : null,
    },
    deep_link: links.run(workflowKey, r.run_id),
    provenance: { table: workflowKey === 'seller_inbound' ? 'seller_automation_executions' : workflowKey === 'email_dispatch' ? 'email_queue' : workflowKey === 'campaign_execution' ? 'campaign_events' : 'wf_runs', row_id: r.run_id, adapter: 'workflow', ledger: `observatory:${workflowKey}` },
  })
}

/** Pure: one step of a run's timeline → workflow.step envelope (replay of one run). */
export function workflowStepEvent(e, { workflowKey, runId, workflowName, subject = null }) {
  const st = String(e.status || '').toLowerCase()
  return envelope({
    event_id: `wfs:${workflowKey}:${runId}:${e.event_id}`, occurred_at: e.occurred_at, source_system: 'workflow', event_type: 'workflow.step',
    severity: st === 'failed' ? 'warning' : ['held', 'blocked', 'human', 'needs_review'].includes(st) ? 'attention' : 'info',
    actor: { kind: 'automation', label: workflowName },
    entity_refs: [...subjectRefs(subject, null), refs.workflow(workflowKey, runId, workflowName)],
    workflow_run_id: runId,
    summary: `${capFirst(humanize(e.node_key || e.event_type))}${e.label ? ` · ${e.label}` : ''}${e.reason_code ? ` · ${humanize(e.reason_code)}` : ''}`,
    details: { node_key: e.node_key || null, status: e.status || null, step_type: e.event_type || null, duration_ms: e.duration_ms ?? null, source_ref: e.source_ref || null },
    deep_link: `/workflow-studio?studio=${encodeURIComponent(workflowKey)}&run=${encodeURIComponent(runId)}${e.node_key ? `&node=${encodeURIComponent(e.node_key)}` : ''}`,
    provenance: { table: 'observatory_timeline', row_id: e.event_id, adapter: 'workflow', ledger: `observatory:${workflowKey}` },
  })
}

const nameOf = (key) => { const r = REGISTRY.find((x) => x.workflow_key === key); return r?.short_name || r?.name || humanize(key) }
const keep = (e, scope) => e && (!scope.cursor || cmpKey({ t: e.occurred_at, id: e.event_id }, scope.cursor) < 0) && (!scope.since || e.occurred_at >= scope.since)

export const workflowAdapter = {
  name: 'workflow',
  table: 'observatory',
  systems: ['workflow', 'email'],
  types: ['workflow.completed', 'workflow.waiting', 'workflow.held', 'workflow.failed', 'workflow.step', 'email.sent', 'email.failed'],
  supports: (subject) => !subject || ['seller', 'property', 'workflow'].includes(subject.type),

  async read(scope, { db, now, observatory = {} }) {
    const adapters = observatory.adapters || SYSTEM_ADAPTERS
    const studio = observatory.studio || studioAdapter
    const run = observatory.getRun || getRun
    const degraded = []
    const { subject } = scope

    if (subject?.type === 'workflow') {
      const d = await run(subject.workflow_key, subject.run_id, { supabase: db })
      if (!d?.ok) return { events: [], complete_above: null }
      const wname = nameOf(subject.workflow_key)
      const o = { run: d.run, events: d.timeline || [], raw: null, facts: d.facts }
      const events = [workflowRunEvent(o, { workflowKey: subject.workflow_key, workflowName: wname }),
        ...(d.timeline || []).map((e) => workflowStepEvent(e, { workflowKey: subject.workflow_key, runId: subject.run_id, workflowName: wname, subject: d.run?.subject }))]
      return { events: events.filter((e) => keep(e, scope)), complete_above: null }
    }

    const untilIso = scope.cursor ? new Date(Date.parse(scope.cursor.t) + 1).toISOString() : scope.until || null
    const sinceIso = scope.since || new Date(now - 7 * DAY).toISOString()
    const events = []
    let complete_above = null
    const note = (observed, key, cap) => {
      if (observed.length < cap) return
      const oldest = observed.map((o) => canonicalTime(o.run.started_at)).filter(Boolean).sort()[0]
      if (oldest) { const k = { t: oldest, id: `wf:${key}:` }; complete_above = !complete_above || cmpKey(k, complete_above) > 0 ? k : complete_above }
    }

    if (subject) {
      // seller / property: that conversation's own runs, through the seller adapter's detail
      const seller = adapters.seller_inbound
      if (!seller || (!subject.thread_keys.length && !subject.property_ids.length)) return { events: [], complete_above: null }
      const CAP = 25
      let q = db.from('seller_automation_executions').select('id, started_at')
      q = subject.thread_keys.length ? q.in('thread_id', subject.thread_keys) : q.in('property_id', subject.property_ids)
      q = q.gte('started_at', sinceIso)
      if (untilIso) q = q.lt('started_at', untilIso)
      const { data, error } = await q.order('started_at', { ascending: false }).limit(CAP)
      if (error) throw error
      const details = await Promise.all((data || []).map((x) => seller.detail(db, x.id, { degraded }).catch(() => null)))
      const observed = details.filter(Boolean)
      for (const o of observed) { const e = workflowRunEvent(o, { workflowKey: 'seller_inbound', workflowName: nameOf('seller_inbound') }); if (keep(e, scope)) events.push(e) }
      if ((data || []).length >= CAP) note((data || []).map((x) => ({ run: { started_at: x.started_at } })), 'seller_inbound', CAP)
      return { events, complete_above }
    }

    const cap = Math.min(400, Math.max(60, scope.limit * 2))
    await Promise.all(GLOBAL_KEYS.map(async (key) => {
      const a = adapters[key]
      if (!a) return
      const observed = await a.load(db, { since: sinceIso, until: untilIso, limit: cap, degraded })
      const only = EXCEPTION_ONLY[key]
      for (const o of observed) {
        if (a.activityFilter && !a.activityFilter(o)) continue
        if (only && !only.has(o.run.status)) continue
        const e = workflowRunEvent(o, { workflowKey: key, workflowName: nameOf(key) })
        if (keep(e, scope)) events.push(e)
      }
      note(observed, key, cap)
    }))
    const wfs = await studio.workflows(db, { degraded })
    for (const w of wfs || []) {
      const observed = await studio.load(db, w.workflow_key, { since: sinceIso, limit: cap, degraded })
      for (const o of observed) { const e = workflowRunEvent(o, { workflowKey: w.workflow_key, workflowName: w.name || w.workflow_key }); if (keep(e, scope)) events.push(e) }
      note(observed, w.workflow_key, cap)
    }
    if (degraded.length) {
      // a ledger the observatory could not read must not pass for "nothing happened"
      if (!events.length) throw new Error(`observatory degraded: ${[...new Set(degraded)].join(', ')}`)
    }
    return { events, complete_above, degraded_parts: [...new Set(degraded)] }
  },
}
