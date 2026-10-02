import type { LCTone } from '../../../shared/lc/states-model'

/**
 * SIGNAL CENTER — the read model the Notifications app renders
 * (GET /api/cockpit/signals). Pure helpers only: the UI renders domain state; it
 * never decides whether a rule should fire.
 */

export type SignalSeverity = 'info' | 'attention' | 'warning' | 'critical'
export type SignalStatus = 'new' | 'acknowledged' | 'resolved'

export interface SignalRow {
  id: string
  rule_key: string
  severity: SignalSeverity
  subject_type: string | null
  subject_id: string | null
  title: string
  body: string | null
  evidence: Record<string, unknown>
  source_event_id: string | null
  deep_link: string | null
  status: SignalStatus
  fired_at: string
  acknowledged_at: string | null
  resolved_at: string | null
  resolve_reason: string | null
  notification_event_id: string | null
}

export interface SignalRule {
  rule_key: string
  label: string
  description: string
  source_kind: 'event' | 'metric' | 'state' | 'monitor'
  event_source: string | null
  event_types: string[]
  metric_id: string | null
  dimension: string | null
  state_id: string | null
  scope: 'watched' | 'campaign' | 'dimension' | 'global'
  severity: SignalSeverity
  cooldown_seconds: number
  condition: Record<string, number | string | null>
  replaces_legacy: string[]
  seeded: boolean
  is_enabled: boolean
  firing: Array<{ subject_key: string; since: string | null; reason: string | null }>
  last_evaluated_at: string | null
}

export interface SignalWatch {
  id: string
  entity_type: string
  entity_id: string
  label: string | null
  address: string | null
  market: string | null
  created_at: string
}

export interface SignalGate {
  env_enabled: boolean
  control_enabled: boolean | null
  live: boolean
}

export interface SignalCenterModel {
  ok: true
  generated_at: string
  gate: SignalGate
  tables_ready: boolean
  missing_tables: string[]
  rules: SignalRule[]
  signals: SignalRow[]
  counts: { open: number; new: number; acknowledged: number; fired_24h: number; armed_rules: number }
  checkpoints: Record<string, { evaluated_through: string | null; last_run_at: string | null; partial: boolean }>
  watches: { items: SignalWatch[]; count: number; supported_types: string[]; error: string | null }
  legacy: Array<{ legacy: string; scanner: string; basis: string; replacement: string | null; suppressed_now: boolean }>
}

export const SEVERITY_TONE: Record<SignalSeverity, LCTone> = { critical: 'crit', warning: 'attn', attention: 'attn', info: 'neutral' }
export const SEVERITY_LABEL: Record<SignalSeverity, string> = { critical: 'Critical', warning: 'Warning', attention: 'Attention', info: 'Info' }

