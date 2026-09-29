/**
 * WORKFLOW STUDIO — leads in flight, live activity, studio workflows.
 *
 * Read-only projections over each runtime's own records:
 *   leads     latest seller run per conversation (7d) + orchestrator runs +
 *             live closings, each with the step it is on and one state
 *   activity  a merged, time-ordered feed: seller-brain moments, real send
 *             outcomes from send_queue (campaign sends grouped per hour),
 *             orchestrator steps, closing activity
 *   studio    orchestrator workflows with version, reach and live run counts
 * A source that fails to read is reported in `degraded`, never shown as empty.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { hydrateSellerRuns, openThreads, HELD_REASON } from './observatory-service.js'
import { describeGraph, outlineGraph } from './orchestrator/graph.js'
import { BLUEPRINTS } from './orchestrator/definitions.js'
import { CAPABILITIES } from './orchestrator/capabilities.js'

const clean = (v) => String(v ?? '').trim()
const H = 3600e3
const DAY = 24 * H
const iso = (ms) => new Date(ms).toISOString()
const human = (v) => clean(v).replace(/_/g, ' ')
const missing = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || ''))

const STATE_ORDER = { needs_you: 0, failed: 1, waiting: 2, held: 3, running: 4, done: 5 }

async function namesFor(db, threads, props) {
  const t = [...new Set(threads.filter(Boolean))]
  const a = t.length ? await db.from('inbox_thread_state').select('thread_key, seller_display_name, property_id').in('thread_key', t.slice(0, 500)) : { data: [] }
  const threadProp = new Map((a.data || []).map((r) => [r.thread_key, r.property_id || null]))
  const p = [...new Set([...props, ...threadProp.values()].filter(Boolean).map(String))]
  const b = p.length ? await db.from('properties').select('property_id, property_address_full, property_address').in('property_id', p.slice(0, 800)) : { data: [] }
  const addr = new Map((b.data || []).map((r) => [String(r.property_id), r.property_address_full || r.property_address || null]))
  return {
    name: new Map((a.data || []).map((r) => [r.thread_key, r.seller_display_name || null])),
    threadAddr: new Map([...threadProp].map(([k, pid]) => [k, pid ? addr.get(String(pid)) || null : null])),
    addr: { get: (pid) => (pid ? addr.get(String(pid)) || null : null) },
  }
}

/* ── studio (orchestrator) workflows ──────────────────────────────────────── */

export function reachOf(graph = {}) {
  const caps = (graph.nodes || []).flatMap((n) => [n.config?.capability, n.config?.action?.capability]).filter(Boolean)
  if (caps.some((c) => ['outbound.send_sms', 'email.send', 'seller.schedule_follow_up'].includes(c))) return 'seller'
  if (caps.some((c) => c === 'notify.operator')) return 'operator'
  return 'internal'
}

