/**
 * SHELL TELEMETRY — the desktop command rail's one read model.
 *
 * It owns nothing. Every number is projected from the read service that
 * already owns it, and every event from a runtime's own ledger (the Workflow
 * Studio observatory) or the canonical lifecycle movement feed. The rail
 * polls this once every ~15 s instead of six endpoints.
 *
 * RESTING METRICS (one per app — the definitions the rail must not drift from)
 *   inbox     seller replies awaiting handling      inbox_bucket = 'new_replies' (canonical bucket)
 *   email     email threads that need the operator  Email Command counts.needs_you
 *   queue     sends still due today (operator day)  send_queue queue_status ∈ {queued, pending, scheduled,
 *                                                   processing} AND scheduled_for_utc < end of today (America/Chicago);
 *                                                   'approval' rows are attention, not work the machine will do
 *   campaigns active campaigns                      campaigns.status = 'active', not archived
 *   pipeline  live deals                            pipeline command totals.working (non-dormant opportunities)
 *   workflow  live executions                       observatory registry telemetry.in_flight
 *   closing   active closings                       closing execution summary counts.active
 *
 * TRANSIENT EVENTS come only from ledger nodes with runtime evidence (see
 * mapObservedEvent) and pipeline movement rows. A cold read (no cursor) or a
 * stale cursor (a laptop waking up) returns NO events — the rail never
 * replays history as if it were happening now.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getLiveCounts } from '@/lib/domain/inbox/live-inbox-service.js'
import { fetchQueueProcessorHealth } from '@/lib/cockpit/queue-processor-health-service.js'
import { getPipelineCommandOverview } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { getRegistry, getLive } from '@/lib/domain/workflow-studio/observatory/service.js'
import { getClosingPortfolio } from '@/lib/domain/closings/closing-execution-service.js'
import { STAGE_ORDER } from '@/lib/domain/closings/closing-authority.js'
import { getEmailCommandHome } from '@/lib/domain/email/email-command-service.js'

const OPERATOR_TZ = 'America/Chicago'
const QUEUE_DUE_STATUSES = ['queued', 'pending', 'scheduled', 'processing']
const SOURCE_TIMEOUT_MS = 9_000
/** a cursor older than this is a reconnect, not a live session: no replay */
const REPLAY_GUARD_MS = 3 * 60_000
const MAX_EVENTS = 60

/* ── small per-process cache: stale-while-revalidate, one in-flight read ──
   The rail polls often; a slow source (inbox counts on a cold instance) must
   not hold the whole response. A stale value is returned at once and
   refreshed in the background; only a cold source waits (bounded). */
const cache = new Map()
function refresh(key, load) {
  const hit = cache.get(key)
  if (hit?.pending) return hit.pending
  const pending = load().then(
    (value) => { cache.set(key, { at: Date.now(), value }); return value },
    (error) => { const cur = cache.get(key); cache.set(key, { at: cur?.at || 0, value: cur?.value }); throw error },
  )
  cache.set(key, { ...(hit || { at: 0 }), pending })
  return pending
}
async function cached(key, ttlMs, load) {
  const hit = cache.get(key)
  if (hit && hit.value !== undefined) {
    if (Date.now() - hit.at >= ttlMs && !hit.pending) refresh(key, load).catch(() => {})
    return hit.value
  }
  return refresh(key, load)
}

function withTimeout(promise, ms = SOURCE_TIMEOUT_MS) {
  let t
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('source_timeout')), ms) }),
  ])
}

/** The end of the operator's calendar day, as a UTC instant. */
export function endOfOperatorDay(now = Date.now(), tz = OPERATOR_TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
  // offset of tz from UTC at `now`, in ms
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = asUtc - Math.floor(now / 1000) * 1000
  const nextMidnightLocal = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0)
  return new Date(nextMidnightLocal - offset)
}

/* ── resting metrics ─────────────────────────────────────────────────────── */

