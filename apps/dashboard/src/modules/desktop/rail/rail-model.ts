/**
 * COMMAND RAIL — pure model. No React, no fetching.
 *
 * The rail shows ONE stable metric per app (the definitions live on the
 * server: apps/api/src/lib/domain/shell/shell-telemetry-service.js) and,
 * briefly, a transient glyph when a real ledger event arrives. Everything
 * here is deterministic so the scheduling rules can be tested.
 */

export type Transient =
  | 'typing' | 'processing' | 'success' | 'failure' | 'retry' | 'attention'
  | 'stage' | 'add' | 'refill' | 'start' | 'complete' | 'trace' | 'milestone'

export interface ShellEvent {
  id: string
  app: string
  kind: string
  transient: Transient
  priority: number
  occurred_at: string
  display?: string
  value?: number
  text?: string
  subject?: string | null
  label?: string
  run_id?: string
  source_ref?: string | null
}

export interface ShellMetrics {
  inbox: { awaiting: number; needs_review: number } | null
  email: { needs_you: number; system_handling: number; failed: number; sending_enabled: boolean; lower_bound?: boolean } | null
  queue: { today_remaining: number; approval: number | null; processing: number | null; sent_today: number | null; delivered_today: number | null; failed_today: number | null; status: string | null; latest_sent_at: string | null } | null
  campaigns: { active: number; paused: number; scheduled: number; attention: number | null } | null
  pipeline: { live: number; need_you: number; system: number; moved_today: number; blocked: number } | null
  workflow: { live_runs: number; human_holds: number; events_today: number } | null
  closing: { active: number; needs_you: number; blocked: number } | null
}

export interface ShellRuntime {
  key: string
  name: string
  owner_href: string | null
  status: string
  heartbeat_at: string | null
  heartbeat_state: string
  cadence: string | null
  last_run_at: string | null
  runs_24h: number | null
  needs_you: number
  in_flight: number
}

export interface ShellTelemetry {
  ok: boolean
  generated_at: string
  cursor: string
  replay_suppressed: boolean
  metrics: ShellMetrics
  runtimes: ShellRuntime[]
  events: ShellEvent[]
  degraded: string[]
}

/** what a row shows at rest */
export interface Resting {
  value: number
  /** a second, attention-only number (expanded rail only) */
  attention?: number | null
  tone: 'default' | 'attn' | 'crit'
  /** one or two lines for the hover peek — real values only */
  peek: string[]
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fmt = (v: number) => v.toLocaleString('en-US')

/** Compact counts for the slot: precise below 10K, then 18.5K. */
export function compactCount(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) < 10_000) return fmt(v)
  if (Math.abs(v) < 1_000_000) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** One stable metric per app. Apps without a meaningful number return null. */
