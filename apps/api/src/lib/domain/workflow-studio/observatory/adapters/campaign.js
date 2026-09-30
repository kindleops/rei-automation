/**
 * CAMPAIGN EXECUTION adapter — campaign_runs (one hydration pass), campaign_events,
 * and the campaign's own lifecycle stamps. The campaign runtime owns campaign
 * state (PRECEDENCE.campaign_state): a pass never overrules campaigns.status.
 *
 * Production fact (2026-09-30): activation writes no campaign_runs row — it is
 * evidenced by its own `campaign.activated` lifecycle event (one run each);
 * every campaign_runs pass is a refill pass. Nothing is guessed beyond that.
 */
import { CAMPAIGN_EXECUTION as T } from '../topologies/campaign-closing-email.js'
import { human } from '../core.js'
import { clean, lower, nodeEvents, paged, runRow, safe, subject, timestampSummary, topCounts } from './shared.js'
import { DAY, iso } from '../core.js'

const KEY = 'campaign_execution'
const RT = 'campaign activate-due + feeder'
const href = (id) => `/campaigns?campaign=${encodeURIComponent(id)}`

function passToRun(r, camp) {
  const { push, events } = nodeEvents(KEY, r.id, RT)
  const at = r.started_at || r.created_at
  const created = Number(r.queue_rows_created || 0)
  const blocked = topCounts(r.blocked_counts)
  const reasonText = blocked.length ? blocked.map(([k, v]) => `${v} ${human(k).toLowerCase()}`).join(' · ') : null
  push('campaign_tick', 'succeeded', at, { label: 'Scheduler tick' })
  push('auto_enqueue_gate', 'succeeded', at)
  push('find_feedable', 'succeeded', at)
  push('feed_room', 'succeeded', at, { label: r.metadata?.caps?.effective_limit ? `room for ${r.metadata.caps.effective_limit}` : null })
  const planStatus = r.status === 'failed' ? 'failed' : r.status === 'blocked' || (!created && blocked.length) ? 'held' : 'succeeded'
  push('queue_plan', planStatus, at, { label: created ? `${created} rows scheduled` : 'no row placed', reason: planStatus === 'held' ? reasonText || (r.metadata?.blockers || []).join(', ') || 'no row placed' : null })
  if (created > 0) push('dispatch_handoff', 'succeeded', at, { label: `${created} to the queue runner` })
  const status = r.status === 'failed' ? 'failed' : r.status === 'started' ? 'running' : created > 0 ? 'completed' : 'held'
  return {
    run: runRow({
      run_id: r.id, workflow_key: KEY, version: 'campaign-execution-v1', started_at: at, finished_at: r.finished_at && r.finished_at >= at ? r.finished_at : at,
      subject: subject('campaign', r.campaign_id, camp?.name || 'Campaign', null, href(r.campaign_id)),
      trigger: 'Scheduler tick · refill', status, current_node: status === 'running' ? 'queue_plan' : null,
      final_node: created > 0 ? 'dispatch_handoff' : 'queue_plan',
      result: created ? `${created} message${created === 1 ? '' : 's'} scheduled` : 'Nothing placed',
      reason: status === 'held' ? reasonText : null,
    }),
    events,
    raw: r,
  }
}

/** Activation is evidenced by the lifecycle event itself (it writes no campaign_runs row). */
function activationRun(ev, camp) {
  const id = `activation:${ev.id}`
  const { push, events } = nodeEvents(KEY, id, RT)
  const at = ev.created_at
  push('campaign_tick', 'succeeded', at)
  push('find_due', 'succeeded', at)
  push('schedule_missed', 'succeeded', at, { label: 'start within grace' })
  push('launch_readiness', 'succeeded', at, { label: 'ready' })
  push('activate_campaign', 'succeeded', at, { label: 'scheduled → active' })
  return {
    run: runRow({ run_id: id, workflow_key: KEY, version: 'campaign-execution-v1', started_at: at, finished_at: at, subject: subject('campaign', ev.campaign_id, camp?.name || 'Campaign', null, href(ev.campaign_id)), trigger: ev.title || 'Campaign activated', status: 'completed', final_node: 'activate_campaign', result: 'Activated', reason: null }),
    events,
    raw: ev,
  }
}

function completionRun(c) {
  const { push, events } = nodeEvents(KEY, `completed:${c.id}`, RT)
  const at = c.completed_at
  push('campaign_tick', 'succeeded', at)
  push('auto_enqueue_gate', 'succeeded', at)
  push('find_feedable', 'succeeded', at)
  push('feed_room', 'succeeded', at)
  push('capacity_hold', 'succeeded', at, { label: 'cohort exhausted' })
  push('cohort_resolved', 'succeeded', at, { label: 'nothing sendable left' })
  push('campaign_completed', 'succeeded', at)
  return { run: runRow({ run_id: `completed:${c.id}`, workflow_key: KEY, version: 'campaign-execution-v1', started_at: at, finished_at: at, subject: subject('campaign', c.id, c.name, null, href(c.id)), trigger: 'Scheduler tick', status: 'completed', final_node: 'campaign_completed', result: 'Campaign completed' }), events, raw: c }
}

