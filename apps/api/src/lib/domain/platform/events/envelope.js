/**
 * PLATFORM EVENT ENVELOPE — one event language over every ledger (read-side).
 *
 * The envelope is a PROJECTION: every event points at the one row it came from
 * (provenance.table + row_id) and no fact is projected by two adapters. The
 * ownership table below is the de-duplication contract — when two ledgers
 * record the same fact, exactly one adapter speaks for it:
 *
 *   fact                                  owner adapter   ledger
 *   seller.replied                        messages        message_events (inbound)
 *   seller.reaction / .emoji_reply /
 *     .language_request / .wrong_person /
 *     .hostile / .call_request            messages        message_events (inbound) -- the SAME row as
 *                                                         seller.replied, typed by what the reply was
 *                                                         (New Replies 7.2); never a second event
 *   message.sent / message.failed         messages        message_events (outbound, conversation sources)
 *   campaign sends (individually)         messages        message_events — only in a seller/property replay
 *   campaign.batch_sent                   campaign_sends  send_queue.sent_at (campaign sources), per campaign per 10 min
 *   workflow.held/failed/completed/…      workflow        observatory runs (seller_automation_executions, wf_runs,
 *                                                         campaign feeder exceptions, email dispatch)
 *   stage.advanced / stage.regressed      lead_state      universal_lead_state_events.lifecycle_stage
 *   lead.* (temperature, disposition,
 *     contactability, archive, lock)      lead_state      universal_lead_state_events
 *   deal.opened / offer.generated /
 *     fact.captured / offer.countered /
 *     deal.status_changed                 pipeline        acquisition_opportunity_history (movementFromHistory);
 *                                                         its stage_transition rows mirror lead-state stage moves
 *                                                         (30/34 matched in prod) and are not projected twice
 *   campaign.* lifecycle                  campaigns       campaign_events (+ campaigns.paused_at/resumed_at/
 *                                                         completed_at/failed_at — transitions campaign_events never records)
 *   closing.*                             closing         closing_activity_events
 *   alert.triggered                       notifications   notification_events (restatements of owned facts skipped)
 *
 * GRANULARITY: operator-level only — never SQL calls, polls, scheduler ticks
 * that placed nothing, retries, tokens or tiles.
 */

export const SOURCE_SYSTEMS = Object.freeze(['inbox', 'queue', 'campaign', 'workflow', 'pipeline', 'closing', 'email', 'notification', 'deal', 'buyer', 'search', 'call'])
export const SEVERITIES = Object.freeze(['info', 'attention', 'warning', 'critical'])
export const ACTOR_KINDS = Object.freeze(['seller', 'operator', 'automation', 'system'])
export const SUBJECT_TYPES = Object.freeze(['seller', 'property', 'campaign', 'closing', 'workflow'])

/** The vocabulary (dotted). Anything an adapter emits must be listed here. */
export const EVENT_TYPES = Object.freeze({
  'seller.replied': 'Seller replied',
  // New Replies 7.2: one inbound, typed by what it was (never in addition to seller.replied).
  'seller.reaction': 'Seller reacted',
  'seller.emoji_reply': 'Seller replied with an emoji',
  'seller.language_request': 'Seller asked about language',
  'seller.wrong_person': 'Wrong person replied',
  'seller.hostile': 'Hostile reply',
  'seller.call_request': 'Seller asked for a call',
  'seller.opted_out': 'Seller opted out',
  'message.sent': 'Message sent',
  'message.failed': 'Message failed',
  'campaign.batch_sent': 'Campaign sends',
  'campaign.created': 'Campaign created',
  'campaign.updated': 'Campaign updated',
  'campaign.hydrated': 'Targets built',
  'campaign.activated': 'Campaign activated',
  'campaign.queue_planned': 'Sends scheduled',
  'campaign.blocked': 'Campaign blocked',
  'campaign.paused': 'Campaign paused',
  'campaign.resumed': 'Campaign resumed',
  'campaign.completed': 'Campaign completed',
  'campaign.failed': 'Campaign failed',
  'campaign.archived': 'Campaign archived',
  'campaign.stalled': 'Campaign needs operator',
  'workflow.completed': 'Automation handled',
  'workflow.waiting': 'Automation waiting',
  'workflow.held': 'Held for review',
  'workflow.failed': 'Automation failed',
  'workflow.step': 'Workflow step',
  'stage.advanced': 'Stage advanced',
  'stage.regressed': 'Stage moved back',
  'lead.temperature_changed': 'Temperature changed',
  'lead.disposition_changed': 'Disposition set',
  'lead.contactability_changed': 'Contactability changed',
  'lead.archived': 'Conversation archived',
  'lead.stage_locked': 'Stage lock changed',
  'deal.opened': 'Deal opened',
  'deal.status_changed': 'Deal status changed',
  'offer.generated': 'Offer set',
  'offer.countered': 'Seller countered',
  'fact.captured': 'Fact captured',
  'closing.milestone': 'Closing milestone',
  'closing.attention': 'Closing needs operator',
  'closing.completed': 'Closing completed',
  'email.sent': 'Email sent',
  'email.failed': 'Email failed',
  'alert.triggered': 'Alert',
  // Browser 1.0: an operator attached a research page to a record (observational)
  'research.source_saved': 'Source saved',
})

