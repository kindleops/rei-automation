/**
 * INBOUND EMAIL — receive, dedupe, resolve, route. Runs without any UI open.
 *
 * Resolution hierarchy (first confident answer wins; ambiguity is NEVER
 * guessed — an email is never attached to the wrong seller or deal):
 *   1. reply token in To/Cc          reply+<token>@…            1.00
 *   2. In-Reply-To / References      one of our Message-IDs     0.98
 *   3. known counterparty thread     exactly one live thread    0.90
 *   4. seller email graph            address → one owner with a live
 *                                    conversation / property    0.85
 *   5. title-company domain          exactly one open closing   0.80
 *   else UNRESOLVED (own bucket; nothing downstream runs).
 *
 * Routing after resolution:
 *   seller  → the seller brain (same one SMS uses) via deps.handleSellerEmail
 *   title / buyer → classifyCounterpartyEmail → assertions submitted to
 *             Closing Authority, which decides (email never sets state)
 *   anything needing judgment → thread NEEDS YOU + notification
 */
import crypto from 'node:crypto'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { emitNotificationFromBusinessEvent } from '@/lib/domain/notifications/notification-emitter.js'
import { normalizeInboundEmail, inboundDedupeKey, isAutomatedMail } from './email-content.js'
import { classifyCounterpartyEmail, classifyAttachment } from './email-inbound-classify.js'
import { ensureThread, threadKeyFor, parseReplyToken } from './email-identity.js'
import { submitClosingAssertions } from './email-closing-intake.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const domainOf = (e) => lower(e).split('@')[1] || ''

const LIVE_STAGES_EXCLUDED = new Set(['closed', 'dead', 'suppressed'])

