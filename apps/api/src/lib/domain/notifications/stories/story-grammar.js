/**
 * NOTIFICATION STORY GRAMMAR — what each fact is to a story (pure).
 *
 *   SAME SUBJECT + SAME CAUSAL BURST + SHORT WINDOW = ONE STORY
 *
 * Inputs are the two existing ledgers' projections — never a second event log:
 *   · platform event envelopes (lib/domain/platform/events, the Machine Feed's language)
 *   · notification_events rows (alerts, scanners, Signal Center firings), read as
 *     `ne:<row id>` — the same id the envelope's notifications adapter uses
 *
 * Every input becomes an ITEM:
 *   { id, at, role, subject, causal, label, detail, tone, priority, needs_operator, morph, sound }
 *
 *   role  trigger      opens a story (a seller message, a campaign blocked, a degraded sender)
 *         derivative   enriches a story (price captured, stage moved, auto reply sent) — silent
 *         resolver     closes an open condition (campaign resumed, sender restored) — silent
 *         restatement  the same fact another ledger owns (a "message received" alert):
 *                      contributes state + source ids, never a chain line
 *   standalone  a derivative that may open its own story when no burst claims it
 *               (a call request 4h after the reply; an offer countered by the seller)
 *
 * Dedupe is by canonical ids (event_id / notification row id), causal joins are by
 * ids (workflow run → source message id; alert → provider message sid; signal →
 * source_event_id). Titles are never compared.
 */

export const LENSES = Object.freeze(['needs_you', 'now', 'resolved', 'system'])
export const PRIORITIES = Object.freeze(['critical', 'action', 'important', 'info'])
export const PRIORITY_RANK = Object.freeze({ critical: 3, action: 2, important: 1, info: 0 })