async function readQueue(db, now) {
  const end = endOfOperatorDay(now).toISOString()
  const [due, approval, health] = await Promise.all([
    db.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', QUEUE_DUE_STATUSES).lt('scheduled_for_utc', end),
    db.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'approval'),
    fetchQueueProcessorHealth().catch(() => null),
  ])
  if (due.error) throw due.error
  const c = health?.counts || {}
  return {
    today_remaining: due.count ?? 0,
    approval: approval.error ? null : approval.count ?? 0,
    processing: Number.isFinite(c.processing) ? c.processing : null,
    sent_today: Number.isFinite(c.sentToday) ? c.sentToday : null,
    delivered_today: Number.isFinite(c.deliveredToday) ? c.deliveredToday : null,
    failed_today: Number.isFinite(c.failedToday) ? c.failedToday : null,
    status: health?.status || null,
    // the reason behind a degraded status, so the badge can say it
    overdue: Number.isFinite(c.overdueActive) ? c.overdueActive : null,
    oldest_overdue_due_at: health?.oldestOverdueDueAt || null,
    // attention, never degraded: rows the dispatcher keeps refusing
    refused_repeatedly: Number.isFinite(c.refusedRepeatedly) ? c.refusedRepeatedly : null,
    latest_sent_at: health?.latestSentAt || null,
    day_ends_at: end,
  }
}

async function readCampaigns(db) {
  const { data, error } = await db.from('campaigns').select('status').is('archived_at', null).in('status', ['active', 'paused', 'scheduled'])
  if (error) throw error
  const by = { active: 0, paused: 0, scheduled: 0 }
  for (const r of data || []) by[r.status] = (by[r.status] || 0) + 1
  return by
}

/* ── events: ledger nodes with runtime evidence → rail transients ─────── */

// The canonical S1–S10 order is closing-authority's STAGE_ORDER (it guards S10);
// a hand-written table here had drifted (S6–S9 resolved to nothing).
const STAGE_INDEX = Object.fromEntries(STAGE_ORDER.map((code, i) => [code, i + 1]))

/**
 * transient ∈ typing · processing · success · failure · retry · attention ·
 *             stage · add · refill · start · complete · trace · milestone
 * priority 1 = operator intervention / failure … 5 = background
 */