/** Where the evaluator stands, in product words (never "live" unless it is). */
export function evaluatorState(m: Pick<SignalCenterModel, 'gate' | 'tables_ready' | 'counts' | 'checkpoints'>): { label: string; tone: LCTone; detail: string } {
  if (!m.tables_ready) return { label: 'Setup required', tone: 'attn', detail: 'The Signal Center migration has not been applied. Rules are listed from code and none can run.' }
  if (!m.gate.env_enabled) return { label: 'Evaluator off', tone: 'neutral', detail: 'The evaluator is switched off at the server (SIGNAL_CENTER_ENABLED).' }
  if (!m.gate.control_enabled) return { label: 'Evaluator off', tone: 'neutral', detail: 'The evaluator is switched off in the control plane (signal_center_enabled).' }
  if (!m.counts.armed_rules) return { label: 'No rule armed', tone: 'neutral', detail: 'The evaluator is on, but every rule is disarmed.' }
  const last = lastRun(m.checkpoints)
  return { label: 'Evaluating', tone: 'exec', detail: last ? `Last evaluated ${new Date(last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Waiting for the first evaluation.' }
}

export function lastRun(checkpoints: SignalCenterModel['checkpoints']): string | null {
  let out: string | null = null
  for (const c of Object.values(checkpoints || {})) if (c.last_run_at && (!out || c.last_run_at > out)) out = c.last_run_at
  return out
}

/** The honest empty state of the signal ledger. */
export function ledgerEmpty(m: Pick<SignalCenterModel, 'gate' | 'tables_ready' | 'counts' | 'checkpoints'>): { title: string; body: string } {
  if (!m.tables_ready) return { title: 'Signal Center is not set up yet', body: 'Watches work now. Rules start firing after the owner approves the Signal Center migration and switches the evaluator on.' }
  if (!m.gate.live) return { title: 'No signals', body: 'The evaluator is off, so no rule has been evaluated.' }
  if (!m.counts.armed_rules) return { title: 'No signals', body: 'No rule is armed yet. Arm a rule under Rules.' }
  if (!lastRun(m.checkpoints)) return { title: 'No signals yet', body: 'The evaluator has not completed a run.' }
  return { title: 'No rule has fired', body: 'Armed rules are evaluating and none of their conditions has been met.' }
}

const SOURCE_LABEL: Record<string, string> = { inbox: 'Inbox', queue: 'Messages', pipeline: 'Pipeline', campaign: 'Campaigns', workflow: 'Automation', closing: 'Closing' }
const METRIC_LABEL: Record<string, string> = { delivery_rate: 'Delivery rate', opt_out_rate: 'Opt-out rate', content_filter_rate: 'Content-filter rate' }
const SCOPE_LABEL: Record<string, string> = { watched: 'watched subjects', campaign: 'every campaign', dimension: '', global: 'platform' }
const hours = (h: number) => (h % 24 === 0 ? `${h / 24}d` : `${h}h`)
const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : null)

/** What a rule reads, in one line. */
export function ruleSource(r: SignalRule): string {
  if (r.source_kind === 'event') return `${SOURCE_LABEL[r.event_source || ''] || r.event_source} events · ${SCOPE_LABEL[r.scope] || r.scope}`
  if (r.source_kind === 'metric') {
    const c = r.condition
    const bound = c.direction === 'down' ? `below ${pct(c.floor)}` : `above ${pct(c.ceiling)}`
    return `${METRIC_LABEL[r.metric_id || ''] || r.metric_id} per ${r.dimension} · ${hours(Number(c.window_hours))} vs ${c.baseline_days}d baseline · ${bound} · n ≥ ${c.min_n}`
  }
  if (r.source_kind === 'state') return r.state_id === 'queue_processor' ? 'Queue processor health · while the queue is live' : `New Replies older than ${r.condition.max_wait_minutes} min`
  return 'Model monitor'
}

export const SUBJECT_LABEL: Record<string, string> = { seller: 'Seller', property: 'Property', campaign: 'Campaign', sender: 'Sender number', queue: 'Send queue', inbox: 'New Replies' }

/** The evidence a signal carries, as label/value pairs (only facts it actually has). */
export function evidenceFacts(s: SignalRow): Array<{ label: string; value: string }> {
  const e = s.evidence || {}
  const out: Array<{ label: string; value: string }> = []
  const add = (label: string, v: unknown, fmt: (x: unknown) => string | null = (x) => (x == null || x === '' ? null : String(x))) => { const f = fmt(v); if (f) out.push({ label, value: f }) }
  const n = (x: unknown) => (typeof x === 'number' ? x.toLocaleString() : null)
  add('Value', e.value_pct, (x) => (typeof x === 'number' ? `${x}%` : null))
  add('Baseline', e.baseline_pct, (x) => (typeof x === 'number' ? `${x}%` : null))
  add('Shift', e.shift_pts, (x) => (typeof x === 'number' ? `${x > 0 ? '+' : ''}${x} pts` : null))
  add('Sample', e.n, n)
  add('Baseline sample', e.baseline_n, n)
  add('p', e.p)
  add('Waiting', e.waiting, n)
  add('Oldest wait', e.oldest_wait_minutes, (x) => (typeof x === 'number' ? `${x} min` : null))
  add('Lagging sends', e.lag_active, n)
  add('Stale sends', e.stale_active, n)
  add('Event', e.event_type)
  add('Source row', s.source_event_id)
  return out
}

export const SIGNAL_SORT = (a: SignalRow, b: SignalRow) => (a.fired_at < b.fired_at ? 1 : a.fired_at > b.fired_at ? -1 : 0)
