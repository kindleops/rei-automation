/**
 * EMAIL COMMAND SERVICE — bounded, batched reads for the mobile surface, and
 * the operator's thread actions. No N+1: one query per table per page.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { deriveThreadState, closingContext, sellerContext, engagementFromEvents, deliveryStatus } from './email-command-model.js'
import { sanitizeEmailHtml, extractReply } from './email-content.js'
import { signedAttachmentUrl } from './email-attachments.js'
import { recordEmailEvent } from './email-telemetry.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const uniq = (a) => [...new Set(a.filter(Boolean))]
const STATES = ['needs_you', 'system_handling', 'waiting', 'failed', 'unresolved', 'done']

async function hydrate(db, threads) {
  const ids = threads.map((t) => t.id)
  if (!ids.length) return []
  const closingIds = uniq(threads.map((t) => t.closing_case_id))
  const smsKeys = uniq(threads.map((t) => t.sms_thread_key))
  const owners = uniq(threads.map((t) => t.master_owner_id))
  const props = uniq(threads.map((t) => t.property_id))
  const [out, inb, cases, convs, opps, properties] = await Promise.all([
    db.from('email_queue').select('id, thread_id, queue_status, approval_status, scheduled_for, sent_at, updated_at, action_key, sequence, reason, subject, failed_reason, source').in('thread_id', ids).limit(3000),
    db.from('email_inbound_messages').select('id, thread_id, processing_status').in('thread_id', ids).in('processing_status', ['received', 'resolved']).limit(1000),
    closingIds.length ? db.from('closing_cases').select('closing_case_id, property_address, title_acknowledged_at, title_commitment_received_at, title_commitment_date, clear_to_close_at, closing_date_confirmed_at, scheduled_closing_date, closing_tz, closed_at, terminal_outcome, automation_paused_at').in('closing_case_id', closingIds) : { data: [] },
    smsKeys.length ? db.from('inbox_thread_state').select('thread_key, seller_stage, lifecycle_stage, seller_display_name, contactability_status').in('thread_key', smsKeys) : { data: [] },
    owners.length ? db.from('acquisition_opportunities').select('id, master_owner_id, property_id, acquisition_stage, metadata').in('master_owner_id', owners) : { data: [] },
    props.length ? db.from('properties').select('property_id, property_address_full, property_address').in('property_id', props) : { data: [] },
  ])
  const outBy = new Map()
  for (const q of out.data || []) (outBy.get(q.thread_id) || outBy.set(q.thread_id, []).get(q.thread_id)).push(q)
  const inbBy = new Map()
  for (const m of inb.data || []) inbBy.set(m.thread_id, (inbBy.get(m.thread_id) || 0) + 1)
  const caseBy = new Map((cases.data || []).map((c) => [c.closing_case_id, c]))
  const convBy = new Map((convs.data || []).map((c) => [c.thread_key, c]))
  const propBy = new Map((properties.data || []).map((p) => [p.property_id, p.property_address_full || p.property_address]))
  const oppFor = (t) => (opps.data || []).find((o) => o.master_owner_id === t.master_owner_id && (!t.property_id || o.property_id === t.property_id)) || null

  return threads.map((t) => {
    const derived = deriveThreadState(t, { outbound: outBy.get(t.id) || [], inboundUnhandled: inbBy.get(t.id) || 0 })
    const address = propBy.get(t.property_id) || null
    const context = t.closing_case_id
      ? closingContext(caseBy.get(t.closing_case_id) || { closing_case_id: t.closing_case_id }, t.category === 'buyer' ? 'buyer' : 'title')
      : t.category === 'seller' ? sellerContext(convBy.get(t.sms_thread_key) || null, oppFor(t), address) : null
    return {
      id: t.id,
      category: t.category,
      counterparty: { name: t.counterparty_name || null, email: t.counterparty_email || null, role: t.counterparty_role || t.category },
      subject: t.subject || null,
      property_address: address || context?.property_address || null,
      last_message: { at: t.last_message_at, direction: t.last_message_direction, preview: t.last_message_preview },
      needs: t.needs_operator ? { code: t.needs_code, reason: t.needs_reason, since: t.needs_since } : null,
      resolution: t.resolution_status,
      contact_preference: t.contact_preference || null,
      context,
      ...derived,
    }
  })
}

export async function getEmailCommandHome({ filter = null, q = null, limit = 150 } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  let query = db.from('email_threads').select('*').order('last_message_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 150, 1), 300))
  const f = lower(filter)
  if (['seller', 'title', 'buyer', 'lender'].includes(f)) query = query.eq('category', f)
  if (f === 'closings') query = query.in('category', ['title', 'buyer', 'lender'])
  if (clean(q)) query = query.or(`counterparty_email.ilike.%${clean(q).replace(/[%,()]/g, '')}%,counterparty_name.ilike.%${clean(q).replace(/[%,()]/g, '')}%,subject.ilike.%${clean(q).replace(/[%,()]/g, '')}%,last_message_preview.ilike.%${clean(q).replace(/[%,()]/g, '')}%`)
  const [{ data: threads, error }, controls] = await Promise.all([
    query,
    db.from('system_control').select('key, value').in('key', ['email_enabled', 'email_health_last', 'email_dispatch_heartbeat_at']),
  ])
  if (error) return { ok: false, error: 'threads_unreadable', message: error.message }
  let rows = await hydrate(db, threads || [])
  if (STATES.includes(f)) rows = rows.filter((r) => r.state === f)
  const counts = Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length]))
  const c = Object.fromEntries((controls.data || []).map((r) => [r.key, r.value]))
  let health = null
  try { health = c.email_health_last ? JSON.parse(c.email_health_last) : null } catch { health = null }
  return {
    ok: true,
    counts,
    needs_you: rows.filter((r) => r.state === 'needs_you').sort((a, b) => String(a.needs?.since || a.last_message.at).localeCompare(String(b.needs?.since || b.last_message.at))),
    system_handling: rows.filter((r) => r.state === 'system_handling').sort((a, b) => String(a.next?.at || '9').localeCompare(String(b.next?.at || '9'))),
    waiting: rows.filter((r) => r.state === 'waiting').sort((a, b) => String(a.last_message.at).localeCompare(String(b.last_message.at))),
    failed: rows.filter((r) => r.state === 'failed'),
    unresolved: rows.filter((r) => r.state === 'unresolved'),
    recent: rows.slice(0, 40),
    delivery: {
      send_enabled: clean(c.email_enabled) === 'true' && clean(process.env.EMAIL_SEND_ENABLED) === 'true',
      operator_switch: clean(c.email_enabled) === 'true',
      heartbeat_at: c.email_dispatch_heartbeat_at || null,
      health,
    },
    truncated: (threads || []).length >= limit,
  }
}

export async function getEmailCommandThread(threadId, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const { data: thread, error } = await db.from('email_threads').select('*').eq('id', threadId).maybeSingle()
  if (error) return { ok: false, error: 'thread_unreadable' }
  if (!thread) return { ok: false, error: 'not_found', status: 404 }
  const [summary] = await hydrate(db, [thread])
  const [out, inb, atts, closingEvents] = await Promise.all([
    db.from('email_queue').select('*').eq('thread_id', threadId).order('created_at', { ascending: true }).limit(200),
    db.from('email_inbound_messages').select('*').eq('thread_id', threadId).order('received_at', { ascending: true }).limit(200),
    db.from('email_attachments').select('*').eq('thread_id', threadId).limit(200),
    thread.closing_case_id ? db.from('closing_activity_events').select('event_type, actor, source, detail, created_at').eq('closing_case_id', thread.closing_case_id).limit(200) : { data: [] },
  ])
  // Events by MESSAGE id: provider events may arrive before a message is threaded.
  const outIds = (out.data || []).map((q) => q.id)
  const events = outIds.length ? await db.from('email_events').select('queue_id, event_type, event_at, signal_class, reason, event_source').in('queue_id', outIds).limit(3000) : { data: [] }
  const evBy = new Map()
  for (const e of events.data || []) (evBy.get(e.queue_id) || evBy.set(e.queue_id, []).get(e.queue_id)).push(e)
  const attBy = new Map()
  for (const a of atts.data || []) {
    const k = a.inbound_message_id || a.queue_id
    ;(attBy.get(k) || attBy.set(k, []).get(k)).push(a)
  }
  const attachmentView = async (a) => ({
    id: a.id, filename: a.filename, content_type: a.content_type, size_bytes: a.size_bytes, doc_type: a.doc_type,
    confidence: a.classification_confidence, review_state: a.review_state, fetch_status: a.fetch_status,
    routed: a.routed_entity_id ? { type: a.routed_entity_type, id: a.routed_entity_id } : null,
    url: await signedAttachmentUrl(db, a).catch(() => null),
  })

  const items = []
  for (const q of out.data || []) {
    if (q.queue_status === 'draft' && q.approval_status !== 'required') continue
    const eng = engagementFromEvents(evBy.get(q.id) || [])
    items.push({
      kind: 'outbound', id: q.id, at: q.sent_at || q.scheduled_for || q.created_at,
      from: { email: q.from_email, name: q.from_name }, to: q.to_email, subject: q.subject,
      text: q.text_body || null, html: q.html_body ? sanitizeEmailHtml(q.html_body) : null,
      status: deliveryStatus(q, eng), engagement: eng, automated: q.source !== 'manual',
      action: q.action_key, sequence: q.sequence, why: q.reason || null, cancel_reason: q.cancel_reason || null,
      attachments: await Promise.all((attBy.get(q.id) || []).map(attachmentView)),
    })
  }
  for (const m of inb.data || []) {
    const parts = extractReply(m.text_body || '')
    items.push({
      kind: 'inbound', id: m.id, at: m.received_at,
      from: { email: m.from_email, name: m.from_name }, subject: m.subject,
      reply: m.reply_text || parts.reply, quoted: parts.quoted, signature: m.signature_text || parts.signature,
      html: m.html_body ? sanitizeEmailHtml(m.html_body) : null,
      status: m.processing_status, understood: m.classification || {},
      attachments: await Promise.all((attBy.get(m.id) || []).map(attachmentView)),
    })
  }
  const SYSTEM = { title_acknowledged: 'Title acknowledged the order', title_commitment_date_set: 'Commitment date recorded', title_commitment_received: 'Title commitment received', clear_to_close: 'Clear to close recorded', title_issue_opened: 'Title issue opened', closing_date_changed: 'Closing date changed', automation_escalated: 'Automation escalated to you' }
  for (const e of closingEvents.data || []) {
    if (!SYSTEM[e.event_type]) continue
    if (e.created_at && thread.created_at && e.created_at < thread.created_at) continue
    items.push({ kind: 'system', at: e.created_at, label: SYSTEM[e.event_type], source: e.source || null, detail: e.detail || null })
  }
  const STAGE_NAME = { ownership_confirmation: 'S1 Ownership', offer_interest: 'S2 Offer interest', asking_price: 'S3 Asking price', property_condition: 'S4 Condition', offer: 'S5 Offer', formal_contract: 'S6 Contract' }
  const FACT_LINE = (k, f) => {
    const v = f?.value
    if (k === 'asking_price' && v?.amount) return `Asking price captured · $${Number(v.amount).toLocaleString('en-US')}`
    if (v === null || v === undefined || typeof v === 'object') return `${k.replace(/_/g, ' ')} captured`
    return `${k.replace(/_/g, ' ')} · ${v}`
  }
  for (const m of inb.data || []) {
    const c = m.classification || {}
    if (thread.category === 'seller' && (c.facts || c.stage_after)) {
      const at = m.handled_at || m.received_at
      for (const [k, f] of Object.entries(c.facts || {})) items.push({ kind: 'system', at, label: FACT_LINE(k, f), source: 'seller_brain' })
      if (c.stage_after) items.push({ kind: 'system', at, label: `Seller stage → ${STAGE_NAME[c.stage_after] || c.stage_after.replace(/_/g, ' ')}`, source: 'seller_brain' })
      if (c.sms_followups_cancelled) items.push({ kind: 'system', at, label: `Pending SMS follow-up stopped — seller answered by email`, source: 'seller_brain' })
      if (c.next_use_case) items.push({ kind: 'system', at, label: `Next: ${c.next_use_case.replace(/_probe|_/g, (x) => (x === '_probe' ? '' : ' ')).trim()}`, source: 'seller_brain' })
    }
  }
  for (const m of inb.data || []) {
    const applied = m.classification?.applied || []
    for (const a of applied.filter((x) => x.ok && !x.duplicate)) items.push({ kind: 'system', at: m.handled_at || m.received_at, label: `From this email: ${a.type.replace(/_/g, ' ')}${a.value ? ` · ${String(a.value).replace(/_/g, ' ')}` : ''}`, source: 'email_command' })
  }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return { ok: true, thread: summary, sms_thread_key: thread.sms_thread_key || null, items }
}

export async function getEmailMessageTelemetry(queueId, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const { data: q } = await db.from('email_queue').select('*').eq('id', queueId).maybeSingle()
  if (!q) return { ok: false, error: 'not_found', status: 404 }
  const [{ data: events }, { data: links }] = await Promise.all([
    db.from('email_events').select('event_type, event_at, event_source, provider, signal_class, signal_confidence, reason, link_id, raw_payload').eq('queue_id', queueId).order('event_at', { ascending: true }).limit(1000),
    db.from('email_links').select('id, link_index, destination_url').eq('queue_id', queueId),
  ])
  const eng = engagementFromEvents(events || [])
  return {
    ok: true,
    message: {
      id: q.id, logical_id: q.queue_key, subject: q.subject, to: q.to_email, from: q.from_email, sender: q.sender_key, sending_domain: q.sending_domain,
      provider: q.provider, provider_message_id: q.provider_message_id, message_id_header: q.message_id_header,
      lane: q.lane, origin: q.origin, source: q.source, campaign_id: q.campaign_id, sequence_step: q.sequence_step,
      template: q.template_id, template_version: q.template_version, status: deliveryStatus(q, eng),
      scheduled_for: q.scheduled_for, sent_at: q.sent_at, retry_count: q.retry_count, why: q.reason || null, cancel_reason: q.cancel_reason || null,
    },
    engagement: eng,
    links: (links || []).map((l) => ({ ...l, clicks: (events || []).filter((e) => e.link_id === l.id).length })),
    events: (events || []).map(({ raw_payload, ...e }) => ({ ...e, has_provider_payload: Boolean(raw_payload) })),
  }
}

export async function getEmailMetrics({ dimension = 'lane', days = 30, campaignId = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const from = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 864e5).toISOString()
  const { data, error } = await db.rpc('email_metrics', { p_dimension: dimension, p_from: from, p_to: new Date().toISOString(), p_campaign_id: campaignId })
  if (error) return { ok: false, error: 'metrics_unreadable', message: error.message }
  const rows = (data || []).map((r) => ({
    ...r,
    // Each rate names its denominator.
    delivery_rate: r.sent ? r.delivered / r.sent : null,
    unique_open_signal_rate: r.delivered ? r.unique_openers / r.delivered : null,
    unique_reply_rate: r.delivered ? r.unique_responders / r.delivered : null,
    hard_bounce_rate: r.sent ? r.hard_bounces / r.sent : null,
  }))
  return { ok: true, dimension, days, rows, caveat: 'Open signals include privacy proxies and scanners; judge by replies and outcomes.' }
}

/* ── operator actions ─────────────────────────────────────────────────── */

