/**
 * EXCEPTION QUEUE — what needs a person, each item linked to the exact
 * workflow, run, node and subject, with the canonical reason, its age, the app
 * that owns the decision and the operator actions that authority allows.
 *
 *   human_review   the runtime stopped and asked for a human read
 *   approval       a drafted action waits for an operator's release
 *   failed         a run failed (individually when a person is waiting on it,
 *                  aggregated by reason when it is transport noise)
 *   stalled        a runtime keeps trying and placing nothing
 *   stale_wait     something past due that its runtime has not picked up
 *   missing_data   a run held because the data it needs is not there
 *   degraded       a runtime's own heartbeat went stale
 *
 * A healthy wait is never an exception. Nothing here writes; the actions are
 * links into the owning app or the existing orchestrator action API.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { DAY, iso, human } from './core.js'
import { REGISTRY, SYSTEM_ADAPTERS } from './registry.js'
import { studioAdapter } from './adapters/studio.js'
import { inChunksPaged, lower, paged, safe } from './adapters/shared.js'
import { isTestRow } from './adapters/queue.js'
import { runtimeHealth, RUNTIME_BEATS } from './service.js'

export const EXCEPTION_CATEGORIES = Object.freeze([
  { key: 'human_review', label: 'Human review', tone: 'attn' },
  { key: 'approval', label: 'Approval', tone: 'gold' },
  { key: 'failed', label: 'Failed', tone: 'crit' },
  { key: 'stalled', label: 'Stalled', tone: 'attn' },
  { key: 'stale_wait', label: 'Stale wait', tone: 'attn' },
  { key: 'missing_data', label: 'Missing data', tone: 'attn' },
  { key: 'degraded', label: 'System degraded', tone: 'crit' },
])

const OWNER = Object.fromEntries(REGISTRY.map((r) => [r.workflow_key, { app: r.owner_app, href: r.owner_href, name: r.short_name }]))
const queueHref = (id) => `/queue?row=${encodeURIComponent(id)}`

function actionsFor(it) {
  const a = []
  if (it.subject?.kind === 'seller' && it.subject.href) a.push({ kind: 'open_conversation', label: 'Open conversation', href: it.subject.href, app: 'Inbox' })
  if (it.subject?.kind === 'campaign' && it.subject.href) a.push({ kind: 'open_campaign', label: 'Open campaign', href: it.subject.href, app: 'Campaign Command' })
  if (it.workflow_key === 'queue_dispatch' && it.run_id && !it.count) a.push({ kind: 'open_queue_row', label: 'Open queue row', href: queueHref(it.run_id), app: 'Queue' })
  if (it.href && !a.some((x) => x.href === it.href)) a.push({ kind: 'open_owner', label: `Open ${OWNER[it.workflow_key]?.app || 'owner'}`, href: it.href, app: OWNER[it.workflow_key]?.app || null })
  return a
}

const item = (x) => {
  const out = {
    id: x.id || `${x.workflow_key}:${x.category}:${x.run_id || x.reason_code || x.reason}`,
    category: x.category, workflow_key: x.workflow_key, workflow_name: x.workflow_name || OWNER[x.workflow_key]?.name || x.workflow_key,
    run_id: x.run_id || null, open: x.open || (x.run_id && !String(x.run_id).startsWith('queue:') ? { workflow_key: x.workflow_key, run_id: x.run_id } : null),
    node_key: x.node_key || null, subject: x.subject || null, reason: x.reason, reason_code: x.reason_code || null, detail: x.detail || null,
    since: x.since || null, owner_app: x.owner_app || OWNER[x.workflow_key]?.app || 'Workflow Studio', href: x.href || null,
    count: x.count ?? null, drill: x.drill || null, finding: Boolean(x.finding), actions: x.actions || [],
  }
  if (!x.actions) out.actions = actionsFor(out)
  return out
}

/** Failed sends in 24h, aggregated by reason (transport noise is one line, not 21). */
async function failedSends(db, now, degraded) {
  const rows = (await paged(() => db.from('send_queue').select('id, queue_status, failed_reason, source, thread_key, campaign_id, updated_at, created_at').gte('created_at', iso(now - DAY)).order('created_at', { ascending: false }), { limit: 3000, degraded, source: 'send_queue' }))
    .filter((r) => lower(r.queue_status).startsWith('failed') && !isTestRow(r))
  const isReply = (r) => ['auto_reply', 'seller_inbound_orchestrator'].includes(lower(r.source))
  const groups = new Map()
  // a failed seller reply is listed personally below — never counted again in the transport aggregate
  for (const r of rows.filter((x) => !isReply(x))) {
    const k = `${lower(r.queue_status)}:${lower(r.failed_reason) || '—'}`
    const g = groups.get(k) || { status: lower(r.queue_status), reason: r.failed_reason || null, rows: [] }
    g.rows.push(r)
    groups.set(k, g)
  }
  // a failed seller REPLY is personal: someone wrote in and got nothing — one item each, on its seller run
  const replies = rows.filter(isReply)
  const steps = replies.length ? await safe(db.from('seller_automation_execution_steps').select('execution_id, queue_id').eq('action_key', 'message_queued').in('queue_id', replies.map((r) => r.id)), degraded, 'seller_automation_execution_steps') : []
  const runOf = new Map(steps.map((s) => [String(s.queue_id), s.execution_id]))
  const out = []
  for (const r of replies) {
    out.push(item({
      category: 'failed', workflow_key: 'seller_inbound', run_id: runOf.get(String(r.id)) || null, open: runOf.get(String(r.id)) ? { workflow_key: 'seller_inbound', run_id: runOf.get(String(r.id)) } : { workflow_key: 'queue_dispatch', run_id: r.id },
      node_key: 'reply_failed', subject: { kind: 'seller', id: r.thread_key, name: null, address: null, href: r.thread_key ? `/inbox?thread=${encodeURIComponent(r.thread_key)}` : null },
      reason: `Reply failed to send · ${human(r.failed_reason || r.queue_status)}`, reason_code: lower(r.failed_reason || r.queue_status), since: r.updated_at || r.created_at,
    }))
  }
  for (const g of groups.values()) {
    out.push(item({
      id: `queue_dispatch:failed:${g.status}:${lower(g.reason) || '—'}`, category: 'failed', workflow_key: 'queue_dispatch', node_key: g.status === 'failed_transport' ? 'carrier_failed' : 'transport_failed',
      reason: `${g.rows.length} send${g.rows.length === 1 ? '' : 's'} failed in 24h · ${human(g.reason || g.status)}`, reason_code: lower(g.reason || g.status),
      detail: `${g.rows.filter((r) => r.campaign_id).length} campaign · ${g.rows.filter((r) => !r.campaign_id).length} conversation`,
      since: g.rows[g.rows.length - 1]?.created_at || null, count: g.rows.length, drill: { status: 'failed', period: '24h', reason: g.reason || null },
      actions: [{ kind: 'show_runs', label: 'Show the runs', drill: { status: 'failed', period: '24h' } }, { kind: 'open_owner', label: 'Open Queue', href: '/queue', app: 'Queue' }],
    }))
  }
  return out
}