export function restingFor(route: string, m: ShellMetrics | null): Resting | null {
  if (!m) return null
  switch (route) {
    case '/inbox': {
      const v = n(m.inbox?.awaiting)
      if (v === null) return null
      return { value: v, tone: 'default', peek: [`${fmt(v)} ${v === 1 ? 'reply' : 'replies'} awaiting`, ...(m.inbox?.needs_review ? [`${fmt(m.inbox.needs_review)} need review`] : [])] }
    }
    case '/email-command': {
      const v = n(m.email?.needs_you)
      if (v === null) return null
      return { value: v, tone: v > 0 ? 'attn' : 'default', peek: [`${fmt(v)} need you${m.email?.lower_bound ? '+' : ''}`, m.email?.sending_enabled ? 'Sending on' : 'Sending off'] }
    }
    case '/queue': {
      const q = m.queue
      const v = n(q?.today_remaining)
      if (!q || v === null) return null
      const failed = n(q.failed_today) ?? 0
      const approval = n(q.approval) ?? 0
      const lines = [`${fmt(v)} due today`]
      const tail = [q.sent_today !== null ? `${fmt(q.sent_today)} sent` : null, failed ? `${fmt(failed)} failed` : null, approval ? `${fmt(approval)} awaiting approval` : null].filter(Boolean)
      if (tail.length) lines.push(tail.join(' · '))
      return { value: v, attention: failed + approval || null, tone: failed ? 'crit' : 'default', peek: lines }
    }
    case '/campaign-command': {
      const c = m.campaigns
      if (!c) return null
      const att = n(c.attention) ?? 0
      const lines = [`${fmt(c.active)} active`, [c.paused ? `${fmt(c.paused)} paused` : null, c.scheduled ? `${fmt(c.scheduled)} scheduled` : null, att ? `${fmt(att)} need you` : null].filter(Boolean).join(' · ')].filter(Boolean)
      return { value: c.active, attention: att || null, tone: 'default', peek: lines }
    }
    case '/pipeline': {
      const p = m.pipeline
      if (!p) return null
      return { value: p.live, attention: p.need_you || null, tone: 'default', peek: [`${fmt(p.live)} live deals`, [p.need_you ? `${fmt(p.need_you)} need you` : null, p.moved_today ? `${fmt(p.moved_today)} moved today` : null, p.system ? `${fmt(p.system)} system handled` : null].filter(Boolean).join(' · ')].filter(Boolean) }
    }
    case '/workflow-studio': {
      const w = m.workflow
      if (!w) return null
      return { value: w.live_runs, attention: w.human_holds || null, tone: 'default', peek: [`${fmt(w.live_runs)} live executions`, w.human_holds ? `${fmt(w.human_holds)} human holds` : 'No human holds'] }
    }
    case '/closing-desk': {
      const c = m.closing
      if (!c) return null
      return { value: c.active, attention: (c.blocked || c.needs_you) || null, tone: c.blocked ? 'crit' : 'default', peek: [`${fmt(c.active)} active ${c.active === 1 ? 'closing' : 'closings'}`, ...(c.blocked ? [`${fmt(c.blocked)} blocked`] : c.needs_you ? [`${fmt(c.needs_you)} need you`] : [])] }
    }
    default:
      return null
  }
}

/* ── scheduling ─────────────────────────────────────────────────────────── */

export interface ShownTransient {
  key: string
  app: string
  transient: Transient
  display: string | null
  tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow'
  text: string
  /** how many real events this one stands for (coalesced bursts) */
  count: number
  durationMs: number
}

export const TONE: Record<Transient, ShownTransient['tone']> = {
  typing: 'exec', processing: 'exec', success: 'ok', failure: 'crit', retry: 'exec', attention: 'attn',
  stage: 'exec', add: 'ok', refill: 'exec', start: 'exec', complete: 'ok', trace: 'flow', milestone: 'ok',
}

/** visual windows — the event itself is real; these only bound how long we show it */
export const DURATION: Record<Transient, number> = {
  typing: 1400, processing: 1200, success: 1000, failure: 1500, retry: 1300, attention: 1500,
  stage: 1700, add: 1300, refill: 1600, start: 1200, complete: 1200, trace: 1300, milestone: 1500,
}

/** the minimum gap between two transients on one row */
export const ROW_GAP_MS = 1400

/**
 * Collapse a row's pending events into the next thing to show. Highest
 * priority first (failures and holds before routine execution); a burst of
 * the same kind becomes ONE transient that says how many ("12 sent",
 * "+200"), never a machine-gun of checkmarks.
 */
export function nextTransient(pending: ShellEvent[]): { show: ShownTransient; consumed: Set<string> } | null {
  if (!pending.length) return null
  const best = Math.min(...pending.map((e) => e.priority))
  const head = pending.find((e) => e.priority === best)!
  const same = pending.filter((e) => e.priority === best && e.kind === head.kind)
  const consumed = new Set(same.map((e) => e.id))
  let display: string | null = head.display ?? null
  let text = head.text || head.label || ''
  if (same.length > 1) {
    if (head.transient === 'refill') {
      const total = same.reduce((s, e) => s + (e.value || 0), 0)
      display = total > 0 ? `+${compactCount(total)}` : display
      text = `Refill · ${fmt(total)} scheduled`
    } else if (head.transient === 'success' && head.app === '/queue') {
      display = `${compactCount(same.length)} sent`
      text = `${fmt(same.length)} messages ${head.kind === 'delivered' ? 'delivered' : 'sent'}`
    } else if (head.transient === 'add') {
      display = `+${same.length}`
      text = `${same.length} opportunities opened`
    } else if (head.transient === 'stage') {
      display = `${same.length}↑`
      text = `${same.length} deals advanced`
    } else {
      text = `${text} ×${same.length}`
    }
  }
  return {
    show: { key: head.id, app: head.app, transient: head.transient, display, tone: TONE[head.transient], text, count: same.length, durationMs: DURATION[head.transient] },
    consumed,
  }
}