const fail = (code, message, status = 422) => ({ ok: false, code, message, status })

export async function applyEmailThreadAction(threadId, action, fields = {}, { actor, supabase } = {}) {
  const db = supabase || defaultSupabase
  if (!clean(actor)) return fail('ACTOR_REQUIRED', 'Sign in to act on email', 401)
  const { data: t } = await db.from('email_threads').select('*').eq('id', threadId).maybeSingle()
  if (!t) return fail('NOT_FOUND', 'No such conversation', 404)
  const now = new Date().toISOString()
  switch (action) {
    case 'take_over': {
      await db.from('email_threads').update({ automation_state: 'taken_over', taken_over_by: actor, taken_over_at: now, takeover_reason: clean(fields.reason) || null, updated_at: now }).eq('id', threadId)
      const { data: stopped } = await db.from('email_queue').update({ queue_status: 'cancelled', cancel_reason: 'operator_took_over', updated_at: now }).eq('thread_id', threadId).neq('source', 'manual').in('queue_status', ['pending_send', 'scheduled']).select('id')
      for (const s of stopped || []) await recordEmailEvent(db, { type: 'automation_stopped', source: 'manual_operator', message: { id: s.id, thread_id: threadId }, key: `takeover:${s.id}`, reason: 'operator_took_over' }).catch(() => null)
      return { ok: true, stopped: (stopped || []).length }
    }
    case 'return_to_system':
      if (t.automation_state !== 'taken_over' && t.automation_state !== 'paused') return { ok: true, duplicate: true }
      await db.from('email_threads').update({ automation_state: 'active', taken_over_by: null, taken_over_at: null, takeover_reason: null, updated_at: now }).eq('id', threadId)
      return { ok: true }
    case 'mark_read':
      await db.from('email_threads').update({ operator_read_at: now }).eq('id', threadId)
      return { ok: true }
    case 'resolve_needs':
      if (!t.needs_operator) return { ok: true, duplicate: true }
      await db.from('email_threads').update({ needs_operator: false, needs_code: null, needs_reason: null, needs_since: null, metadata: { ...(t.metadata || {}), last_resolution: { by: actor, at: now, code: t.needs_code, note: clean(fields.note) || null } }, updated_at: now }).eq('id', threadId)
      return { ok: true }
    case 'approve_send': {
      const { data: q } = await db.from('email_queue').select('*').eq('id', clean(fields.queue_id)).eq('thread_id', threadId).maybeSingle()
      if (!q) return fail('MESSAGE_NOT_FOUND', 'No such draft')
      if (!['awaiting_approval', 'draft'].includes(q.queue_status)) return fail('NOT_AWAITING_APPROVAL', 'This message is not waiting for approval')
      await db.from('email_queue').update({ approval_status: 'approved', approved_by: actor, approved_at: now, queue_status: 'pending_send', scheduled_for: now, updated_at: now }).eq('id', q.id)
      return { ok: true }
    }
    case 'cancel_message': {
      const { data } = await db.from('email_queue').update({ queue_status: 'cancelled', cancel_reason: `operator_cancelled:${actor}`, updated_at: now }).eq('id', clean(fields.queue_id)).eq('thread_id', threadId).in('queue_status', ['pending_send', 'scheduled', 'awaiting_approval', 'draft']).select('id')
      if (!(data || []).length) return fail('NOT_CANCELLABLE', 'Already sent or not found')
      return { ok: true }
    }
    case 'review_attachment': {
      const decision = lower(fields.decision)
      if (!['reviewed', 'rejected'].includes(decision)) return fail('BAD_DECISION', 'Mark reviewed or rejected')
      const { data } = await db.from('email_attachments').update({ review_state: decision, doc_type: clean(fields.doc_type) || undefined, reviewed_by: actor, reviewed_at: now }).eq('id', clean(fields.attachment_id)).eq('thread_id', threadId).select('id')
      if (!(data || []).length) return fail('ATTACHMENT_NOT_FOUND', 'No such attachment')
      // Reviewing a document never changes money or closing state; that is a separate, explicit authority action.
      return { ok: true }
    }
    default:
      return fail('UNKNOWN_ACTION', `Unknown action ${action}`, 400)
  }
}