export function mapObservedEvent(e) {
  const k = e.node_key
  const held = e.event_type === 'node_held' || e.status === 'held'
  const failed = e.event_type === 'node_failed' || e.status === 'failed'
  const base = { id: `obs:${e.event_id}`, occurred_at: e.occurred_at, source_ref: e.source_ref || e.run_id, label: e.label, workflow_key: e.workflow_key, run_id: e.run_id, node_key: k }
  switch (e.workflow_key) {
    case 'seller_inbound':
      if (k === 'reply_received') return { ...base, app: '/inbox', kind: 'auto_reply_started', transient: 'typing', priority: 2, text: 'Seller reply received — automation handling' }
      // ✓ only when the adapter fetched the REAL send_queue row (dispatch_handoff is emitted from
      // the row's own status, never from the ledger's message_queued claim) — and not a review hold
      if (k === 'dispatch_handoff' && !held && !failed && !/review hold/i.test(e.label || '') && e.source_ref !== 'send_queue:review_hold') return { ...base, app: '/inbox', kind: 'auto_reply_queued', transient: 'success', priority: 2, text: /deliver/i.test(e.label || '') ? 'Auto response delivered' : 'Auto response queued' }
      if (k === 'human_review' || k === 'policy_hold' || k === 'approval_hold' || (held && k)) return { ...base, app: '/inbox', kind: 'auto_reply_held', transient: 'attention', priority: 1, text: 'Held for human review' }
      if (k === 'enqueue_failed' || k === 'reply_failed') return { ...base, app: '/inbox', kind: 'auto_reply_failed', transient: 'failure', priority: 1, text: 'Auto response failed' }
      return null
    case 'queue_dispatch':
      if (k === 'provider_dispatch' && !failed) return { ...base, app: '/queue', kind: 'dispatch', transient: 'processing', priority: 4, text: 'Dispatching' }
      if (k === 'delivered' || k === 'provider_accepted') return { ...base, app: '/queue', kind: k === 'delivered' ? 'delivered' : 'sent', transient: 'success', priority: 4, text: k === 'delivered' ? 'Message delivered' : 'Message sent' }
      if (k === 'transport_failed' || k === 'carrier_failed') return { ...base, app: '/queue', kind: 'send_failed', transient: 'failure', priority: 1, text: k === 'carrier_failed' ? 'Carrier failed' : 'Transport failed' }
      if (k === 'content_hold' || k === 'review_hold') return { ...base, app: '/queue', kind: 'send_held', transient: 'attention', priority: 1, text: 'Held for operator' }
      return null
    case 'campaign_execution': {
      if (k === 'activate_campaign' && !held && !failed) return { ...base, app: '/campaign-command', kind: 'campaign_started', transient: 'start', priority: 4, text: 'Campaign activated' }
      if (k === 'queue_plan' && !held && !failed) {
        const placed = Number(/^(\d+) rows? scheduled/.exec(e.label || '')?.[1] || 0)
        if (placed > 0) return { ...base, app: '/campaign-command', kind: 'campaign_refill', transient: 'refill', priority: 4, value: placed, display: `+${placed.toLocaleString('en-US')}`, text: `Refill · ${placed.toLocaleString('en-US')} scheduled` }
        return null
      }
      if (k === 'spam_recycle' && !held && !failed) return { ...base, app: '/campaign-command', kind: 'campaign_recycle', transient: 'retry', priority: 4, text: 'Recycling carrier-filtered sends' }
      if (k === 'stalled' || k === 'marked_missed') return { ...base, app: '/campaign-command', kind: 'campaign_attention', transient: 'attention', priority: 1, text: k === 'stalled' ? 'Feeder stalled — needs operator' : 'Start missed' }
      if (k === 'campaign_completed') return { ...base, app: '/campaign-command', kind: 'campaign_completed', transient: 'complete', priority: 3, text: 'Campaign completed' }
      return null
    }
    case 'closing_execution': {
      const milestone = { contract_executed: 'CONTRACT', title_open: 'TITLE', title_commitment: 'COMMIT', clear_to_close: 'CTC', buyer_emd: 'EMD', settlement: 'SETTLE' }[k]
      if (k === 'closed') return { ...base, app: '/closing-desk', kind: 'closing_closed', transient: 'complete', priority: 3, text: 'Closed · won' }
      if (k === 'escalate' || k === 'operator_finalize') return { ...base, app: '/closing-desk', kind: 'closing_attention', transient: 'attention', priority: 1, text: k === 'escalate' ? 'Escalated to operator' : 'Operator finalizes' }
      if (milestone && !held && !failed) return { ...base, app: '/closing-desk', kind: 'closing_milestone', transient: 'milestone', priority: 3, display: milestone, text: e.label || milestone }
      return null
    }
    case 'email_dispatch':
      if (k === 'revalidate' && !held && !failed) return { ...base, app: '/email-command', kind: 'email_sending', transient: 'typing', priority: 2, text: 'Email sending' }
      if (failed) return { ...base, app: '/email-command', kind: 'email_failed', transient: 'failure', priority: 1, text: 'Email send failed' }
      return null
    case 'event_bridge':
      if (k === 'orchestrator_consumes' && !held && !failed) return { ...base, app: '/workflow-studio', kind: 'workflow_trace', transient: 'trace', priority: 5, text: 'Workflow event consumed' }
      return null
    default:
      return null
  }
}

export function mapMovement(m) {
  const base = { id: `mv:${m.id}`, occurred_at: m.at, source_ref: m.opportunityId, label: m.title, subject: m.seller || m.address || null }
  if (m.kind === 'advance' && m.fromStage && m.toStage) {
    const a = STAGE_INDEX[m.fromStage]
    const b = STAGE_INDEX[m.toStage]
    const display = a && b ? `S${a}→S${b}` : m.title
    // A pipeline move into `closed` is NOT a won deal: a win is finalized by the
    // Closing Desk (finalize_closing_case) and announced from its own ledger; a
    // bare stage=closed reads closed-lost. So this is a neutral stage move.
    return { ...base, app: '/pipeline', kind: b === 10 ? 'deal_closed_out' : 'stage_advanced', transient: 'stage', priority: 3, display, from: m.fromStage, to: m.toStage, text: `${m.title}${m.detail ? ` · ${m.detail}` : ''}` }
  }
  if (m.kind === 'created') return { ...base, app: '/pipeline', kind: 'deal_opened', transient: 'add', priority: 3, display: '+1', text: 'Opportunity opened' }
  return null
}

/* ── the read ───────────────────────────────────────────────────────────── */

