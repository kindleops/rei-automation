/**
 * OUTBOUND DISPATCH adapter — one run = one send_queue row (the queue owns the
 * send result). The runner keeps no per-guard ledger, so the path is read from
 * the row's own terminal status: every gate BEFORE the gate that decided is
 * shown as passed, the deciding gate carries the recorded reason, nothing after
 * it is drawn. A row not yet claimed is shown waiting at "due" — never guessed
 * further. Transport detail comes from the §11 dispatch ledger
 * (seller_logical_communications / seller_communication_attempts).
 */
import { QUEUE_DISPATCH as T } from '../topologies/queue.js'
import { human, DAY, iso } from '../core.js'
import { clean, lower, nodeEvents, paged, runRow, safe, subject } from './shared.js'

const KEY = 'queue_dispatch'
const RT = 'queue runner'
const inbox = (tk) => (tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null)
const WAITING = ['queued', 'scheduled', 'pending', 'retry', 'locked']
const MOVING = ['processing', 'sending', 'claimed']
const SPINE = ['row_due', 'send_authority', 'campaign_authority', 'claim_once', 'contact_window', 'select_sender', 'resolve_body', 'name_guard', 'duplicate_lock', 'greeting_guard', 'asset_guard', 'stale_reply_guard', 'health_guard', 'compliance', 'provider_dispatch', 'provider_accepted', 'delivery_result']

/** Where a row's own status says it stopped: [deciding node, its status, terminal node | null]. */
export function decidingGate(row) {
  const s = lower(row.queue_status)
  const why = lower(`${row.failed_reason || ''} ${row.paused_reason || ''} ${row.guard_reason || ''} ${row.blocked_reason || ''}`)
  if (s === 'delivered') return ['delivery_result', 'succeeded', 'delivered']
  if (s === 'sent') return ['provider_accepted', 'succeeded', null]
  if (s === 'failed_transport' || /delivery_failed|undeliver|carrier/.test(why)) return ['delivery_result', 'failed', 'carrier_failed']
  if (s.startsWith('failed')) return ['provider_dispatch', 'failed', 'transport_failed']
  if (s === 'blocked_by_health_guard') return ['health_guard', 'held', 'health_hold']
  if (s === 'blocked_sender_ineligible') return ['select_sender', 'held', 'sender_ineligible']
  if (s === 'paused_deferred_unresolved') return ['resolve_body', 'held', 'content_hold']
  if (s === 'paused_name_missing') return ['name_guard', 'held', 'content_hold']
  if (s === 'duplicate_blocked') return ['duplicate_lock', 'held', 'content_hold']
  if (s === 'blocked') return [/asset/.test(why) ? 'asset_guard' : 'greeting_guard', 'held', 'content_hold']
  if (s === 'paused_invalid_queue_row') return ['resolve_body', 'held', 'content_hold']
  if (s === 'paused_operator_review') return ['row_due', 'human', 'review_hold']
  if (s === 'cancelled' && /suppress|opt|dnc|complian|contactab/.test(why)) return ['compliance', 'held', 'compliance_block']
  if (s === 'cancelled' || s === 'expired' || s === 'superseded') return ['stale_reply_guard', 'succeeded', 'withdrawn']
  if (MOVING.includes(s)) return ['provider_dispatch', 'waiting', null]
  return ['row_due', 'waiting', null]
}