export async function getStudioWorkflows(deps = {}) {
  const db = deps.supabase || defaultSupabase
  const [wfs, versions, runs] = await Promise.all([
    db.from('wf_workflows').select('*').order('created_at', { ascending: true }),
    db.from('wf_versions').select('workflow_key, version, graph, description, published_by, published_at, change_note').order('version', { ascending: false }).limit(500),
    db.from('wf_runs').select('workflow_key, state, outcome, started_at').gte('started_at', iso(Date.now() - 30 * DAY)).limit(5000),
  ])
  if (missing(wfs.error)) return { ok: true, available: false, workflows: [] }
  if (wfs.error) throw wfs.error
  const latest = new Map()
  for (const v of versions.data || []) if (!latest.has(v.workflow_key)) latest.set(v.workflow_key, v)
  const byWf = new Map()
  for (const r of runs.data || []) (byWf.get(r.workflow_key) || byWf.set(r.workflow_key, []).get(r.workflow_key)).push(r)
  return {
    ok: true,
    available: true,
    workflows: (wfs.data || []).map((w) => {
      const v = latest.get(w.workflow_key)
      const rs = byWf.get(w.workflow_key) || []
      return {
        key: w.workflow_key,
        name: w.name,
        domain: w.domain,
        status: w.status,
        version: w.live_version,
        latest_version: v?.version ?? null,
        description: v?.description || null,
        reach: v ? reachOf(v.graph) : 'internal',
        trigger: v?.graph?.trigger?.type || null,
        blueprint: v?.graph?.blueprint || null,
        outline: v ? outlineGraph(v.graph) : [],
        nodes: v ? v.graph.nodes.filter((n) => n.kind !== 'annotation').map((n) => ({ id: n.id, kind: n.kind, label: n.label || n.id })) : [],
        published_by: v?.published_by || null,
        published_at: v?.published_at || null,
        runs: {
          live: rs.filter((r) => ['running', 'waiting', 'awaiting_approval', 'held'].includes(r.state)).length,
          needs_you: rs.filter((r) => ['awaiting_approval', 'held'].includes(r.state)).length,
          completed_30d: rs.filter((r) => r.state === 'completed').length,
          outcomes: rs.reduce((a, r) => { if (r.outcome) a[r.outcome] = (a[r.outcome] || 0) + 1; return a }, {}),
        },
      }
    }),
  }
}

export async function getStudioWorkflow(key, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const [{ data: w, error }, { data: vs }, { data: runs }] = await Promise.all([
    db.from('wf_workflows').select('*').eq('workflow_key', key).maybeSingle(),
    db.from('wf_versions').select('version, graph, description, published_by, published_at, change_note').eq('workflow_key', key).order('version', { ascending: false }).limit(20),
    db.from('wf_runs').select('id, version, subject_kind, subject_id, state, cursor, wake_at, outcome, reason, started_at, updated_at, finished_at, context').eq('workflow_key', key).order('started_at', { ascending: false }).limit(60),
  ])
  if (missing(error)) return { ok: false, status: 404, error: 'orchestrator_not_installed' }
  if (!w) return { ok: false, status: 404, error: 'not_found' }
  const live = (vs || []).find((v) => v.version === w.live_version) || (vs || [])[0]
  const rs = runs || []
  const nm = await namesFor(db, rs.map((r) => r.context?.trigger?.thread_key), rs.map((r) => r.context?.trigger?.property_id))
  const nodeLabel = new Map((live?.graph?.nodes || []).map((n) => [n.id, n.label || n.id]))
  return {
    ok: true,
    workflow: {
      key: w.workflow_key, name: w.name, domain: w.domain, status: w.status, reentry: w.reentry, version: w.live_version,
      description: live?.description || null, reach: live ? reachOf(live.graph) : 'internal', trigger: live?.graph?.trigger?.type || null,
      outline: live ? outlineGraph(live.graph) : [], graph: live?.graph || null,
      capabilities: [...new Set((live?.graph?.nodes || []).map((n) => n.config?.capability || n.config?.action?.capability).filter(Boolean))].map((c) => ({ key: c, label: CAPABILITIES[c]?.label || c, policy: CAPABILITIES[c]?.policy || null })),
    },
    versions: (vs || []).map((v) => ({ version: v.version, published_by: v.published_by, published_at: v.published_at, note: v.change_note, description: v.description })),
    runs: rs.map((r) => ({
      id: r.id, version: r.version, state: r.state, outcome: r.outcome, reason: r.reason, wake_at: r.wake_at, started_at: r.started_at, finished_at: r.finished_at,
      step: r.cursor ? nodeLabel.get(r.cursor) || r.cursor : null,
      subject: { kind: r.subject_kind, id: r.subject_id, name: nm.name.get(r.context?.trigger?.thread_key) || null, address: nm.addr.get(r.context?.trigger?.property_id) || nm.threadAddr.get(r.context?.trigger?.thread_key) || null, thread_key: r.context?.trigger?.thread_key || null },
    })),
  }
}