const clean = (v) => String(v ?? '').trim()
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : NaN }
const iso = (v) => { const t = ms(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const humanize = (v) => clean(v).replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/* ── subjects ─────────────────────────────────────────────────────────── */

/**
 * A seller conversation is thread + property: one phone can carry two
 * independent conversations (two properties), and two prospects that share a
 * phone are never merged by name. `property` may be null and is filled in by
 * the builder when the thread has exactly one conversation in the window.
 */
export const sellerSubject = (thread, property) => (clean(thread) ? { type: 'seller', thread_key: clean(thread), property_id: clean(property) || null } : null)
export const subjectKey = (s) => {
  if (!s) return null
  if (s.type === 'seller') return `seller:${s.thread_key}|${s.property_id || ''}`
  return `${s.type}:${s.id}`
}

/** System components: one story per component, never one per alert row. */
export const SYSTEM_DOMAINS = Object.freeze({ numbers: 'senders', platform: 'platform', email: 'email', templates: 'templates', markets: 'markets', intelligence: 'intelligence' })
const SYSTEM_LABEL = { senders: 'Sender health', platform: 'Platform health', email: 'Email delivery', templates: 'Template health', markets: 'Market health', intelligence: 'Intelligence', queue: 'Queue' }
export const systemLabel = (id) => SYSTEM_LABEL[id] || capFirst(humanize(id))

/* ── envelope events ──────────────────────────────────────────────────── */

const SELLER_TRIGGERS = {
  'seller.replied': { verb: 'replied', priority: 'important' },
  'seller.emoji_reply': { verb: 'replied', priority: 'important' },
  'seller.reaction': { verb: 'reacted', priority: 'info' },
  'seller.language_request': { verb: 'asked about language', priority: 'action', needs: true },
  'seller.wrong_person': { verb: 'says wrong person', priority: 'info' },
  'seller.hostile': { verb: 'replied with hostility', priority: 'action', needs: true },
  'seller.call_request': { verb: 'asked for a call', priority: 'action', needs: true },
}
const CAMPAIGN_CONDITIONS = new Set(['campaign.blocked', 'campaign.paused', 'campaign.failed', 'campaign.stalled'])
const CAMPAIGN_RESOLVERS = new Set(['campaign.resumed', 'campaign.completed'])

/** The envelope types the read model asks the platform stream for (Machine-Feed-only types are not read). */
export const STORY_EVENT_TYPES = Object.freeze([
  ...Object.keys(SELLER_TRIGGERS), 'seller.opted_out',
  'message.sent', 'message.failed',
  'workflow.completed', 'workflow.waiting', 'workflow.held', 'workflow.failed',
  'stage.advanced', 'stage.regressed', 'lead.temperature_changed', 'lead.disposition_changed',
  'deal.opened', 'deal.status_changed', 'offer.generated', 'offer.countered', 'fact.captured',
  'campaign.blocked', 'campaign.paused', 'campaign.failed', 'campaign.stalled', 'campaign.resumed', 'campaign.completed',
  'closing.milestone', 'closing.attention', 'closing.completed',
  'email.failed',
])

const sellerName = (e) => {
  const ref = (e.entity_refs || []).find((r) => r.type === 'seller')
  return clean(e.actor?.kind === 'seller' ? e.actor.label : '') || clean(ref?.label) || null
}
const propertyLabel = (e) => clean((e.entity_refs || []).find((r) => r.type === 'property')?.label) || null

/** Pure: one envelope → item (null = Machine Feed only). */
export function itemFromEvent(e) {
  if (!e || !e.event_id || !e.occurred_at) return null
  const t = e.event_type
  const d = e.details || {}
  const base = { id: e.event_id, at: e.occurred_at, event_type: t, source: 'event', deep_link: e.deep_link || null, name: sellerName(e), address: propertyLabel(e), actor: e.actor?.kind || 'system' }
  const seller = sellerSubject(e.thread_key, e.property_id)

  if (SELLER_TRIGGERS[t] && seller) {
    const g = SELLER_TRIGGERS[t]
    return { ...base, role: 'trigger', kind: 'message', subject: seller, causal: { message_id: e.event_id, provider_sid: clean(d.provider_sid) || null }, verb: g.verb, label: capFirst(g.verb), detail: d.preview ? `“${d.preview}”` : null, preview: d.preview || null, priority: g.priority, needs_operator: Boolean(g.needs), tone: g.needs ? 'gold' : 'cyan', sound: g.needs ? 'attention' : 'seller_reply' }
  }
  if (t === 'seller.opted_out' && seller) {
    return { ...base, role: 'derivative', standalone: true, subject: seller, label: 'Opted out', detail: 'Suppression applied', tone: 'neutral', morph: 'opted_out', priority: 'info', sound: null }
  }
  if ((t === 'message.sent' || t === 'message.failed') && seller) {
    const origin = clean(d.origin)
    const operator = e.actor?.kind === 'operator'
    const auto = origin === 'auto_reply'
    if (t === 'message.failed') return { ...base, role: 'derivative', standalone: !operator, subject: seller, label: auto ? 'Auto reply failed' : operator ? 'Your message failed' : 'Message failed', detail: d.failure || null, tone: 'red', morph: 'send_failed', priority: 'important', needs_operator: true, sound: 'error' }
    return { ...base, role: 'derivative', subject: seller, label: auto ? 'Response sent' : operator ? 'You replied' : humanize(origin) ? `${capFirst(humanize(origin))} sent` : 'Message sent', detail: d.delivery === 'delivered' ? 'Delivered' : null, tone: 'green', morph: auto ? 'response_sent' : operator ? 'you_replied' : 'message_sent' }
  }
  if (t.startsWith('workflow.')) {
    const wkey = clean(d.workflow_key)
    if (seller && wkey === 'seller_inbound') {
      const morph = { 'workflow.held': 'held', 'workflow.waiting': 'responding', 'workflow.failed': 'automation_failed', 'workflow.completed': 'handled' }[t]
      return { ...base, role: 'derivative', subject: seller, causal: { message_id: d.source_message_id ? `me:${d.source_message_id}` : null }, label: t === 'workflow.held' ? 'Held for your review' : t === 'workflow.waiting' ? 'Responding…' : t === 'workflow.failed' ? 'Automation failed' : 'Automation handled', detail: clean(d.result) || clean(d.reason) || null, tone: t === 'workflow.held' ? 'gold' : t === 'workflow.failed' ? 'red' : 'violet', morph, needs_operator: t === 'workflow.held' || t === 'workflow.failed', priority: t === 'workflow.held' ? 'action' : t === 'workflow.failed' ? 'important' : null, run: { key: wkey, id: e.workflow_run_id || null } }
    }
    if (e.campaign_id && (t === 'workflow.held' || t === 'workflow.failed')) {
      return { ...base, role: 'trigger', kind: 'condition', condition: 'campaign_health', subject: { type: 'campaign', id: e.campaign_id }, label: 'Campaign needs operator', detail: clean(d.result) || clean(d.reason) || null, tone: 'gold', priority: 'action', needs_operator: true, sound: 'attention', campaign_name: clean((e.entity_refs || []).find((r) => r.type === 'campaign')?.label) || null }
    }
    if (!seller && wkey && (t === 'workflow.held' || t === 'workflow.failed')) {
      const runId = clean(e.workflow_run_id)
      return { ...base, role: 'trigger', kind: 'condition', condition: 'workflow_health', subject: { type: 'workflow', id: wkey }, label: t === 'workflow.held' ? 'Run held for review' : 'Run failed', detail: clean(d.result) || clean(d.reason) || null, tone: t === 'workflow.failed' ? 'red' : 'gold', priority: 'action', needs_operator: true, sound: 'attention', run: { key: wkey, id: runId || null }, workflow_name: clean(e.actor?.label) || null }
    }
    return null
  }
  if (t === 'stage.advanced' || t === 'stage.regressed') {
    if (!seller) return null
    const to = humanize(d.to)
    return { ...base, role: 'derivative', subject: seller, label: t === 'stage.advanced' ? `Moved to ${capFirst(to)}` : `Moved back to ${capFirst(to)}`, detail: d.reason || null, tone: 'cyan' }
  }
  if (t === 'lead.temperature_changed' || t === 'lead.disposition_changed') {
    if (!seller) return null
    return { ...base, role: 'derivative', subject: seller, label: t === 'lead.temperature_changed' ? (clean(d.to) ? `${capFirst(humanize(d.to))} lead` : 'Temperature cleared') : `${capFirst(humanize(d.to)) || 'Disposition cleared'}`, detail: null, tone: clean(d.to) === 'hot' ? 'gold' : 'neutral' }
  }
  if (['deal.opened', 'deal.status_changed', 'offer.generated', 'offer.countered', 'fact.captured'].includes(t)) {
    if (!seller) return null
    const kind = clean(d.kind)
    const label = kind === 'price' && d.detail ? `${d.detail} asking price` : `${clean(d.title) || capFirst(humanize(t))}${d.detail ? ` · ${d.detail}` : ''}`
    const human = e.actor?.kind === 'operator'
    // a seller counter or a new deal stands on its own; an operator's own change is a toast, not a story
    return { ...base, role: 'derivative', standalone: !human && (t === 'offer.countered' || t === 'deal.opened'), subject: seller, label, detail: null, tone: t === 'offer.countered' || kind === 'price' ? 'gold' : 'cyan', priority: t === 'offer.countered' ? 'action' : 'important', needs_operator: t === 'offer.countered', opportunity_id: e.opportunity_id || null, sound: t === 'offer.countered' ? 'attention' : null }
  }
  if (t.startsWith('campaign.') && e.campaign_id) {
    const subject = { type: 'campaign', id: e.campaign_id }
    const name = clean((e.entity_refs || []).find((r) => r.type === 'campaign')?.label) || null
    const label = capFirst(humanize(t.replace(/^campaign\./, '')))
    if (CAMPAIGN_CONDITIONS.has(t)) {
      const critical = t === 'campaign.failed' || e.severity === 'critical'
      return { ...base, role: 'trigger', kind: 'condition', condition: 'campaign_health', subject, campaign_name: name, label: t === 'campaign.stalled' ? 'Needs operator' : label, detail: clean(d.description) || clean(d.title) || null, tone: critical ? 'red' : 'gold', priority: critical ? 'critical' : 'action', needs_operator: true, sound: critical ? 'critical' : 'attention' }
    }
    if (CAMPAIGN_RESOLVERS.has(t)) {
      return { ...base, role: 'resolver', condition: 'campaign_health', subject, campaign_name: name, label, tone: 'green', morph: t === 'campaign.resumed' ? 'resumed' : 'completed', standalone: t === 'campaign.completed', priority: 'info', sound: null }
    }
    return null
  }
  if (t.startsWith('closing.') && e.closing_id) {
    const subject = { type: 'closing', id: e.closing_id }
    if (t === 'closing.attention') return { ...base, role: 'trigger', kind: 'condition', condition: 'closing', subject, label: e.summary || 'Closing needs operator', tone: 'gold', priority: 'action', needs_operator: true, sound: 'attention' }
    if (t === 'closing.completed') return { ...base, role: 'resolver', condition: 'closing', standalone: true, subject, label: 'Closing completed', tone: 'green', morph: 'closed', priority: 'important', sound: 'success' }
    if (e.actor?.kind === 'operator') return null
    return { ...base, role: 'trigger', kind: 'milestone', subject, label: e.summary || 'Closing milestone', tone: 'cyan', priority: 'info', sound: null }
  }
  if (t === 'email.failed') {
    return { ...base, role: 'trigger', kind: 'condition', condition: 'system', subject: { type: 'system', id: 'email' }, label: 'Email failed', detail: e.summary || null, tone: 'red', priority: 'important', sound: 'error' }
  }
  return null
}

/* ── notification_events rows ─────────────────────────────────────────── */

/** Alerts that restate a fact another ledger owns: never a second story or chain line. */
export const NOTIFICATION_RESTATEMENTS = Object.freeze(new Set([
  'inbox_message_received', 'campaign_activated', 'campaign_archived', 'campaign_scheduled', 'campaign_created', 'campaign_completed', 'campaign_paused',
]))

const INBOX_FACTS = {
  inbox_hot_lead: { label: 'Hot lead', tone: 'gold', priority: 'important' },
  inbox_price_captured: { label: 'Asking price captured', tone: 'gold', priority: 'important' },
  inbox_ownership_confirmed: { label: 'Ownership confirmed', tone: 'cyan', priority: 'important' },
  inbox_needs_call: { label: 'Wants a call', tone: 'gold', priority: 'action', needs: true, standalone: true, sound: 'attention' },
  inbox_hostile_reply: { label: 'Hostile reply', tone: 'gold', priority: 'action', needs: true },
  inbox_negative_sentiment: { label: 'Negative reply', tone: 'neutral', priority: 'info' },
  inbox_opt_out_received: { label: 'Opted out', tone: 'neutral', priority: 'info', morph: 'opted_out' },
  inbox_wrong_number: { label: 'Wrong number', tone: 'neutral', priority: 'info' },
  inbox_auto_reply_blocked: { label: 'Auto reply blocked', tone: 'gold', priority: 'action', needs: true, standalone: true, sound: 'attention' },
  inbox_scheduled_reply_failed: { label: 'Scheduled reply failed', tone: 'red', priority: 'important', needs: true, standalone: true, sound: 'error' },
  inbox_delivery_failure: { label: 'Delivery failed', tone: 'red', priority: 'important', standalone: true, sound: 'error' },
  inbox_follow_up_due: { label: 'Follow-up due', tone: 'gold', priority: 'important', standalone: true },
  inbox_sla_breach: { label: 'Reply overdue', tone: 'gold', priority: 'action', needs: true, standalone: true, sound: 'attention' },
}
const NEG = new Set(['warning', 'critical'])
const RECOVERY = /(recovered|recovery|healthy|improving)$/

const rowAt = (r) => (Number(r.group_count) > 1 && r.updated_at ? r.updated_at : r.created_at)

/** Pure: one notification_events row → item (null = not a story fact). */
export function itemFromNotification(r) {
  if (!r || !r.id) return null
  const type = clean(r.event_type)
  const domain = clean(r.domain)
  const sev = clean(r.severity).toLowerCase()
  const m = r.metrics_snapshot && typeof r.metrics_snapshot === 'object' ? r.metrics_snapshot : {}
  const thread = ['thread', 'seller_thread', 'seller'].includes(clean(r.source_entity_type)) ? clean(r.source_entity_id) : ''
  const base = {
    id: `ne:${r.id}`, at: iso(rowAt(r)) || iso(r.created_at), event_type: type, source: 'notification', notification: r,
    causal: { provider_sid: clean(m.provider_message_sid) || null, source_event_id: clean(m.source_event_id) || null },
    label: clean(r.title) || capFirst(humanize(type)), detail: clean(r.description) || null,
  }
  if (NOTIFICATION_RESTATEMENTS.has(type)) {
    const subject = thread ? sellerSubject(thread, r.property_id) : r.campaign_id ? { type: 'campaign', id: String(r.campaign_id) } : null
    return subject ? { ...base, role: 'restatement', subject } : null
  }
  // Signal Center firings (one row per firing; a re-fire updates it, a cleared condition resolves it).
  // Severity is Signal Center's own vocabulary (metrics_snapshot.signal_severity):
  //   critical → CRITICAL · warning → ACTION (needs you; SYSTEM lens for infra subjects)
  //   attention → IMPORTANT (NOW) · info → INFO
  // An event rule's evidence names the event that fired it (metrics.event_id): the signal joins that story.
  if (domain === 'signals') {
    const st = clean(r.source_entity_type)
    // the evaluator writes a seller subject as 'seller_thread' (the envelope's own name for it)
    const subject = (st === 'seller' || st === 'seller_thread' || st === 'thread') && thread ? sellerSubject(thread, r.property_id)
      : st === 'campaign' && r.campaign_id ? { type: 'campaign', id: String(r.campaign_id) }
        : st === 'property' && r.property_id ? { type: 'property', id: String(r.property_id) }
          // New Replies backlog is operator work (NEEDS YOU / NOW), not infrastructure
          : st === 'inbox' ? { type: 'inbox', id: 'new_replies' }
            : st === 'sender' ? { type: 'system', id: 'senders' }
              : { type: 'system', id: st === 'platform' || !st ? 'platform' : st }
    const ss = clean(m.signal_severity).toLowerCase() || ({ critical: 'critical', warning: 'warning', positive: 'info', neutral: 'attention' }[sev] || 'attention')
    const priority = { critical: 'critical', warning: 'action', attention: 'important', info: 'info' }[ss] || 'important'
    const needs = ss === 'critical' || ss === 'warning'
    return {
      ...base, causal: { ...base.causal, source_event_id: clean(m.source_event_id) || clean(m.event_id) || null },
      role: 'trigger', kind: 'condition', condition: `signal:${clean(m.rule_key) || type}`, subject, signal: { rule_key: clean(m.rule_key) || null, signal_id: clean(m.signal_id) || null, severity: ss },
      tone: ss === 'critical' ? 'red' : needs ? 'gold' : 'cyan', priority, needs_operator: needs,
      sound: ss === 'critical' ? 'critical' : needs ? 'attention' : null,
      resolved_at: r.status === 'resolved' ? r.resolved_at || r.updated_at : null,
    }
  }
  if (domain === 'inbox') {
    if (!thread) return null
    const f = INBOX_FACTS[type] || { label: capFirst(humanize(type.replace(/^inbox_/, ''))), tone: NEG.has(sev) ? 'gold' : 'neutral', priority: 'info' }
    return { ...base, role: 'derivative', standalone: Boolean(f.standalone), subject: sellerSubject(thread, r.property_id), label: f.label, detail: null, tone: f.tone, priority: f.priority, needs_operator: Boolean(f.needs), morph: f.morph || null, sound: f.sound || null }
  }
  const sys = SYSTEM_DOMAINS[domain]
  if (sys) {
    const recovery = sev === 'positive' || RECOVERY.test(type)
    const subject = { type: 'system', id: sys }
    if (recovery) return { ...base, role: 'resolver', condition: 'system', subject, tone: 'green', morph: 'restored', priority: 'info' }
    if (!NEG.has(sev)) return null // neutral system chatter belongs to the Machine Feed
    return { ...base, role: 'trigger', kind: 'condition', condition: 'system', subject, tone: sev === 'critical' ? 'red' : 'gold', priority: sev === 'critical' ? 'critical' : 'important', needs_operator: sev === 'critical', sound: sev === 'critical' ? 'critical' : 'warning', component: clean(r.sender_number_id) || clean(r.source_entity_id) || null, resolved_at: r.status === 'resolved' ? r.resolved_at : null }
  }
  if (domain === 'campaigns' && r.campaign_id) {
    const subject = { type: 'campaign', id: String(r.campaign_id) }
    if (sev === 'positive') return { ...base, role: 'trigger', kind: 'milestone', subject, tone: 'green', priority: 'info' }
    if (!NEG.has(sev)) return null
    return { ...base, role: 'trigger', kind: 'condition', condition: 'campaign_health', subject, tone: sev === 'critical' ? 'red' : 'gold', priority: sev === 'critical' ? 'critical' : 'important', needs_operator: sev === 'critical', sound: sev === 'critical' ? 'critical' : 'warning', resolved_at: r.status === 'resolved' ? r.resolved_at : null }
  }
  if (domain === 'closing' && r.closing_id) {
    if (!NEG.has(sev) && sev !== 'positive') return null
    return { ...base, role: 'trigger', kind: NEG.has(sev) ? 'condition' : 'milestone', condition: 'closing', subject: { type: 'closing', id: String(r.closing_id) }, tone: sev === 'critical' ? 'red' : sev === 'positive' ? 'green' : 'gold', priority: sev === 'critical' ? 'critical' : NEG.has(sev) ? 'action' : 'info', needs_operator: NEG.has(sev), sound: NEG.has(sev) ? 'attention' : null, resolved_at: r.status === 'resolved' ? r.resolved_at : null }
  }
  if ((domain === 'acquisition' || domain === 'workflow') && NEG.has(sev)) {
    const subject = thread ? sellerSubject(thread, r.property_id) : r.workflow_id ? { type: 'workflow', id: String(r.workflow_id) } : r.deal_id ? { type: 'deal', id: String(r.deal_id) } : null
    if (!subject) return null
    return { ...base, role: subject.type === 'seller' ? 'derivative' : 'trigger', standalone: true, kind: 'condition', condition: domain, subject, tone: sev === 'critical' ? 'red' : 'gold', priority: sev === 'critical' ? 'critical' : 'important', needs_operator: true, sound: 'attention', resolved_at: r.status === 'resolved' ? r.resolved_at : null }
  }
  return null
}

export const _internals = { ms, iso, humanize, capFirst }