export function projectQueueRow(row, { attempts = [] } = {}) {
  const { push, events } = nodeEvents(KEY, row.id, RT)
  const [gate, gateStatus, terminal] = decidingGate(row)
  const s = lower(row.queue_status)
  const t0 = row.created_at
  const tSent = row.sent_at || null
  const tEnd = row.delivered_at || row.updated_at || tSent || t0
  const reason = row.failed_reason || row.paused_reason || row.guard_reason || row.blocked_reason || null
  const isCampaign = Boolean(row.campaign_id)
  if (gate === 'row_due') {
    push('row_due', gateStatus, gateStatus === 'waiting' ? (row.scheduled_for || t0) : t0, { label: gateStatus === 'waiting' ? (Date.parse(row.scheduled_for) > Date.now() ? 'scheduled' : 'due · awaiting the runner / window') : 'created non-executable', reason: gateStatus === 'human' ? 'review hold' : null })
    if (terminal) push(terminal, 'human', row.held_at || t0, { reason: 'awaiting operator release' })
  } else {
    for (const k of SPINE) {
      if (k === 'campaign_authority' && !isCampaign) continue
      if (k === 'resolve_body' && gate !== 'resolve_body') continue
      const at = ['provider_accepted'].includes(k) ? tSent || tEnd : ['delivery_result'].includes(k) ? tEnd : k === 'row_due' ? t0 : tSent || tEnd
      if (k === gate) {
        push(k, gateStatus, at, { reason: gateStatus === 'succeeded' ? null : reason || human(s), label: human(s), duration_ms: k === 'provider_accepted' && tSent ? Date.parse(tSent) - Date.parse(t0) : k === 'delivery_result' && tSent && row.delivered_at ? Date.parse(row.delivered_at) - Date.parse(tSent) : null })
        break
      }
      push(k, 'succeeded', at, { duration_ms: k === 'provider_accepted' && tSent ? Date.parse(tSent) - Date.parse(t0) : null })
    }
    if (terminal) push(terminal, terminal === 'delivered' ? 'succeeded' : gateStatus === 'failed' ? 'failed' : gateStatus === 'human' ? 'human' : 'succeeded', tEnd, { reason: terminal === 'delivered' ? null : reason || human(s) })
  }
  const status = ['delivered', 'sent'].includes(s) ? (s === 'sent' ? 'waiting' : 'completed')
    : s.startsWith('failed') ? 'failed'
    : s === 'paused_operator_review' ? 'held'
    : ['cancelled', 'expired', 'superseded'].includes(s) ? 'cancelled'
    : s.startsWith('blocked') || s.startsWith('paused') || s === 'duplicate_blocked' ? 'held'
    : MOVING.includes(s) ? 'running' : 'waiting'
  const last = attempts.sort((a, b) => Number(b.attempt_number) - Number(a.attempt_number))[0]
  return {
    run: runRow({
      run_id: row.id, workflow_key: KEY, version: row.execution_policy_version || null, started_at: t0, finished_at: ['completed', 'failed', 'cancelled', 'held'].includes(status) ? tEnd : null,
      subject: subject(isCampaign ? 'campaign_message' : 'seller_message', row.thread_key, row.seller_display_name || null, row.property_address || null, inbox(row.thread_key)),
      trigger: isCampaign ? 'Campaign message due' : human(row.source || 'queued message'), status,
      current_node: ['waiting', 'running'].includes(status) ? gate : null, final_node: terminal || gate,
      result: s === 'delivered' ? 'Delivered' : s === 'sent' ? 'Sent · awaiting delivery result' : human(s), reason: status === 'completed' ? null : reason ? human(reason) : last?.failure_class ? human(last.failure_class) : null,
    }),
    events,
    raw: row,
  }
}

const COLS = 'id, queue_status, source, campaign_id, thread_key, seller_display_name, property_address, created_at, updated_at, scheduled_for, sent_at, delivered_at, failed_reason, paused_reason, guard_reason, blocked_reason, held_at, approved_at, execution_policy_version'