function missedRun(c) {
  const at = c.metadata?.schedule_missed_at || c.metadata?.schedule_missed_for
  const { push, events } = nodeEvents(KEY, `missed:${c.id}`, RT)
  push('campaign_tick', 'succeeded', at)
  push('find_due', 'succeeded', at)
  push('schedule_missed', 'held', at, { reason: 'start more than 2h stale', label: 'Missed' })
  push('marked_missed', lower(c.status) === 'scheduled' ? 'human' : 'succeeded', at)
  const open = lower(c.status) === 'scheduled'
  return { run: runRow({ run_id: `missed:${c.id}`, workflow_key: KEY, version: 'campaign-execution-v1', started_at: at, finished_at: at, subject: subject('campaign', c.id, c.name, null, href(c.id)), trigger: `Scheduled for ${c.metadata?.schedule_missed_for || '—'}`, status: open ? 'needs_you' : 'completed', human: open, final_node: 'marked_missed', result: open ? 'Missed — reschedule or activate' : 'Missed, later activated', reason: 'Start missed by more than 2 hours — never fired late' }), events, raw: c }
}

async function campaignsById(db, ids, degraded) {
  const list = [...new Set(ids.filter(Boolean))]
  if (!list.length) return new Map()
  const rows = await safe(db.from('campaigns').select('id, name, status, completed_at, metadata').in('id', list.slice(0, 200)), degraded, 'campaigns')
  return new Map(rows.map((c) => [c.id, c]))
}

