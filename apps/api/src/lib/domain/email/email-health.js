/**
 * EMAIL HEALTH — concrete indicators and deterministic anomaly rules. No
 * score. Each check says what it measured, against what, and what to do.
 *
 * Lanes are evaluated separately: acquisition volume can never hide a
 * transactional (closing / buyer) delivery problem, and one brand/domain's
 * bounces never colour another's.
 */

const H = 3600e3
const clean = (v) => String(v ?? '').trim()

const LANES = ['acquisition', 'seller_conversation', 'closing', 'buyer', 'transactional', 'manual', 'system']

function rate(n, d) { return d > 0 ? n / d : null }

/**
 * Pure evaluation over pre-fetched facts.
 * @param facts {{
 *   now:number, sendEnabled:boolean, disabledReason?:string,
 *   dispatchHeartbeatAt?:string, lastSentAt?:string, lastAcceptedAt?:string,
 *   dueCount:number, oldestDueAt?:string, failed24h:number, needsCount:number, unresolved24h:number,
 *   outbound1h:{lane:string, sender:string, domain:string, sent:number, hardBounce:number}[],
 *   outbound7d:{lane:string, domain:string, sent:number, hardBounce:number}[],
 *   complaints24h:{domain:string, count:number}[],
 *   inboundLastAt?:string, inbound7dCount:number, inboundConfigured:boolean,
 *   webhookLastAt?:string, sentSince6h:number,
 *   attachmentFailures24h:number, providerConfigured:boolean,
 * }}
 */