export async function getShellTelemetry({ since = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const degraded = []
  const guard = async (name, fn) => { try { return await withTimeout(fn()) } catch { degraded.push(name); return null } }

  const sinceMs = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) : null
  const live = sinceMs !== null && now - sinceMs <= REPLAY_GUARD_MS

  const [inbox, queue, campaigns, pipeline, registry, closing, email, observed] = await Promise.all([
    guard('inbox', () => cached('inbox', 30_000, () => getLiveCounts({}))),
    guard('queue', () => cached('queue', 15_000, () => readQueue(db, now))),
    guard('campaigns', () => cached('campaigns', 30_000, () => readCampaigns(db))),
    guard('pipeline', () => cached('pipeline', 20_000, () => getPipelineCommandOverview({}))),
    guard('registry', () => cached('registry', 20_000, () => getRegistry())),
    guard('closing', () => cached('closing', 60_000, () => getClosingPortfolio({ view: 'summary' }))),
    guard('email', () => cached('email', 60_000, () => getEmailCommandHome({}))),
    live ? guard('live', () => cached(`live:${Math.floor(sinceMs / 15_000)}`, 12_000, () => getLive({ since: new Date(sinceMs - 60_000).toISOString() }))) : Promise.resolve(null),
  ])

  const t = registry?.telemetry || null
  const totals = pipeline?.totals || null
  const lanes = pipeline?.lanes || null
  const closingCounts = closing?.summary?.counts || null
  const campaignNeeds = (registry?.workflows || []).find((w) => w.workflow_key === 'campaign_execution')?.stats?.needs_you ?? null

  const metrics = {
    inbox: inbox ? { awaiting: Number(inbox.new_replies ?? 0), needs_review: Number(inbox.needs_review ?? 0), definition: 'Seller replies awaiting handling (inbox bucket: new replies)' } : null,
    email: email?.counts ? { needs_you: Number(email.counts.needs_you ?? 0), system_handling: Number(email.counts.system_handling ?? 0), failed: Number(email.counts.failed ?? 0), sending_enabled: Boolean(email.delivery?.send_enabled), lower_bound: Boolean(email.truncated), definition: 'Email threads that need the operator' } : null,
    queue: queue ? { ...queue, definition: 'Sends still due today (operator day, America/Chicago); approval rows are attention' } : null,
    campaigns: campaigns ? { ...campaigns, attention: campaignNeeds, definition: 'Active campaigns' } : null,
    pipeline: totals ? { live: Number(totals.working ?? 0), need_you: Number(lanes?.operator ?? 0), system: Number(totals.automated ?? 0), moved_today: Number(totals.movedToday ?? 0), blocked: Number(lanes?.blocked ?? 0), definition: 'Live deals (non-dormant opportunities)' } : null,
    workflow: t ? { live_runs: Number(t.in_flight ?? 0), human_holds: Number(t.needs_you ?? 0), events_today: Number(t.events_today ?? 0), definition: 'Live executions across every runtime' } : null,
    closing: closingCounts ? { active: Number(closingCounts.active ?? 0), needs_you: Number(closingCounts.needsYou ?? 0), blocked: Number(closingCounts.blocked ?? 0), definition: 'Active closings' } : null,
  }

  const runtimes = (registry?.workflows || []).filter((w) => !w.test && w.heartbeat && (w.heartbeat.key || w.status === 'live')).map((w) => ({
    key: w.workflow_key,
    name: w.short_name || w.name,
    owner_href: w.owner_href,
    status: w.status,
    heartbeat_at: w.heartbeat.at,
    heartbeat_state: w.heartbeat.state,
    cadence: w.heartbeat.cadence,
    last_run_at: w.stats?.last_run_at || null,
    runs_24h: w.stats?.runs_24h ?? null,
    needs_you: w.stats?.needs_you ?? 0,
    in_flight: w.stats?.in_flight ?? 0,
  }))

  let events = []
  if (live) {
    const fromObs = (observed?.recent || []).map(mapObservedEvent).filter(Boolean)
    const fromMoves = (pipeline?.movement || []).map(mapMovement).filter(Boolean)
    events = [...fromObs, ...fromMoves]
      .filter((e) => e.occurred_at && Date.parse(e.occurred_at) > sinceMs - 60_000)
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
      .slice(-MAX_EVENTS)
  }

  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    cursor: new Date(now).toISOString(),
    replay_suppressed: sinceMs !== null && !live,
    metrics,
    runtimes,
    events,
    degraded,
  }
}