export async function resolveInboundThread(db, msg) {
  // 1 · reply token
  const token = parseReplyToken([...msg.to_emails, ...msg.cc_emails])
  if (token) {
    const { data } = await db.from('email_threads').select('*').eq('reply_token', token).maybeSingle()
    if (data) return { thread: data, method: 'reply_token', confidence: 1 }
  }
  // 2 · message references
  const refs = [...new Set([msg.in_reply_to, ...msg.references_headers].filter(Boolean))]
  if (refs.length) {
    const { data: out } = await db.from('email_queue').select('thread_id').in('message_id_header', refs)
    const ids = [...new Set((out || []).map((r) => r.thread_id).filter(Boolean))]
    if (ids.length === 1) {
      const { data } = await db.from('email_threads').select('*').eq('id', ids[0]).maybeSingle()
      if (data) return { thread: data, method: 'message_reference', confidence: 0.98 }
    }
    if (!ids.length) {
      const { data: inb } = await db.from('email_inbound_messages').select('thread_id').in('message_id_header', refs)
      const tids = [...new Set((inb || []).map((r) => r.thread_id).filter(Boolean))]
      if (tids.length === 1) {
        const { data } = await db.from('email_threads').select('*').eq('id', tids[0]).maybeSingle()
        if (data) return { thread: data, method: 'message_reference', confidence: 0.98 }
      }
    }
  }
  // 3 · a live thread with this counterparty
  const { data: known } = await db.from('email_threads').select('*').eq('counterparty_email', msg.from_email)
  const live = (known || []).filter((t) => t.automation_state !== 'completed' && t.resolution_status === 'resolved')
  if (live.length === 1) return { thread: live[0], method: 'counterparty_thread', confidence: 0.9 }
  if (live.length > 1) {
    const hit = live.filter((t) => t.subject && lower(msg.subject).includes(lower(t.subject).split(',')[0]))
    if (hit.length === 1) return { thread: hit[0], method: 'counterparty_thread_subject', confidence: 0.85 }
    return { ambiguous: true, candidates: live.map((t) => ({ thread_id: t.id, thread_key: t.thread_key, category: t.category, subject: t.subject })), method: 'counterparty_multiple' }
  }
  // 4 · seller email graph
  const { data: owners } = await db.from('emails').select('master_owner_id, owner_display_name, email_role, is_best_email_for_owner').eq('email_normalized', msg.from_email)
  const ownerIds = [...new Set((owners || []).map((o) => o.master_owner_id).filter(Boolean))]
  if (ownerIds.length) {
    const { data: convs } = await db.from('inbox_thread_state').select('thread_key, master_owner_id, prospect_id, property_id, seller_stage, lifecycle_stage, is_suppressed, contactability_status, seller_display_name, last_inbound_at, last_outbound_at').in('master_owner_id', ownerIds)
    const liveConvs = (convs || []).filter((c) => !LIVE_STAGES_EXCLUDED.has(lower(c.lifecycle_stage)) && (c.last_outbound_at || c.last_inbound_at))
    const liveOwners = [...new Set(liveConvs.map((c) => c.master_owner_id))]
    if (liveOwners.length === 1) {
      const mine = liveConvs.filter((c) => c.master_owner_id === liveOwners[0])
      const props = [...new Set(mine.map((c) => c.property_id).filter(Boolean))]
      let pick = mine.length === 1 ? mine[0] : null
      if (!pick && props.length > 1) {
        const body = lower(`${msg.subject} ${msg.reply_text}`)
        const { data: ps } = await db.from('properties').select('property_id, property_address_full, property_address').in('property_id', props)
        const hits = (ps || []).filter((p) => { const a = lower(p.property_address_full || p.property_address).split(',')[0]; return a && body.includes(a) })
        if (hits.length === 1) pick = mine.find((c) => c.property_id === hits[0].property_id)
      }
      if (!pick && props.length <= 1) pick = [...mine].sort((a, b) => String(b.last_outbound_at || b.last_inbound_at).localeCompare(String(a.last_outbound_at || a.last_inbound_at)))[0]
      if (pick) {
        const thread = await ensureThread(db, {
          thread_key: threadKeyFor({ category: 'seller', masterOwnerId: pick.master_owner_id, propertyId: pick.property_id }),
          category: 'seller', counterparty_email: msg.from_email, counterparty_name: pick.seller_display_name || owners[0]?.owner_display_name || msg.from_name,
          counterparty_role: 'seller', master_owner_id: pick.master_owner_id, prospect_id: pick.prospect_id, property_id: pick.property_id,
          resolution_method: ownerIds.length > 1 ? 'seller_graph_live_owner' : 'seller_graph', subject: msg.subject,
          metadata: { sms_thread_key: pick.thread_key },
        })
        if (!thread.sms_thread_key && pick.thread_key) {
          await db.from('email_threads').update({ sms_thread_key: pick.thread_key }).eq('id', thread.id)
          thread.sms_thread_key = pick.thread_key
        }
        return { thread, method: 'seller_graph', confidence: ownerIds.length > 1 ? 0.8 : 0.85, sellerConversation: pick }
      }
      return { ambiguous: true, candidates: mine.map((c) => ({ master_owner_id: c.master_owner_id, property_id: c.property_id, sms_thread_key: c.thread_key })), method: 'seller_multiple_properties' }
    }
    if (liveOwners.length > 1) return { ambiguous: true, candidates: liveOwners.map((id) => ({ master_owner_id: id })), method: 'seller_shared_address' }
  }
  // 5 · title company domain → exactly one open closing
  const dom = domainOf(msg.from_email)
  if (dom) {
    const { data: cases } = await db.from('closing_cases').select('closing_case_id, title_company_email, property_address, terminal_outcome, closed_at, opportunity_id, property_id, master_owner_id, title_company_id, brand_key').ilike('title_company_email', `%@${dom}`)
    const open = (cases || []).filter((c) => !c.terminal_outcome && !c.closed_at)
    if (open.length === 1) {
      const c = open[0]
      const thread = await ensureThread(db, { thread_key: threadKeyFor({ closingCaseId: c.closing_case_id, leg: 'title' }), category: 'title', counterparty_email: msg.from_email, counterparty_role: 'title', closing_case_id: c.closing_case_id, opportunity_id: c.opportunity_id, property_id: c.property_id, master_owner_id: c.master_owner_id, title_company_id: c.title_company_id, brand_key: c.brand_key, subject: c.property_address, resolution_method: 'title_domain' })
      return { thread, method: 'title_domain', confidence: 0.8 }
    }
    if (open.length > 1) return { ambiguous: true, candidates: open.map((c) => ({ closing_case_id: c.closing_case_id, property_address: c.property_address })), method: 'title_domain_multiple' }
  }
  return { unresolved: true, method: 'no_match' }
}