export const campaignAdapter = {
  key: KEY,
  topology: T,
  source_runtime: RT,

  async load(db, { since, until = null, limit = 1500, degraded = [] }) {
    const runs = await paged(() => { let q = db.from('campaign_runs').select('id, campaign_id, run_type, status, started_at, finished_at, queue_rows_created, queue_rows_planned, ready_to_queue, blocked_counts, metadata, created_at').eq('run_type', 'launch_queue_plan').gte('created_at', since).order('created_at', { ascending: false }); if (until) q = q.lt('created_at', until); return q }, { limit: Math.min(limit, 3000), degraded, source: 'campaign_runs' })
    const acts = await safe(db.from('campaign_events').select('id, campaign_id, run_id, event_type, title, created_at').eq('event_type', 'campaign.activated').gte('created_at', since).limit(200), degraded, 'campaign_events')
    const lifecycle = await safe(db.from('campaigns').select('id, name, status, completed_at, metadata').or(`completed_at.gte.${since},status.eq.scheduled`).limit(200), degraded, 'campaigns')
    const camps = await campaignsById(db, [...runs.map((r) => r.campaign_id), ...acts.map((a) => a.campaign_id)], degraded)
    const out = [...runs.map((r) => passToRun(r, camps.get(r.campaign_id))), ...acts.filter((a) => !until || a.created_at < until).map((a) => activationRun(a, camps.get(a.campaign_id)))]
    for (const c of lifecycle) {
      if (c.completed_at && c.completed_at >= since) out.push(completionRun(c))
      if (c.metadata?.schedule_missed_for && (c.metadata?.schedule_missed_at || c.metadata.schedule_missed_for) >= since) out.push(missedRun(c))
    }
    return out.sort((a, b) => String(b.run.started_at).localeCompare(String(a.run.started_at)))
  },

  async detail(db, runId, { degraded = [] } = {}) {
    const id = clean(runId)
    if (id.startsWith('completed:') || id.startsWith('missed:')) {
      const cid = id.split(':')[1]
      const c = (await campaignsById(db, [cid], degraded)).get(cid)
      if (!c) return null
      const r = id.startsWith('completed:') ? completionRun(c) : missedRun(c)
      return { ...r, facts: [{ k: 'Campaign status', v: human(c.status), source: 'campaigns.status' }], decisions: [], ai: [], inputs: [], outputs: [], links: [{ label: 'Open campaign', href: href(cid), app: 'Campaign Command' }], technical: { campaign_id: cid } }
    }
    if (id.startsWith('activation:')) {
      const { data: ev } = await db.from('campaign_events').select('*').eq('id', id.slice(11)).maybeSingle()
      if (!ev) return null
      const camp = (await campaignsById(db, [ev.campaign_id], degraded)).get(ev.campaign_id)
      return { ...activationRun(ev, camp), facts: [{ k: 'Campaign', v: camp?.name || ev.campaign_id, source: 'campaigns' }, { k: 'Status now', v: human(camp?.status || '—'), source: 'campaigns.status' }], decisions: [{ k: 'Lifecycle', v: 'scheduled → activating → active', source: 'campaign_transition_status' }], ai: [], inputs: [], outputs: [], links: [{ label: 'Open campaign', href: href(ev.campaign_id), app: 'Campaign Command' }], technical: { campaign_event_id: ev.id, description: ev.description || null } }
    }
    const { data: r } = await db.from('campaign_runs').select('*').eq('id', id).maybeSingle()
    if (!r) return null
    const camp = (await campaignsById(db, [r.campaign_id], degraded)).get(r.campaign_id)
    const base = passToRun(r, camp)
    const caps = r.metadata?.caps || {}
    return {
      ...base,
      facts: [
        { k: 'Campaign', v: camp?.name || r.campaign_id, source: 'campaigns' },
        { k: 'Campaign status', v: human(camp?.status || '—'), source: 'campaigns.status' },
        { k: 'Ready targets', v: String(r.ready_to_queue ?? '—'), source: 'campaign_runs.ready_to_queue' },
        { k: 'Rows scheduled', v: String(r.queue_rows_created ?? 0), source: 'campaign_runs.queue_rows_created' },
      ],
      decisions: [
        ...(caps.effective_limit !== undefined ? [{ k: 'Feed limit', v: `${caps.effective_limit} (daily cap ${caps.daily_cap ?? '—'} · total cap ${caps.total_cap ?? '—'} · per sender ${caps.per_sender_cap ?? '—'})`, source: 'resolveLaunchCaps' }] : []),
        ...topCounts(r.blocked_counts, 8).map(([k, v]) => ({ k: `Skipped · ${human(k)}`, v: String(v), source: 'createCampaignQueuePlan' })),
      ],
      ai: [],
      inputs: [{ k: 'Run type', v: human(r.run_type) }, { k: 'Dry run', v: r.dry_run ? 'yes' : 'no' }],
      outputs: [{ k: 'send_queue rows', v: String(r.queue_rows_created ?? 0) }, { k: 'Planned', v: String(r.queue_rows_planned ?? 0) }],
      links: [{ label: 'Open campaign', href: href(r.campaign_id), app: 'Campaign Command' }, { label: 'Open queue', href: '/queue', app: 'Queue' }],
      technical: { campaign_run_id: r.id, status: r.status, blocked_counts: r.blocked_counts || {}, caps },
    }
  },

  summary: (db, o) => timestampSummary(() => db.from('campaign_runs').select('created_at, status').eq('run_type', 'launch_queue_plan').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'campaign_runs', failed: (r) => r.status === 'failed' }),

  /** Activity: a refill pass that placed nothing for the same reasons as the last one is not an event. */
  activityFilter: (o) => !(o.run.status === 'held' && /^Nothing placed/.test(o.run.result || '')),

  /** Right now: campaigns being fed are in flight; a stalled feeder or a missed start needs a person. */
  async current(db, { degraded = [] } = {}) {
    const rows = await safe(db.from('campaigns').select('id, name, status, auto_queue_enabled, emergency_stop_at, execution_heartbeat_at, metadata').in('status', ['active', 'activating', 'scheduled', 'paused']).limit(200), degraded, 'campaigns')
    const live = rows.filter((c) => ['active', 'activating'].includes(lower(c.status)) && c.auto_queue_enabled && !c.emergency_stop_at)
    const needs = []
    for (const c of rows) {
      if (c.metadata?.feeder_last?.stalled) needs.push({ run_id: c.id, node_key: 'stalled', subject: subject('campaign', c.id, c.name, null, href(c.id)), reason: 'Feeder stalled — sendable targets remain but none could be placed', since: c.metadata.feeder_last.at || null, href: href(c.id) })
      if (lower(c.status) === 'scheduled' && c.metadata?.schedule_missed_for) needs.push({ run_id: `missed:${c.id}`, node_key: 'marked_missed', subject: subject('campaign', c.id, c.name, null, href(c.id)), reason: `Scheduled start missed (${String(c.metadata.schedule_missed_for).slice(0, 16).replace('T', ' ')}) — never fired late`, since: c.metadata.schedule_missed_at || c.metadata.schedule_missed_for, href: href(c.id) })
    }
    return {
      in_flight: live.length,
      needs_you: needs,
      live: live.map((c) => ({ run_id: c.id, node_key: c.metadata?.feeder_last?.inserted ? 'queue_plan' : c.metadata?.feeder_last?.bound && c.metadata.feeder_last.bound !== 'buffer' ? 'capacity_hold' : 'feed_room', status: 'running', subject: subject('campaign', c.id, c.name, null, href(c.id)), since: c.execution_heartbeat_at || null, detail: c.metadata?.feeder_last ? `${human(c.metadata.feeder_last.reason || c.metadata.feeder_last.bound || '')} · ${c.metadata.feeder_last.active_live_rows ?? 0} in queue` : null })),
    }
  },

  observedKeys(loaded) {
    const keys = new Map()
    for (const r of loaded) for (const e of r.events) keys.set(e.node_key, (keys.get(e.node_key) || 0) + 1)
    return keys
  },
}