/* ── machine state ─────────────────────────────────────────────────────── */

const cadenceMs = (c: string | null | undefined): number | null => {
  if (!c) return null
  if (/every minute/i.test(c)) return 60_000
  const m = /every (\d+)\s*min/i.exec(c)
  return m ? Number(m[1]) * 60_000 : null
}

export type RuntimeHealth = 'current' | 'delayed' | 'off' | 'event' | 'never'

export function runtimeHealth(r: ShellRuntime, now: number): RuntimeHealth {
  if (r.status === 'off') return 'off'
  if (r.heartbeat_state === 'never') return 'never'
  const at = r.heartbeat_at ? Date.parse(r.heartbeat_at) : null
  if (!at) return r.heartbeat_state === 'event_driven' || r.heartbeat_state === 'on_demand' ? 'event' : 'never'
  const every = cadenceMs(r.cadence)
  if (every && now - at > every * 3) return 'delayed'
  return 'current'
}

export interface MachineState {
  state: 'live' | 'degraded' | 'idle' | 'unknown'
  reason: string | null
  needYou: number
}

/** LIVE when runtimes beat; DEGRADED names what; never a health percentage. */
export function machineState(t: Pick<ShellTelemetry, 'metrics' | 'runtimes'> | null, now: number): MachineState {
  if (!t) return { state: 'unknown', reason: null, needYou: 0 }
  const delayed = t.runtimes.filter((r) => runtimeHealth(r, now) === 'delayed')
  const reasons: string[] = []
  if (delayed.length) reasons.push(delayed.length === 1 ? `${delayed[0].name} heartbeat delayed` : `${delayed.length} runtimes delayed`)
  const qs = t.metrics?.queue?.status
  if (qs === 'degraded' || qs === 'critical') reasons.push(`Queue ${qs}`)
  const needYou = (t.metrics?.workflow?.human_holds ?? 0)
  if (reasons.length) return { state: 'degraded', reason: reasons.join(' · '), needYou }
  const anyCurrent = t.runtimes.some((r) => runtimeHealth(r, now) === 'current')
  return { state: anyCurrent ? 'live' : 'idle', reason: null, needYou }
}

/* ── which machine events are worth a sound ─────────────────────────────
   High-volume execution is visual. Only arrivals that matter, holds that
   need a person, failures and real milestones are offered to the sound
   arbiter — which still dedupes, prioritises and cools down. */

export interface EventCue {
  id: string
  category: 'sellerReplies' | 'needsAttention' | 'sendFailures' | 'campaignCompletion' | 'closingMilestones' | 'workflowHolds' | 'systemDegradation'
  priority: number
  cue: 'ready' | 'success' | 'warning' | 'error' | 'attention'
  emphasis?: 'subtle' | 'normal' | 'strong'
  at: number
}

export function cueForEvent(e: ShellEvent): EventCue | null {
  const at = Date.parse(e.occurred_at) || 0
  const base = { id: e.id, at }
  if (e.transient === 'attention') {
    return { ...base, category: e.app === '/workflow-studio' ? 'workflowHolds' : e.app === '/closing-desk' ? 'closingMilestones' : 'needsAttention', priority: 1, cue: 'attention' }
  }
  if (e.transient === 'failure') {
    // a seller-conversation send that failed is the operator's problem now; a
    // carrier failure inside a campaign batch is awareness, not an alarm
    return { ...base, category: 'sendFailures', priority: 1, cue: e.app === '/inbox' || e.app === '/email-command' ? 'error' : 'warning' }
  }
  if (e.app === '/inbox' && e.transient === 'typing' && e.kind === 'reply_received') {
    return { ...base, category: 'sellerReplies', priority: 2, cue: 'ready', emphasis: 'subtle' }
  }
  if (e.app === '/campaign-command' && e.transient === 'complete') {
    return { ...base, category: 'campaignCompletion', priority: 4, cue: 'success', emphasis: 'subtle' }
  }
  if (e.app === '/closing-desk' && (e.transient === 'milestone' || e.transient === 'complete')) {
    const closed = e.transient === 'complete'
    return { ...base, category: 'closingMilestones', priority: 3, cue: closed ? 'success' : 'ready', emphasis: closed ? 'strong' : 'subtle' }
  }
  return null
}