async function flagThread(db, thread, needs, now) {
  if (!thread?.id || !needs) return
  await db.from('email_threads').update({ needs_operator: true, needs_code: needs.code, needs_reason: needs.reason, needs_since: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }).eq('id', thread.id)
}

/** One inbound message, end to end. Idempotent on the dedupe key. */
export async function ingestInboundEmail(item, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const notify = deps.notify || emitNotificationFromBusinessEvent
  const now = deps.now ? deps.now() : Date.now()
  const msg = item?.__normalized ? item : normalizeInboundEmail(item)
  if (!msg.from_email) return { ok: false, code: 'missing_sender' }
  const dedupeKey = inboundDedupeKey(msg)

  const { data: prior } = await db.from('email_inbound_messages').select('id, thread_id, processing_status').eq('dedupe_key', dedupeKey).maybeSingle()
  if (prior) return { ok: true, duplicate: true, id: prior.id, thread_id: prior.thread_id }

  const automated = isAutomatedMail(msg)
  const resolution = automated ? { unresolved: true, method: `automated:${automated}` } : await resolveInboundThread(db, msg)

  let thread = resolution.thread || null
  if (!thread) {
    thread = await ensureThread(db, {
      thread_key: threadKeyFor({ category: 'unresolved', email: msg.from_email }),
      category: 'unresolved', counterparty_email: msg.from_email, counterparty_name: msg.from_name, subject: msg.subject,
      resolution_status: resolution.ambiguous ? 'ambiguous' : 'unresolved', resolution_method: resolution.method,
      resolution_candidates: resolution.candidates || [],
    })
  }

  const row = {
    dedupe_key: dedupeKey, provider: deps.provider || 'brevo', provider_message_id: msg.provider_message_id,
    message_id_header: msg.message_id_header, in_reply_to: msg.in_reply_to, references_headers: msg.references_headers,
    from_email: msg.from_email, from_name: msg.from_name, to_emails: msg.to_emails, cc_emails: msg.cc_emails,
    reply_token: parseReplyToken([...msg.to_emails, ...msg.cc_emails]), subject: msg.subject,
    text_body: msg.text_body, html_body: msg.html_body, reply_text: msg.reply_text, signature_text: msg.signature_text,
    received_at: msg.received_at, thread_id: thread.id, resolution_method: resolution.method, resolution_confidence: resolution.confidence ?? null,
    processing_status: resolution.thread ? 'resolved' : automated ? 'ignored' : 'unresolved',
    attachment_count: msg.attachments.length, headers: msg.headers,
  }
  const ins = await db.from('email_inbound_messages').insert(row).select('*').maybeSingle()
  if (ins.error) {
    if (ins.error.code === '23505') return { ok: true, duplicate: true }
    throw ins.error
  }
  const inbound = ins.data || row

  const verified = Boolean(resolution.thread) && ['reply_token', 'message_reference', 'counterparty_thread', 'counterparty_thread_subject', 'title_domain'].includes(resolution.method) &&
    (thread.category !== 'title' || !thread.counterparty_email || domainOf(thread.counterparty_email) === domainOf(msg.from_email))

  // Attachments: record now; bytes are fetched by the attachment worker.
  const attachments = []
  for (const a of msg.attachments) {
    const cls = classifyAttachment({ filename: a.filename, contentType: a.content_type, sizeBytes: a.size_bytes, senderVerified: verified, role: thread.category })
    if (cls.fetch === 'skip_inline') continue
    const att = {
      attachment_key: `in:${inbound.id}:${a.index}`, inbound_message_id: inbound.id, thread_id: thread.id,
      filename: a.filename, content_type: a.content_type, size_bytes: a.size_bytes, provider_download_token: a.download_token,
      fetch_status: cls.fetch === 'blocked' ? 'blocked' : cls.fetch === 'too_large' ? 'too_large' : 'pending',
      doc_type: cls.doc_type, classification_confidence: cls.confidence, classification_method: 'filename_rules',
      review_state: cls.review_state,
    }
    const r = await db.from('email_attachments').insert(att).select('*').maybeSingle()
    attachments.push(r.data || att)
  }

  const result = { ok: true, id: inbound.id, thread_id: thread.id, resolution: resolution.method, category: thread.category, actions: [] }

  if (automated) return { ...result, ignored: automated }
  if (!resolution.thread) {
    if (resolution.ambiguous) {
      const needs = { code: 'identity_ambiguous', reason: `Could not tell which ${resolution.method.startsWith('seller') ? 'seller or property' : 'deal'} this is about — ${resolution.candidates?.length || 0} possible matches` }
      await flagThread(db, thread, needs, now)
      await safeNotify(notify, { eventType: 'email_needs_operator', titleVars: { counterparty: msg.from_name || msg.from_email }, description: needs.reason, sourceEntityType: 'email_thread', sourceEntityId: thread.id, deduplicationKey: `email_needs:${thread.id}:identity` })
    }
    return { ...result, unresolved: true }
  }

  // Operator owns the thread: record, notify, run nothing.
  if (thread.automation_state === 'taken_over') {
    await db.from('email_inbound_messages').update({ processing_status: 'needs_operator' }).eq('id', inbound.id)
    await flagThread(db, thread, { code: 'reply_on_taken_over_thread', reason: 'New reply on a conversation you took over' }, now)
    return { ...result, taken_over: true }
  }

  if (thread.category === 'seller') {
    const handler = deps.handleSellerEmail
    if (!handler) {
      await flagThread(db, thread, { code: 'seller_brain_unavailable', reason: 'Seller replied by email — automation could not process it' }, now)
      return { ...result, seller: 'no_handler' }
    }
    const seller = await handler({ inbound: { ...inbound, reply_text: msg.reply_text }, thread, resolution }, deps)
    await db.from('email_inbound_messages').update({ processing_status: seller?.needsOperator ? 'needs_operator' : 'handled', handled_at: new Date(now).toISOString(), handled_by: 'seller_brain', classification: seller?.classification || {} }).eq('id', inbound.id)
    if (seller?.needsOperator) await flagThread(db, thread, seller.needsOperator, now)
    return { ...result, seller }
  }

  // Transaction counterparties.
  const cls = classifyCounterpartyEmail({ text: msg.reply_text || msg.text_body, subject: msg.subject, role: thread.category, receivedAt: msg.received_at, attachments })
  let intake = { applied: [], needs: null }
  if (thread.closing_case_id && ['title', 'buyer', 'lender'].includes(thread.category)) {
    intake = await submitClosingAssertions({ db, thread, inbound, classification: cls, attachments, verified, now }, deps)
  }
  const needs = cls.needs || intake.needs
  await db.from('email_inbound_messages').update({ processing_status: needs ? 'needs_operator' : 'handled', classification: { ...cls, applied: intake.applied }, handled_at: new Date(now).toISOString(), handled_by: 'email_command' }).eq('id', inbound.id)
  if (needs) {
    await flagThread(db, thread, needs, now)
    if (thread.closing_case_id && ['title_issue', 'wire_instructions_received', 'legal_language'].includes(needs.code)) {
      await db.from('closing_cases').update({ automation_paused_at: new Date(now).toISOString(), automation_paused_reason: `email:${needs.code}`, automation_paused_by: 'email_command' }).eq('closing_case_id', thread.closing_case_id).is('automation_paused_at', null)
    }
    await safeNotify(notify, { eventType: 'email_needs_operator', severity: ['wire_instructions_received', 'legal_language', 'title_issue'].includes(needs.code) ? 'critical' : 'warning', titleVars: { counterparty: thread.counterparty_name || msg.from_name || msg.from_email }, description: needs.reason, sourceEntityType: 'email_thread', sourceEntityId: thread.id, closingId: thread.closing_case_id, propertyId: thread.property_id, deduplicationKey: `email_needs:${inbound.id}` })
  }
  const review = attachments.filter((a) => a.review_state === 'needs_review')
  if (review.length) await safeNotify(notify, { eventType: 'email_attachment_review', titleVars: { counterparty: thread.counterparty_name || msg.from_email }, description: review.map((a) => a.filename).join(', '), sourceEntityType: 'email_thread', sourceEntityId: thread.id, deduplicationKey: `email_attach:${inbound.id}` })
  return { ...result, classification: cls, applied: intake.applied, needs }
}

async function safeNotify(notify, n) {
  try { await notify(n) } catch { /* best effort */ }
}

export const _internal = { crypto }