const clean = (v) => String(v ?? '').trim()

/**
 * Canonical, sortable instant: `YYYY-MM-DDTHH:MM:SS.ffffffZ` (microseconds kept —
 * Postgres keys are microsecond-precise, and the keyset cursor must be exact).
 * Returns null for anything unparseable.
 */
export function canonicalTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? toMicros(new Date(v).toISOString()) : null
  const s = clean(v)
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s)
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? toMicros(new Date(t).toISOString()) : null }
  const frac = (m[3] || '').slice(0, 6).padEnd(6, '0')
  const off = (m[4] || 'Z').toUpperCase()
  if (off === 'Z' || /^[+-]00(:?00)?$/.test(off)) return `${m[1]}T${m[2]}.${frac}Z`
  const base = Date.parse(`${m[1]}T${m[2]}${off.length === 3 ? `${off}:00` : off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`}`)
  if (!Number.isFinite(base)) return null
  return `${new Date(base).toISOString().slice(0, 19)}.${frac}Z`
}
const toMicros = (iso) => `${iso.slice(0, 23)}000Z`

export const timeMs = (canon) => (canon ? Date.parse(canon) : NaN)

/** Envelope factory: validates the vocabulary and bounds the payload. */
export function envelope({ event_id, occurred_at, source_system, event_type, severity = 'info', actor, entity_refs = [], summary, details = null, deep_link = null, provenance, ...ids }) {
  const at = canonicalTime(occurred_at)
  if (!at) return null
  if (!EVENT_TYPES[event_type]) throw new Error(`unknown event_type ${event_type}`)
  if (!SOURCE_SYSTEMS.includes(source_system)) throw new Error(`unknown source_system ${source_system}`)
  const out = {
    event_id: clean(event_id),
    occurred_at: at,
    source_system,
    event_type,
    severity: SEVERITIES.includes(severity) ? severity : 'info',
    actor: { kind: ACTOR_KINDS.includes(actor?.kind) ? actor.kind : 'system', ...(actor?.label ? { label: String(actor.label).slice(0, 80) } : {}) },
    entity_refs: entity_refs.filter((r) => r && r.type && r.id).map((r) => ({ type: r.type, id: String(r.id), ...(r.label ? { label: String(r.label).slice(0, 120) } : {}) })).slice(0, 6),
    summary: clean(summary).slice(0, 200) || EVENT_TYPES[event_type],
    details: details ? boundDetails(details) : null,
    deep_link: deep_link || null,
    provenance: { table: provenance.table, row_id: String(provenance.row_id), adapter: provenance.adapter, ...(provenance.ledger ? { ledger: provenance.ledger } : {}) },
  }
  for (const k of ['property_id', 'thread_key', 'prospect_id', 'opportunity_id', 'campaign_id', 'workflow_run_id', 'closing_id', 'buyer_id', 'market']) {
    const v = clean(ids[k])
    if (v) out[k] = v
  }
  return out
}

/** Details stay small: scalars and short arrays only, 24 keys max. */
function boundDetails(d) {
  const out = {}
  for (const [k, v] of Object.entries(d).slice(0, 24)) {
    if (v == null) continue
    if (typeof v === 'string') out[k] = v.slice(0, 240)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => (typeof x === 'object' && x ? JSON.parse(JSON.stringify(x)) : x))
    else if (typeof v === 'object') out[k] = JSON.parse(JSON.stringify(v))
  }
  return out
}

/* ── shared builders ─────────────────────────────────────────────────── */

const q = (o) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) s.set(k, String(v)); const t = s.toString(); return t ? `?${t}` : '' }
/** App paths (same conventions as the Calendar's deepLink). */
export const links = Object.freeze({
  thread: (tk) => (tk ? `/inbox${q({ thread: tk })}` : null),
  campaign: (id) => (id ? `/campaign-command${q({ campaign: id })}` : null),
  deal: (id) => (id ? `/pipeline${q({ opp: id })}` : null),
  closing: (id) => (id ? `/closing-desk${q({ case: id })}` : null),
  run: (key, run) => (run ? `/workflow-studio${q({ studio: key, run })}` : null),
  email: () => '/email-command',
})

export const refs = Object.freeze({
  seller: (tk, label) => (tk ? { type: 'seller', id: tk, label } : null),
  property: (id, label) => (id ? { type: 'property', id, label } : null),
  campaign: (id, label) => (id ? { type: 'campaign', id, label } : null),
  closing: (id, label) => (id ? { type: 'closing', id, label } : null),
  workflow: (key, run, label) => (run ? { type: 'workflow', id: `${key}:${run}`, label } : null),
})

export const humanize = (v) => clean(v).replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
export const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** notification_events.severity → envelope severity (positive/neutral news is info, not attention). */
export function severityOfNotification(s) {
  const v = clean(s).toLowerCase()
  if (['critical', 'error', 'urgent', 'blocker'].includes(v)) return 'critical'
  if (['warning', 'warn'].includes(v)) return 'warning'
  if (['high', 'attention', 'important'].includes(v)) return 'attention'
  return 'info'
}

/** campaign_events.severity → envelope severity. */
export function severityOfCampaignEvent(s) {
  const v = clean(s).toLowerCase()
  if (v === 'error' || v === 'critical') return 'critical'
  if (v === 'warning') return 'warning'
  return 'info'
}