export function evaluateEmailHealth(facts) {
  const now = facts.now ?? Date.now()
  const age = (t) => (t ? now - Date.parse(t) : null)
  const issues = []
  const indicators = {}

  // Outbound provider.
  indicators.outbound = !facts.providerConfigured ? 'not_configured' : !facts.sendEnabled ? 'disabled' : 'enabled'
  if (!facts.sendEnabled && facts.dueCount > 0) {
    issues.push({ code: 'email_sending_disabled', severity: 'warning', message: `${facts.dueCount} email${facts.dueCount === 1 ? '' : 's'} waiting — sending is off (${facts.disabledReason || 'disabled'})` })
  }

  // Dispatcher heartbeat.
  const hb = age(facts.dispatchHeartbeatAt)
  indicators.dispatcher = hb === null ? 'never_ran' : hb > 10 * 60e3 ? 'stale' : 'current'
  if (hb === null || hb > 10 * 60e3) issues.push({ code: 'email_dispatcher_stale', severity: 'critical', message: hb === null ? 'Email dispatcher has never run' : `Email dispatcher last ran ${Math.round(hb / 60e3)} min ago` })

  // Outbound stalled: work due, sending on, nothing accepted for 20 min.
  if (facts.sendEnabled && facts.dueCount > 0) {
    const oldest = age(facts.oldestDueAt)
    const lastAccepted = age(facts.lastAcceptedAt)
    if (oldest !== null && oldest > 20 * 60e3 && (lastAccepted === null || lastAccepted > 20 * 60e3)) {
      issues.push({ code: 'email_outbound_stalled', severity: 'critical', message: `${facts.dueCount} emails due, none accepted by the provider for ${Math.round((lastAccepted ?? oldest) / 60e3)} min` })
    }
  }
  indicators.scheduled_overdue = facts.dueCount
  indicators.failed_24h = facts.failed24h
  if (facts.failed24h >= 5) issues.push({ code: 'email_failures', severity: 'warning', message: `${facts.failed24h} emails failed in 24h` })

  // Bounce degradation by lane + domain: last hour vs 7-day baseline.
  const byKey = new Map()
  for (const r of facts.outbound7d || []) byKey.set(`${r.lane}|${r.domain}`, r)
  indicators.lanes = {}
  for (const r of facts.outbound1h || []) {
    const base = byKey.get(`${r.lane}|${r.domain}`)
    const hourRate = rate(r.hardBounce, r.sent)
    const baseRate = base ? rate(base.hardBounce, base.sent) : null
    indicators.lanes[`${r.lane}|${r.domain}`] = { sent_1h: r.sent, hard_bounce_1h: r.hardBounce, bounce_rate_1h: hourRate, bounce_rate_7d: baseRate }
    if (r.sent >= 10 && hourRate !== null && hourRate >= 0.05 && (baseRate === null || hourRate >= 3 * Math.max(baseRate, 0.01))) {
      issues.push({ code: 'email_delivery_degraded', severity: 'critical', lane: r.lane, domain: r.domain, message: `${r.hardBounce} of ${r.sent} ${r.lane.replace(/_/g, ' ')} emails from ${r.domain} hard-bounced in the last hour${baseRate !== null ? ` (baseline ${(baseRate * 100).toFixed(1)}%)` : ''}` })
    }
  }
  for (const c of facts.complaints24h || []) {
    if (c.count > 0) issues.push({ code: 'email_complaints', severity: c.count >= 3 ? 'critical' : 'warning', domain: c.domain, message: `${c.count} spam complaint${c.count === 1 ? '' : 's'} on ${c.domain} in 24h` })
  }

  // Webhook (provider events) freshness: we sent mail but heard nothing back.
  const wh = age(facts.webhookLastAt)
  indicators.webhook = facts.sentSince6h === 0 ? 'idle' : wh === null ? 'never' : wh > 6 * H ? 'stale' : 'current'
  if (facts.sentSince6h >= 5 && (wh === null || wh > 6 * H)) issues.push({ code: 'email_webhook_silent', severity: 'warning', message: `${facts.sentSince6h} emails sent in 6h but no provider events received — delivery tracking is blind` })

  // Inbound routing.
  const ib = age(facts.inboundLastAt)
  indicators.inbound = !facts.inboundConfigured ? 'not_configured' : ib === null ? 'no_mail_yet' : ib > 72 * H && facts.inbound7dCount > 0 ? 'stale' : 'current'
  if (facts.inboundConfigured && facts.inbound7dCount >= 10 && ib !== null && ib > 24 * H) issues.push({ code: 'email_inbound_stalled', severity: 'critical', message: `No inbound email processed for ${Math.round(ib / H)}h (normally ${Math.round(facts.inbound7dCount / 7)}/day)` })

  indicators.unresolved_24h = facts.unresolved24h
  if (facts.unresolved24h >= 10) issues.push({ code: 'email_resolution_failing', severity: 'warning', message: `${facts.unresolved24h} inbound emails could not be matched in 24h` })
  indicators.attachment_failures_24h = facts.attachmentFailures24h
  if (facts.attachmentFailures24h >= 3) issues.push({ code: 'email_attachments_failing', severity: 'warning', message: `${facts.attachmentFailures24h} attachments failed to store in 24h` })
  indicators.needs_you = facts.needsCount

  const status = issues.some((i) => i.severity === 'critical') ? 'degraded' : issues.length ? 'attention' : 'healthy'
  return { status, indicators, issues, evaluated_at: new Date(now).toISOString() }
}