/** Lead-state recovery surfaced conversations to a person — are they where a person will see them? */
async function surfacedButInvisible(db, now, degraded) {
  const ulse = await paged(() => db.from('universal_lead_state_events').select('thread_key, created_at').eq('source_view', 'seller_execution_gap_recovery').eq('new_value', 'human_review').gte('created_at', iso(now - 30 * DAY)).order('created_at', { ascending: false }), { limit: 3000, degraded, source: 'universal_lead_state_events' })
  const threads = [...new Set(ulse.map((r) => r.thread_key).filter((t) => t && !isInternalTestPhone(t)))]
  if (!threads.length) return []
  const [state, buckets] = await Promise.all([
    inChunksPaged(db, 'inbox_thread_state', 'thread_key, next_action', 'thread_key', threads, degraded, { chunk: 150, order: 'thread_key' }),
    inChunksPaged(db, 'v_inbox_thread_state_buckets', 'thread_key, in_needs_review, in_new_replies', 'thread_key', threads, degraded, { chunk: 150, order: 'thread_key' }),
  ])
  const visible = new Set(buckets.filter((b) => b.in_needs_review || b.in_new_replies).map((b) => b.thread_key))
  const parked = state.filter((s) => lower(s.next_action) === 'human_review' && !visible.has(s.thread_key))
  if (!parked.length) return []
  return [item({
    id: 'lead_state_reconcile:surfaced_not_visible', category: 'human_review', workflow_key: 'lead_state_reconcile', node_key: 'surface_to_human', finding: true,
    reason: `${parked.length} conversation${parked.length === 1 ? '' : 's'} surfaced to a person are in no Inbox bucket`,
    detail: `Lead-state recovery set next_action = human_review on ${threads.length} conversations in 30 days; ${parked.length} still carry it, but neither the review nor the new-replies bucket shows them.`,
    reason_code: 'surfaced_not_in_inbox_bucket', since: ulse[ulse.length - 1]?.created_at || null, count: parked.length, drill: { human: true, period: '30d' },
    actions: [{ kind: 'show_runs', label: 'Show the runs', drill: { human: true, period: '30d' } }],
  })]
}

let cache = null