export async function getStudioRun(key, id, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const [{ data: r }, { data: steps }, { data: waits }] = await Promise.all([
    db.from('wf_runs').select('*').eq('id', id).eq('workflow_key', key).maybeSingle(),
    db.from('wf_run_steps').select('node_id, kind, status, exit, reason, preview, capability, outputs, attempt, at').eq('run_id', id).order('id', { ascending: true }).limit(200),
    db.from('wf_waits').select('node_id, kind, event_type, title, timeout_at, status, resolution, resolved_by, resolved_at').eq('run_id', id),
  ])
  if (!r) return { ok: false, status: 404, error: 'not_found' }
  const { data: v } = await db.from('wf_versions').select('graph, description').eq('workflow_key', key).eq('version', r.version).maybeSingle()
  const graph = v?.graph || { nodes: [], edges: [] }
  const nm = await namesFor(db, [r.context?.trigger?.thread_key], [r.context?.trigger?.property_id])
  const byNode = new Map()
  for (const s of steps || []) byNode.set(s.node_id.split('#')[0], s)
  const label = (id2) => graph.nodes.find((n) => n.id === id2)?.label || id2
  return {
    ok: true,
    run: { id: r.id, workflow_key: key, version: r.version, state: r.state, outcome: r.outcome, reason: r.reason, wake_at: r.wake_at, started_at: r.started_at, finished_at: r.finished_at, cursor: r.cursor, trigger_event_type: r.trigger_event_type },
    subject: { name: nm.name.get(r.context?.trigger?.thread_key) || null, address: nm.addr.get(r.context?.trigger?.property_id) || nm.threadAddr.get(r.context?.trigger?.thread_key) || null, thread_key: r.context?.trigger?.thread_key || null, property_id: r.context?.trigger?.property_id || null },
    path: graph.nodes.filter((n) => n.kind !== 'annotation').map((n) => {
      const s = byNode.get(n.id)
      const passed = s?.status === 'waiting' && r.cursor !== n.id
      return { id: n.id, kind: n.kind, label: n.label || n.id, status: passed ? 'resolved' : s ? s.status : r.cursor === n.id && !['completed', 'cancelled', 'failed'].includes(r.state) ? 'current' : 'untouched', exit: s?.exit || null, at: s?.at || null, reason: s?.reason || null }
    }),
    timeline: (steps || []).map((s) => ({ at: s.at, node: s.node_id, label: label(s.node_id.split('#')[0]) + (s.node_id.includes('#') ? ` · attempt ${s.node_id.split('#')[1]}` : ''), status: s.status, exit: s.exit, reason: s.reason, capability: s.capability, outputs: s.outputs })),
    waits: waits || [],
    description: v?.description || null,
    links: { conversation: r.context?.trigger?.thread_key ? `/inbox?thread=${encodeURIComponent(r.context.trigger.thread_key)}` : null },
  }
}

/* ── leads in flight ──────────────────────────────────────────────────────── */

const leadStateFromSeller = (run, open) => {
  if (run.state === 'needs_operator') return open ? 'needs_you' : 'done'
  if (run.state === 'failed') return 'failed'
  if (run.state === 'waiting') return 'waiting'
  if (run.state === 'held') return open ? 'held' : 'done'
  return 'done'
}
const leadStateFromOrch = (s) => ({ running: 'running', waiting: 'waiting', awaiting_approval: 'needs_you', held: 'needs_you', completed: 'done', cancelled: 'done', failed: 'failed' }[s] || 'done')