/** Gather the facts with bounded queries (no full-ledger scans). */
export async function gatherEmailHealthFacts(db, { now = Date.now(), env = process.env } = {}) {
  const iso = (ms) => new Date(ms).toISOString()
  const [controls, due, failed, needs, unresolved, out1h, out7d, compl, inbound7d, atts, sent6h] = await Promise.all([
    db.from('system_control').select('key, value').in('key', ['email_enabled', 'email_dispatch_heartbeat_at', 'email_dispatch_last_sent_at', 'email_webhook_brevo_last_event_at']),
    db.from('email_queue').select('id, scheduled_for').in('queue_status', ['pending_send', 'scheduled']).lte('scheduled_for', iso(now)).limit(1000),
    db.from('email_queue').select('id').eq('queue_status', 'failed').gte('updated_at', iso(now - 24 * H)).limit(1000),
    db.from('email_threads').select('id').eq('needs_operator', true).limit(1000),
    db.from('email_inbound_messages').select('id').eq('processing_status', 'unresolved').gte('received_at', iso(now - 24 * H)).limit(1000),
    db.from('email_events').select('lane, sender_key, sending_domain, event_type').in('event_type', ['sent', 'hard_bounce', 'invalid_address']).gte('event_at', iso(now - H)).limit(5000),
    db.from('email_events').select('lane, sending_domain, event_type').in('event_type', ['sent', 'hard_bounce', 'invalid_address']).gte('event_at', iso(now - 7 * 24 * H)).limit(20000),
    db.from('email_events').select('sending_domain').eq('event_type', 'complaint').gte('event_at', iso(now - 24 * H)).limit(1000),
    db.from('email_inbound_messages').select('received_at').gte('received_at', iso(now - 7 * 24 * H)).order('received_at', { ascending: false }).limit(1000),
    db.from('email_attachments').select('id').eq('fetch_status', 'failed').gte('created_at', iso(now - 24 * H)).limit(1000),
    db.from('email_events').select('event_at').eq('event_type', 'sent').gte('event_at', iso(now - 6 * H)).limit(1000),
  ])
  const c = Object.fromEntries((controls.data || []).map((r) => [r.key, r.value]))
  const agg = (rows, keyFn) => {
    const m = new Map()
    for (const r of rows || []) {
      const k = keyFn(r)
      const cur = m.get(k) || { sent: 0, hardBounce: 0 }
      if (r.event_type === 'sent') cur.sent++
      else cur.hardBounce++
      m.set(k, cur)
    }
    return m
  }
  const a1 = agg(out1h.data, (r) => `${r.lane || 'transactional'}|${r.sending_domain || 'unknown'}`)
  const a7 = agg(out7d.data, (r) => `${r.lane || 'transactional'}|${r.sending_domain || 'unknown'}`)
  const split = (k) => { const [lane, domain] = k.split('|'); return { lane, domain } }
  const complaintsByDomain = new Map()
  for (const r of compl.data || []) complaintsByDomain.set(r.sending_domain || 'unknown', (complaintsByDomain.get(r.sending_domain || 'unknown') || 0) + 1)
  const dueRows = due.data || []
  const sendEnabled = clean(c.email_enabled) === 'true' && clean(env.EMAIL_SEND_ENABLED) === 'true'
  return {
    now,
    sendEnabled,
    disabledReason: clean(c.email_enabled) !== 'true' ? 'operator switch off' : clean(env.EMAIL_SEND_ENABLED) !== 'true' ? 'deployment flag off' : null,
    providerConfigured: Boolean(clean(env.BREVO_API_KEY) || clean(env.BREVO_REIVESTI_API_KEY) || clean(env.BREVO_PROMINENT_API_KEY) || clean(env.BREVO_EVERLINE_API_KEY)),
    dispatchHeartbeatAt: c.email_dispatch_heartbeat_at || null,
    lastSentAt: c.email_dispatch_last_sent_at || null,
    lastAcceptedAt: c.email_dispatch_last_sent_at || null,
    dueCount: dueRows.length,
    oldestDueAt: dueRows.map((r) => r.scheduled_for).filter(Boolean).sort()[0] || null,
    failed24h: (failed.data || []).length,
    needsCount: (needs.data || []).length,
    unresolved24h: (unresolved.data || []).length,
    outbound1h: [...a1].map(([k, v]) => ({ ...split(k), ...v })),
    outbound7d: [...a7].map(([k, v]) => ({ ...split(k), ...v })),
    complaints24h: [...complaintsByDomain].map(([domain, count]) => ({ domain, count })),
    inboundLastAt: (inbound7d.data || [])[0]?.received_at || null,
    inbound7dCount: (inbound7d.data || []).length,
    inboundConfigured: Boolean(clean(env.EMAIL_INBOUND_SECRET)),
    webhookLastAt: c.email_webhook_brevo_last_event_at || null,
    sentSince6h: (sent6h.data || []).length,
    attachmentFailures24h: (atts.data || []).length,
  }
}

export const _internal = { LANES }