export const queueAdapter = {
  key: KEY,
  topology: T,
  source_runtime: RT,
  notes: ['The runner keeps no per-guard ledger: a row’s path is read from its own terminal status (gates before the deciding gate passed).'],

  async load(db, { since, until = null, limit = 2000, degraded = [] }) {
    const rows = await paged(() => { let q = db.from('send_queue').select(COLS).gte('created_at', since).order('created_at', { ascending: false }); if (until) q = q.lt('created_at', until); return q }, { limit: Math.min(limit, 4000), degraded, source: 'send_queue' })
    return rows.map((r) => projectQueueRow(r))
  },

  async summary(db, { now, dayStart, degraded = [] }) {
    const rows = await paged(() => db.from('send_queue').select('id, queue_status, created_at').gte('created_at', iso(now - 7 * DAY)).order('created_at', { ascending: false }), { limit: 6000, degraded, source: 'send_queue' })
    return {
      runs_today: rows.filter((r) => String(r.created_at) >= dayStart).length,
      runs_24h: rows.filter((r) => Date.parse(r.created_at) > now - DAY).length,
      runs_7d: rows.length,
      failed_24h: rows.filter((r) => lower(r.queue_status).startsWith('failed') && Date.parse(r.created_at) > now - DAY).length,
      last_run_at: rows[0]?.created_at || null,
    }
  },

  latency(observed) {
    const out = { provider_accepted: [], delivery_result: [] }
    for (const o of observed) for (const e of o.events) if ((e.node_key === 'provider_accepted' || e.node_key === 'delivery_result') && Number.isFinite(e.duration_ms) && e.duration_ms >= 0) out[e.node_key].push(e.duration_ms)
    return out
  },

  /** Activity: campaign sends are grouped by their campaign; only a campaign message that did not go through is its own event. */
  activityFilter: (o) => !o.raw?.campaign_id || !['completed', 'waiting'].includes(o.run.status),

  headline(o) {
    return { headline: `Outbound dispatch · ${o.run.subject.name || o.run.subject.id || 'message'}`, facts: [o.run.result, o.run.reason, o.run.trigger].filter(Boolean) }
  },

  async detail(db, id, { degraded = [] } = {}) {
    const { data: row } = await db.from('send_queue').select(`${COLS}, message_body, template_id, retry_count, touch_number, market, logical_communication_id`).eq('id', clean(id)).maybeSingle()
    if (!row) return null
    const attempts = await safe(db.from('seller_communication_attempts').select('id, logical_communication_id, attempt_number, transport_phase, outcome_class, failure_class, retry_authority, provider_status, http_status, claimed_at, completed_at, template_id, variant_attempt_number').eq('queue_row_id', row.id).limit(10), degraded, 'seller_communication_attempts')
    const lids = [...new Set([row.logical_communication_id, ...attempts.map((a) => a.logical_communication_id)].filter(Boolean))]
    const logical = lids.length ? await safe(db.from('seller_logical_communications').select('id, communication_type, state, delivery_possibility, retry_authority, attempt_count, no_send_reason, last_failure_class, created_at').in('id', lids).limit(5), degraded, 'seller_logical_communications') : []
    const o = projectQueueRow(row, { attempts })
    return {
      ...o,
      facts: [
        { k: 'Queue status', v: human(row.queue_status), source: 'send_queue (owner of the send result)' },
        ...(row.sent_at ? [{ k: 'Sent', v: String(row.sent_at).slice(0, 19).replace('T', ' '), source: 'send_queue.sent_at' }] : []),
        ...(row.delivered_at ? [{ k: 'Delivered', v: String(row.delivered_at).slice(0, 19).replace('T', ' '), source: 'send_queue.delivered_at' }] : []),
        ...(row.market ? [{ k: 'Market', v: row.market, source: 'send_queue.market' }] : []),
      ],
      decisions: [
        ...attempts.map((a) => ({ k: `Attempt #${a.attempt_number}`, v: `${human(a.transport_phase)} · ${human(a.outcome_class)}${a.failure_class ? ` · ${human(a.failure_class)}` : ''}`, source: `retry authority: ${human(a.retry_authority || '—')}` })),
        ...logical.map((l) => ({ k: 'Logical send', v: `${human(l.communication_type)} · ${human(l.state)}`, source: '§11 dispatch ledger' })),
      ],
      ai: [],
      inputs: [{ k: 'Source', v: human(row.source || '—') }, ...(row.touch_number ? [{ k: 'Touch', v: String(row.touch_number) }] : [])],
      outputs: [...(row.message_body ? [{ k: 'Message', v: String(row.message_body).slice(0, 280) }] : [])],
      links: [{ label: 'Open queue row', href: `/queue?row=${encodeURIComponent(row.id)}`, app: 'Queue' }, ...(row.thread_key ? [{ label: 'Open conversation', href: inbox(row.thread_key), app: 'Inbox' }] : []), ...(row.campaign_id ? [{ label: 'Open campaign', href: `/campaigns?campaign=${encodeURIComponent(row.campaign_id)}`, app: 'Campaign Command' }] : [])],
      technical: { queue_row_id: row.id, template_id: row.template_id, retry_count: row.retry_count, attempts: attempts.length, logical_communications: logical.map((l) => l.id), execution_policy_version: row.execution_policy_version },
    }
  },

  async current(db, { now = Date.now(), degraded = [] } = {}) {
    const [waiting, holds] = await Promise.all([
      safe(db.from('send_queue').select('id, queue_status, thread_key, seller_display_name, campaign_id, scheduled_for, created_at, source').in('queue_status', [...WAITING, ...MOVING]).limit(600), degraded, 'send_queue'),
      safe(db.from('send_queue').select('id, queue_status, thread_key, seller_display_name, property_address, paused_reason, updated_at').in('queue_status', ['paused_name_missing', 'paused_deferred_unresolved', 'paused_invalid_queue_row']).gte('updated_at', iso(now - 7 * DAY)).limit(100), degraded, 'send_queue'),
    ])
    return {
      in_flight: waiting.length,
      needs_you: holds.map((h) => ({ run_id: h.id, node_key: 'content_hold', subject: subject('seller_message', h.thread_key, h.seller_display_name, h.property_address, inbox(h.thread_key)), reason: `${human(h.queue_status)}${h.paused_reason ? ` · ${human(h.paused_reason)}` : ''}`, since: h.updated_at, href: `/queue?row=${encodeURIComponent(h.id)}` })),
      live: waiting.slice(0, 200).map((w) => ({ run_id: w.id, node_key: MOVING.includes(lower(w.queue_status)) ? 'provider_dispatch' : 'row_due', status: MOVING.includes(lower(w.queue_status)) ? 'running' : 'waiting', subject: subject(w.campaign_id ? 'campaign_message' : 'seller_message', w.thread_key, w.seller_display_name, null, inbox(w.thread_key)), since: w.scheduled_for || w.created_at, detail: human(w.queue_status) })),
    }
  },

  async unmapped(db, { since, degraded = [] }) {
    const rows = await safe(db.from('send_queue').select('queue_status').gte('created_at', since).limit(8000), degraded, 'send_queue')
    const known = new Set(['delivered', 'sent', 'failed', 'failed_transport', 'blocked_by_health_guard', 'blocked_sender_ineligible', 'paused_deferred_unresolved', 'paused_name_missing', 'duplicate_blocked', 'blocked', 'paused_invalid_queue_row', 'paused_operator_review', 'cancelled', 'expired', 'superseded', ...WAITING, ...MOVING])
    const counts = new Map()
    for (const r of rows) { const s = lower(r.queue_status); if (!known.has(s) && !s.startsWith('failed')) counts.set(s, (counts.get(s) || 0) + 1) }
    return [...counts.entries()].map(([key, count]) => ({ source_key: `send_queue.queue_status=${key}`, count }))
  },
}