export async function getStudioLeads(deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const degraded = []
  const leads = []

  const { data: execs, error: eErr } = await db.from('seller_automation_executions').select('id, workflow_id, status, thread_id, property_id, lifecycle_stage, started_at').gte('started_at', iso(now - 7 * DAY)).order('started_at', { ascending: false }).limit(600)
  if (eErr) degraded.push('seller_inbound')
  const latest = new Map()
  for (const e of execs || []) if (e.thread_id && !latest.has(e.thread_id)) latest.set(e.thread_id, e)
  const runsPerThread = new Map()
  for (const e of execs || []) runsPerThread.set(e.thread_id, (runsPerThread.get(e.thread_id) || 0) + 1)
  const sellerRuns = await hydrateSellerRuns(db, [...latest.values()].slice(0, 200))
  const open = await openThreads(db, sellerRuns.map((r) => r.subject.thread_key))
  for (const r of sellerRuns) {
    const state = leadStateFromSeller(r, open.has(r.subject.thread_key))
    leads.push({
      id: `seller:${r.id}`, run_id: r.id, workflow: 'seller_inbound', workflow_name: 'Seller Conversation',
      subject: { name: r.subject.name, address: r.subject.address, thread_key: r.subject.thread_key, property_id: r.subject.property_id },
      state, label: r.label, reason: r.reason, stage: r.stage ? human(r.stage) : null, at: r.started_at, runs_7d: runsPerThread.get(r.subject.thread_key) || 1,
      step: state === 'needs_you' ? 'Waiting on you' : state === 'waiting' ? r.label : state === 'held' ? 'Held by policy' : state === 'failed' ? 'Send failed' : 'Handled',
      link: r.subject.thread_key ? `/inbox?thread=${encodeURIComponent(r.subject.thread_key)}` : null,
    })
  }

  const { data: wr, error: wErr } = await db.from('wf_runs').select('id, workflow_key, version, state, cursor, wake_at, outcome, reason, started_at, updated_at, context').order('updated_at', { ascending: false }).limit(150)
  if (wErr && !missing(wErr)) degraded.push('orchestrator')
  if (wr?.length) {
    const keys = [...new Set(wr.map((r) => r.workflow_key))]
    const [{ data: wfs }, { data: vs }] = await Promise.all([
      db.from('wf_workflows').select('workflow_key, name').in('workflow_key', keys),
      db.from('wf_versions').select('workflow_key, version, graph').in('workflow_key', keys).limit(200),
    ])
    const wfName = new Map((wfs || []).map((w) => [w.workflow_key, w.name]))
    const graphOf = new Map((vs || []).map((v) => [`${v.workflow_key}@${v.version}`, v.graph]))
    const nm = await namesFor(db, wr.map((r) => r.context?.trigger?.thread_key), wr.map((r) => r.context?.trigger?.property_id))
    for (const r of wr) {
      const g = graphOf.get(`${r.workflow_key}@${r.version}`)
      const node = g?.nodes?.find((n) => n.id === r.cursor)
      const state = leadStateFromOrch(r.state)
      const tk = r.context?.trigger?.thread_key || null
      leads.push({
        id: `wf:${r.id}`, run_id: r.id, workflow: r.workflow_key, workflow_name: wfName.get(r.workflow_key) || human(r.workflow_key), studio: true,
        subject: { name: nm.name.get(tk) || null, address: nm.addr.get(r.context?.trigger?.property_id) || nm.threadAddr.get(tk) || null, thread_key: tk, property_id: r.context?.trigger?.property_id || null },
        state, label: r.state === 'completed' ? human(r.outcome || 'completed') : r.state === 'awaiting_approval' ? 'Awaiting your approval' : r.state === 'held' ? 'Held' : r.state === 'waiting' ? `Waiting · ${node?.label || 'next step'}` : human(r.state),
        reason: r.reason ? human(r.reason.split(':')[0]) : null, at: r.updated_at || r.started_at, wake_at: r.wake_at,
        step: node?.label || (r.state === 'completed' ? `Finished · ${human(r.outcome || '')}` : null),
        link: tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null,
      })
    }
  }

  const { data: cases, error: cErr } = await db.from('closing_cases').select('closing_case_id, property_address, contract_status, terminal_outcome, closed_at, automation_paused_at, automation_state, title_acknowledged_at, title_commitment_received_at, clear_to_close_at, updated_at, provenance').limit(200)
  if (cErr) degraded.push('closing_execution')
  for (const c of (cases || []).filter((x) => !x.terminal_outcome && !x.closed_at && !x.provenance?.voided)) {
    const esc = Object.keys(c.automation_state?.escalations || {}).length
    const step = clean(c.contract_status).toLowerCase() !== 'fully_executed' ? 'Waiting for executed contract' : !c.title_acknowledged_at ? 'Waiting on title acknowledgement' : !c.title_commitment_received_at ? 'Waiting on title commitment' : !c.clear_to_close_at ? 'Waiting for clear to close' : 'Waiting for settlement'
    leads.push({ id: `closing:${c.closing_case_id}`, run_id: c.closing_case_id, workflow: 'closing_execution', workflow_name: 'Closing Execution', subject: { name: null, address: c.property_address }, state: esc ? 'needs_you' : c.automation_paused_at ? 'held' : 'running', label: esc ? 'Escalated — counterparty silent' : step, reason: null, at: c.updated_at, step, link: `/closing-desk?case=${encodeURIComponent(c.closing_case_id)}` })
  }

  leads.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(b.at).localeCompare(String(a.at)))
  const counts = { all: leads.length }
  for (const s of Object.keys(STATE_ORDER)) counts[s] = leads.filter((l) => l.state === s).length
  const byWorkflow = {}
  for (const l of leads) {
    const w = (byWorkflow[l.workflow] ||= { workflow: l.workflow, name: l.workflow_name, total: 0, active: 0, needs_you: 0 })
    w.total++
    if (l.state !== 'done') w.active++
    if (l.state === 'needs_you') w.needs_you++
  }
  return { ok: true, window_days: 7, leads, counts, by_workflow: Object.values(byWorkflow), degraded, generated_at: iso(now) }
}