export async function getExceptions(deps = {}) {
  const now = deps.now ? deps.now() : Date.now()
  if (!deps.supabase && !deps.noCache && cache && now - cache.at < 20_000) return cache.value
  const db = deps.supabase || defaultSupabase
  const degraded = []
  const items = []

  // 1. what each runtime itself says needs a person right now (+ overdue waits)
  const currents = {}
  await Promise.all(REGISTRY.map(async (r) => {
    const a = SYSTEM_ADAPTERS[r.workflow_key]
    if (!a?.current) return
    try {
      const c = await a.current(db, { now, degraded })
      currents[r.workflow_key] = c
      for (const it of c.needs_you || []) items.push(item({ ...it, category: it.category || 'human_review', workflow_key: r.workflow_key, workflow_name: r.short_name }))
    } catch { degraded.push(r.workflow_key) }
  }))
  const overdue = currents.queue_dispatch?.overdue || []
  if (overdue.length) {
    const oldest = overdue.reduce((m, o) => (!m || o.due_at < m ? o.due_at : m), null)
    items.push(item({
      id: 'queue_dispatch:stale_wait:overdue', category: 'stale_wait', workflow_key: 'queue_dispatch', node_key: 'row_due', count: overdue.length,
      reason: `${overdue.length} message${overdue.length === 1 ? '' : 's'} due more than 30 min ago, not yet claimed`, reason_code: 'due_unclaimed',
      detail: `${overdue.filter((o) => o.campaign_id).length} campaign · ${overdue.filter((o) => !o.campaign_id).length} conversation — the runner claims every minute inside the contact window`,
      since: oldest, drill: { status: 'waiting', period: '7d', node: 'row_due' },
      actions: [{ kind: 'show_runs', label: 'Show the runs', drill: { status: 'waiting', period: '7d' } }, { kind: 'open_owner', label: 'Open Queue', href: '/queue', app: 'Queue' }],
    }))
  }

  // 2. studio workflows: approvals and holds through the orchestrator's own actions; stale waits
  try {
    const [c, wfs, late] = await Promise.all([
      studioAdapter.current(db, { degraded }),
      studioAdapter.workflows(db, { degraded }),
      safe(db.from('wf_runs').select('id, workflow_key, cursor, wake_at, updated_at, subject_kind, subject_id').eq('state', 'waiting').lt('wake_at', iso(now - 20 * 60e3)).limit(100), degraded, 'wf_runs'),
    ])
    const nameOf = (k) => wfs.find((w) => w.workflow_key === k)?.name || k
    for (const it of c.needs_you || []) {
      const approval = /approval/i.test(it.reason) && !/^Held/.test(it.reason)
      items.push(item({
        ...it, workflow_name: nameOf(it.workflow_key), owner_app: 'Workflow Studio', category: approval ? 'approval' : 'stalled',
        actions: approval
          ? [{ kind: 'approve', label: 'Approve', run_id: it.run_id, node_id: it.node_key }, { kind: 'reject', label: 'Reject', run_id: it.run_id, node_id: it.node_key }]
          : [{ kind: 'resume', label: 'Resume', run_id: it.run_id }, { kind: 'cancel', label: 'Cancel run', run_id: it.run_id }],
      }))
    }
    for (const r of late) items.push(item({ category: 'stale_wait', workflow_key: r.workflow_key, workflow_name: nameOf(r.workflow_key), run_id: r.id, node_key: r.cursor, owner_app: 'Workflow Studio', subject: { kind: r.subject_kind, id: r.subject_id, name: null, address: null, href: null }, reason: `Wait passed its wake time (${String(r.wake_at).slice(0, 16).replace('T', ' ')}Z) and the orchestrator has not resumed it`, reason_code: 'wake_overdue', since: r.wake_at }))
  } catch { degraded.push('wf_runs') }

  // 3. failures that happened (24h)
  try { items.push(...await failedSends(db, now, degraded)) } catch { degraded.push('send_queue') }

  // 4. degraded runtimes: their own heartbeat went stale (a switch turned off on purpose is not degradation)
  try {
    const ctlRows = await safe(db.from('system_control').select('key, value').in('key', RUNTIME_BEATS.flatMap((b) => [b.heartbeat_key, b.switch_key]).filter(Boolean)), degraded, 'system_control')
    for (const h of runtimeHealth(Object.fromEntries(ctlRows.map((r) => [r.key, r.value])), now)) {
      if (h.state !== 'stale' || h.switched_off) continue
      const wk = h.workflows[0]
      items.push(item({ id: `degraded:${h.key}`, category: 'degraded', workflow_key: wk, node_key: null, reason: `${h.label} heartbeat stale — last beat ${Math.round((h.age_ms || 0) / 60e3)} min ago (expected ${h.cadence})`, reason_code: 'heartbeat_stale', since: h.at, href: OWNER[wk]?.href || null }))
    }
  } catch { degraded.push('system_control') }

  // 5. findings: work surfaced to a person that no person can see
  try { items.push(...await surfacedButInvisible(db, now, degraded)) } catch { degraded.push('universal_lead_state_events') }

  const order = EXCEPTION_CATEGORIES.map((c) => c.key)
  items.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || String(b.since || '').localeCompare(String(a.since || '')))
  const counts = Object.fromEntries(EXCEPTION_CATEGORIES.map((c) => [c.key, items.filter((i) => i.category === c.key).length]))
  const value = { ok: true, generated_at: iso(now), items, total: items.length, counts, categories: EXCEPTION_CATEGORIES, degraded: [...new Set(degraded)] }
  if (!deps.supabase) cache = { at: now, value }
  return value
}