/* ── live activity ────────────────────────────────────────────────────────── */

const DONE = {
  'notify.operator': 'Operator alerted',
  'seller.schedule_follow_up': 'Follow-up scheduled',
  'seller.cancel_follow_ups': 'Pending follow-ups withdrawn',
  'seller.set_next_action': 'Next action set',
  'outbound.send_sms': 'SMS queued (approved)',
  'closing.request_email': 'Closing email requested',
  'closing.pause_automation': 'Closing automation paused',
  'campaign.pause': 'Campaign paused',
  'campaign.resume': 'Campaign resumed',
  'pipeline.request_transition': 'Stage change requested',
  'deal.ensure_decision': 'Deal decision refreshed',
  'email.send': 'Email queued',
}

const SELLER_MOMENTS = {
  inbound_message_received: { kind: 'inbound', title: 'Seller replied', tone: 'cobalt' },
  ownership_confirmed: { kind: 'milestone', title: 'Ownership confirmed', tone: 'good' },
  seller_interest_detected: { kind: 'milestone', title: 'Seller interested', tone: 'good' },
  asking_price_extracted: { kind: 'milestone', title: 'Asking price captured', tone: 'good' },
  stage_advanced: { kind: 'stage', title: 'Stage advanced', tone: 'violet' },
  needs_review_created: { kind: 'attention', title: 'Needs your review', tone: 'gold' },
  automation_blocked: { kind: 'held', title: 'Auto-reply held', tone: 'muted' },
  follow_up_scheduled: { kind: 'scheduled', title: 'Follow-up scheduled', tone: 'teal' },
}

export async function getStudioActivity({ hours = 48, limit = 80 } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const since = iso(now - Math.min(Number(hours) || 48, 168) * H)
  const degraded = []
  const items = []

  const { data: steps, error: sErr } = await db.from('seller_automation_execution_steps').select('id, execution_id, action_key, execution_status, block_reason, output_summary, thread_id, property_id, created_at').in('action_key', Object.keys(SELLER_MOMENTS)).gte('created_at', since).order('created_at', { ascending: false }).limit(300)
  if (sErr) degraded.push('seller_inbound')
  const { data: sends, error: qErr } = await db.from('send_queue').select('id, queue_status, sent_at, delivered_at, failed_reason, thread_key, seller_display_name, property_address, property_id, campaign_id, source, updated_at').or(`sent_at.gte.${since},and(queue_status.like.failed%,updated_at.gte.${since})`).order('updated_at', { ascending: false }).limit(1000)
  if (qErr) degraded.push('send_queue')
  const { data: wsteps, error: wErr } = await db.from('wf_run_steps').select('id, run_id, node_id, kind, status, exit, reason, capability, at').gte('at', since).order('id', { ascending: false }).limit(200)
  if (wErr && !missing(wErr)) degraded.push('orchestrator')
  const { data: cact, error: cErr } = await db.from('closing_activity_events').select('id, closing_case_id, event_type, actor, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(60)
  if (cErr) degraded.push('closing_execution')

  const threads = [...(steps || []).map((s) => s.thread_id), ...(sends || []).map((s) => s.thread_key)]
  const props = (steps || []).map((s) => s.property_id)
  let runs = []
  if (wsteps?.length) {
    const { data } = await db.from('wf_runs').select('id, workflow_key, version, context').in('id', [...new Set(wsteps.map((s) => s.run_id))])
    runs = data || []
    for (const r of runs) { threads.push(r.context?.trigger?.thread_key); props.push(r.context?.trigger?.property_id) }
  }
  const nm = await namesFor(db, threads, props)
  const who = (tk, pid) => ({ name: nm.name.get(tk) || null, address: nm.addr.get(pid) || nm.threadAddr.get(tk) || null, thread_key: tk || null })

  for (const s of steps || []) {
    const m = SELLER_MOMENTS[s.action_key]
    let detail = null
    if (s.action_key === 'stage_advanced' && s.output_summary?.stage_after) detail = `${human(s.output_summary.stage_before) || '—'} → ${human(s.output_summary.stage_after)}`
    if (s.action_key === 'automation_blocked') detail = HELD_REASON[clean(s.block_reason).toLowerCase()] || human(s.block_reason)
    if (s.action_key === 'follow_up_scheduled' && s.output_summary?.follow_up_at) detail = `for ${new Date(s.output_summary.follow_up_at).toISOString().slice(0, 10)}`
    items.push({ id: `s:${s.id}`, at: s.created_at, workflow: 'seller_inbound', workflow_name: 'Seller Conversation', ...m, detail, subject: who(s.thread_id, s.property_id), link: s.thread_id ? `/inbox?thread=${encodeURIComponent(s.thread_id)}` : null, run_id: s.execution_id })
  }

  const campaignHours = new Map()
  for (const q of sends || []) {
    const failed = clean(q.queue_status).startsWith('failed')
    const at = failed ? q.updated_at : q.delivered_at || q.sent_at
    if (!at) continue
    if (q.campaign_id && !failed) {
      const k = `${q.campaign_id}|${String(at).slice(0, 13)}`
      const g = campaignHours.get(k) || { campaign_id: q.campaign_id, at, sent: 0, delivered: 0 }
      g.sent++
      if (q.queue_status === 'delivered') g.delivered++
      if (at > g.at) g.at = at
      campaignHours.set(k, g)
      continue
    }
    items.push({
      id: `q:${q.id}`, at, workflow: q.campaign_id ? 'campaign_execution' : 'seller_inbound', workflow_name: q.campaign_id ? 'Campaign Execution' : 'Seller Conversation',
      kind: failed ? 'failed' : 'sent', tone: failed ? 'bad' : 'good',
      title: failed ? 'Message failed' : q.queue_status === 'delivered' ? 'Reply delivered' : 'Reply sent',
      detail: failed ? human(q.failed_reason || q.queue_status) : null,
      subject: { name: q.seller_display_name || nm.name.get(q.thread_key) || null, address: q.property_address || nm.threadAddr.get(q.thread_key) || null, thread_key: q.thread_key || null },
      link: q.thread_key ? `/inbox?thread=${encodeURIComponent(q.thread_key)}` : null,
    })
  }
  if (campaignHours.size) {
    const ids = [...new Set([...campaignHours.values()].map((g) => g.campaign_id))]
    const { data: cs } = await db.from('campaigns').select('id, name').in('id', ids)
    const cname = new Map((cs || []).map((c) => [c.id, c.name]))
    for (const [k, g] of campaignHours) items.push({ id: `c:${k}`, at: g.at, workflow: 'campaign_execution', workflow_name: 'Campaign Execution', kind: 'campaign', tone: 'violet', title: `${g.sent} campaign message${g.sent === 1 ? '' : 's'} sent`, detail: g.delivered ? `${g.delivered} delivered` : null, subject: { name: cname.get(g.campaign_id) || 'Campaign', address: null }, link: `/campaigns?campaign=${encodeURIComponent(g.campaign_id)}` })
  }

  const runBy = new Map(runs.map((r) => [r.id, r]))
  if (wsteps?.length) {
    const keys = [...new Set(runs.map((r) => r.workflow_key))]
    const [{ data: wfs }, { data: vs }] = await Promise.all([
      db.from('wf_workflows').select('workflow_key, name').in('workflow_key', keys),
      db.from('wf_versions').select('workflow_key, version, graph').in('workflow_key', keys).limit(200),
    ])
    const wfName = new Map((wfs || []).map((w) => [w.workflow_key, w.name]))
    const graphOf = new Map((vs || []).map((v) => [`${v.workflow_key}@${v.version}`, v.graph]))
    for (const s of wsteps) {
      const r = runBy.get(s.run_id)
      if (!r) continue
      const node = graphOf.get(`${r.workflow_key}@${r.version}`)?.nodes?.find((n) => n.id === s.node_id.split('#')[0])
      const tk = r.context?.trigger?.thread_key
      const title = s.status === 'succeeded' ? (DONE[s.capability] || node?.label || CAPABILITIES[s.capability]?.label || 'Action taken') : s.status === 'waiting' ? `Waiting · ${node?.label || s.node_id}` : s.status === 'resolved' ? `${node?.label || s.node_id} → ${s.exit}` : s.status === 'held' ? 'Run held' : `${node?.label || s.node_id} · ${s.status}`
      items.push({ id: `w:${s.id}`, at: s.at, workflow: r.workflow_key, workflow_name: wfName.get(r.workflow_key) || human(r.workflow_key), studio: true, kind: s.status === 'succeeded' ? 'action' : s.status === 'held' || s.status === 'failed' ? 'attention' : 'step', tone: s.status === 'succeeded' ? 'good' : s.status === 'held' || s.status === 'failed' ? 'gold' : 'teal', title, detail: s.status === 'held' ? human(clean(s.reason).split(':')[0]) : null, subject: who(tk, r.context?.trigger?.property_id), link: tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null, run_id: s.run_id })
    }
  }

  for (const e of cact || []) items.push({ id: `k:${e.id}`, at: e.created_at, workflow: 'closing_execution', workflow_name: 'Closing Execution', kind: 'closing', tone: 'violet', title: human(e.event_type).replace(/^./, (x) => x.toUpperCase()), detail: e.actor ? `by ${e.actor}` : null, subject: { name: null, address: null }, link: `/closing-desk?case=${encodeURIComponent(e.closing_case_id)}` })

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const out = items.slice(0, Math.min(Number(limit) || 80, 200))
  const lastHour = items.filter((i) => Date.parse(i.at) > now - H).length
  return { ok: true, window_hours: Math.min(Number(hours) || 48, 168), items: out, pulse: { last_hour: lastHour, last_24h: items.filter((i) => Date.parse(i.at) > now - DAY).length }, degraded, generated_at: iso(now) }
}

export function blueprintCatalog() {
  return Object.entries(BLUEPRINTS).map(([key, b]) => ({ key, name: b.name, domain: b.domain, reach: b.reach, icon: b.icon, summary: b.summary, params: b.params }))
}
export { describeGraph }
