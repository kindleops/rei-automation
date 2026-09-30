/**
 * EMAIL COMMAND — thread intelligence (read-only, pure).
 *
 * Explains ONE conversation for the desktop inspector: what it is about now,
 * what automation is doing with it, WHY (in business language), and which
 * other systems it is truly linked to. It never decides anything and never
 * restates the visible conversation.
 *
 * Every line is derived from a stored field (thread, outbox rows, inbound
 * classification, closing case, provider events) or states a rule that the
 * email code paths enforce (send-safety gate, dispatcher, inbound routing).
 * Times are returned as ISO timestamps with a format hint ({at} in the text)
 * so the operator's own clock and timezone render them. Where the data cannot
 * support a claim (e.g. sentiment, or the stage before a single reply) the
 * field is null — the UI says nothing rather than guessing.
 */
import { STAGE_LABEL, dueLabel, deliveryStatus, engagementFromEvents, outboxStatus } from './email-command-model.js'
import { isChaseAction } from './email-send-safety.js'

const clean = (v) => String(v ?? '').trim()
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const human = (v) => { const s = clean(v).replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ROLE = { seller: 'Seller', title: 'Title', buyer: 'Buyer', lender: 'Lender', attorney: 'Attorney', agent: 'Agent', vendor: 'Vendor', unresolved: 'Sender', other: 'Contact', internal: 'Internal' }
const PENDING = new Set(['pending_send', 'scheduled', 'sending'])
const SENTISH = new Set(['sent', 'delivered', 'bounced', 'failed'])

const ACTION = {
  'closing.title_open': 'Title order',
  'closing.title_intro': 'Title introduction',
  'closing.title_commitment_reminder': 'Commitment reminder',
  'closing.buyer_agreement_followup': 'Buyer agreement follow-up',
  'seller.followup': 'Seller follow-up',
}
export function actionLabel(q = {}) {
  const k = clean(q.action_key)
  const base = ACTION[k] || (k.startsWith('seller.reply') ? 'Reply to the seller' : k ? human(k.split('.').pop()) : 'Email')
  return Number(q.sequence) > 1 ? `Follow-up #${q.sequence} · ${base}` : base
}

/* Why each needs-you code reaches a person — the rule the email code path enforces. */
const NEEDS_RULE = {
  title_issue: 'Title reported a defect — liens, judgments and vesting problems always go to a person',
  wire_instructions_received: 'The email mentions wire or bank details — those are never acted on automatically',
  legal_language: 'The email contains legal language — automation stops and a person reviews it',
  approval_required: 'The counterparty asked to change terms — terms are always your decision',
  closing_date_proposed: 'A closing date was proposed — it only updates the closing once you confirm it',
  direction_requested: 'The counterparty asked for direction',
  reply_needs_review: 'Automation could not tell what this reply means',
  identity_ambiguous: 'More than one seller or deal matched this sender',
  reply_on_taken_over_thread: 'You own this conversation — automation stays out of it',
  seller_needs_review: 'The seller brain asked for your judgment on this reply',
  seller_brain_unavailable: 'Automation could not process the seller’s reply',
  seller_email_no_conversation: 'This seller has no linked conversation yet, so automation cannot answer',
  automation_failed: 'An automated email failed and was handed to you',
  address_bounced: 'The last email bounced',
  recipient_suppressed: 'The address is suppressed — automation does not email it',
  transport_outcome_unknown: 'A send timed out — it is never re-sent automatically',
  stale_scheduled_message: 'A scheduled email was badly overdue, so it was held instead of sent late',
  recipient_identity_uncertain: 'Who the recipient is became uncertain, so automation stopped',
  business_state_changed: 'The deal changed after the email was planned, so automation stopped',
  title_contact_changed: 'The title contact changed after the email was planned, so automation stopped',
}
/** Needs-you codes the inbound router also pauses closing automation for (email-inbound.js). */
const PAUSES_CLOSING = new Set(['title_issue', 'wire_instructions_received', 'legal_language'])

const line = (text, extra = {}) => ({ text, at: null, fmt: null, tone: null, ...extra })

function lastInbound(inbound) {
  return [...inbound].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at))).at(-1) || null
}

function sellerStage(inbound) {
  const staged = [...inbound].filter((m) => clean(m.classification?.stage_after)).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
  const last = staged.at(-1)
  if (!last) return null
  const to = clean(last.classification.stage_after)
  const prev = staged.length > 1 ? clean(staged.at(-2).classification.stage_after) : null
  const label = (k) => STAGE_LABEL[k] || human(k)
  // Only two recorded replies can prove movement; one reply only says where it left the stage.
  return { label: label(to), moved: prev ? (prev === to ? 'stayed' : 'moved') : null, from: prev && prev !== to ? label(prev) : null, at: last.handled_at || last.received_at }
}

function intentOf(summary, inbound) {
  const m = lastInbound(inbound)
  if (!m) return null
  const c = m.classification || {}
  if (clean(c.primary_intent)) return { label: human(c.primary_intent), source: 'Seller brain', at: m.received_at }
  const applied = (c.applied || []).filter((a) => a.ok).map((a) => human(a.type))
  if (applied.length) return { label: applied.join(' · '), source: 'Email Command', at: m.received_at }
  const asserted = (c.assertions || []).map((a) => human(a.type))
  if (asserted.length) return { label: asserted.join(' · '), source: 'Email Command', at: m.received_at }
  if ((c.flags || []).length) return { label: c.flags.map(human).join(' · '), source: 'Email Command', at: m.received_at }
  if (summary.needs?.code) return { label: human(summary.needs.code), source: 'Email Command', at: m.received_at }
  return null
}

function automationMode(summary, thread) {
  if (thread.automation_state === 'taken_over') return { mode: 'manual', label: 'You own this conversation' }
  if (thread.automation_state === 'paused') return { mode: 'paused', label: 'Automation paused' }
  if (summary.state === 'needs_you') return summary.escalated ? { mode: 'escalated', label: 'Escalated to you' } : { mode: 'needs_you', label: 'Waiting on your decision' }
  if (summary.state === 'failed') return { mode: 'failed', label: 'Failed' }
  if (summary.state === 'system_handling') return { mode: 'system_handling', label: 'LeadCommand is handling it' }
  if (summary.state === 'waiting') return { mode: 'waiting', label: 'Watching for a reply' }
  if (summary.state === 'unresolved') return { mode: 'off', label: 'Not automated — sender unidentified' }
  return { mode: 'done', label: 'Nothing pending' }
}

function closingLines(c, leg, lines) {
  if (!c) return
  if (leg === 'buyer') {
    lines.push(line('Buyer agreement and earnest money are outstanding'))
    return
  }
  if (ts(c.title_acknowledged_at) !== null) lines.push(line('Title acknowledged the order {at}', { at: c.title_acknowledged_at, fmt: 'ago', tone: 'good' }))
  else lines.push(line('Title has not acknowledged the order yet'))
  if (ts(c.title_commitment_received_at) !== null) lines.push(line('Title commitment received {at}', { at: c.title_commitment_received_at, fmt: 'ago', tone: 'good' }))
  else if (c.title_commitment_date) lines.push(line(`Commitment due ${dueLabel(c.title_commitment_date)} — not yet delivered`))
  else if (ts(c.title_acknowledged_at) !== null) lines.push(line('Commitment not yet delivered'))
}

export function buildWhy({ thread, summary, outbound, inbound, closingCase, delivery, now = Date.now() }) {
  const lines = []
  const role = ROLE[summary.counterparty?.role] || ROLE[thread.category] || 'They'
  const pending = outbound.filter((q) => PENDING.has(q.queue_status)).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
  const next = pending[0] || null
  const lastIn = lastInbound(inbound)
  const lastOut = outbound.filter((q) => SENTISH.has(q.queue_status)).sort((a, b) => String(a.sent_at || a.updated_at).localeCompare(String(b.sent_at || b.updated_at))).at(-1) || null
  const theyLast = ts(thread.last_inbound_at) !== null && (ts(thread.last_outbound_at) === null || ts(thread.last_inbound_at) > ts(thread.last_outbound_at))
  const sendOff = delivery && delivery.send_enabled === false
  const leg = thread.category === 'buyer' ? 'buyer' : 'title'

  const nextLine = (q) => {
    const st = outboxStatus(q, now)
    const what = actionLabel(q)
    if (st === 'sending') return line(`${what} is sending now`, { tone: 'auto' })
    if (st === 'queued') return line(`${what} queued {at}`, { at: q.scheduled_for || q.created_at, fmt: 'ago', tone: 'auto' })
    if (st === 'retrying') return line(`Retrying delivery — attempt ${Number(q.retry_count) + 1} {at}`, { at: q.next_retry_at, fmt: 'until', tone: 'auto' })
    if (st === 'held') return line(`${what} held by the safety gate (${human(q.failed_reason).toLowerCase()}) — re-checked {at}`, { at: q.next_retry_at, fmt: 'until', tone: 'warn' })
    return line(`${what} {at}`, { at: q.scheduled_for, fmt: 'until', tone: 'auto' })
  }
  const guardLine = (q) => {
    if (!q || q.source === 'manual') return null
    if (q.source === 'seller') return line('Any seller reply — SMS or email — cancels it before it sends')
    if (isChaseAction(q)) return line(`It is cancelled automatically if ${role.toLowerCase()} replies first`)
    return line('It is re-checked against the deal right before it sends')
  }

  let title = null
  switch (summary.state) {
    case 'needs_you': {
      title = theyLast && !summary.approvals?.length ? 'Why the system did not reply' : 'Why this needs you'
      const code = summary.needs?.code
      if (code && NEEDS_RULE[code]) lines.push(line(NEEDS_RULE[code], { tone: 'warn' }))
      if (summary.approvals?.length) lines.push(line(`A draft is ready — it cannot send until you approve it`, { tone: 'warn' }))
      if (thread.automation_state === 'taken_over' && code !== 'reply_on_taken_over_thread') lines.push(line('You own this conversation — automation stays out of it'))
      if (closingCase?.automation_paused_at && (PAUSES_CLOSING.has(code) || closingCase.automation_paused_reason?.startsWith('email:'))) {
        lines.push(line('Closing automation paused {at}', { at: closingCase.automation_paused_at, fmt: 'ago', tone: 'warn' }))
      }
      if (summary.failure?.operator_must_act) lines.push(line(summary.failure.what, { tone: 'bad' }))
      if (next) { lines.push(nextLine(next)); const g = guardLine(next); if (g) lines.push(g) } else lines.push(line('Nothing is queued to send'))
      break
    }
    case 'failed': {
      title = 'Why this failed'
      const f = summary.failure
      if (f) {
        lines.push(line(f.what, { tone: 'bad' }))
        lines.push(line(f.retry === 'exhausted' ? `Retried ${f.attempts} time${f.attempts === 1 ? '' : 's'} — no retry left` : 'No automatic retry for this kind of failure'))
        if (f.operator_must_act) lines.push(line(`Next step: ${f.action}`))
      }
      if (next) lines.push(nextLine(next))
      else lines.push(line('Nothing else is queued to send'))
      break
    }
    case 'system_handling': {
      if (next) {
        const st = outboxStatus(next, now)
        title = ['queued', 'sending'].includes(st) && clean(next.action_key).startsWith('seller.reply') ? 'Why LeadCommand is replying'
          : Number(next.sequence) > 1 ? `Why follow-up #${next.sequence} is scheduled` : 'Why this is scheduled'
        if (clean(next.reason?.why)) lines.push(line(clean(next.reason.why)))
        if (thread.closing_case_id) {
          closingLines(closingCase, leg, lines)
          if (closingCase?.automation_paused_at) lines.push(line('Closing automation paused {at}', { at: closingCase.automation_paused_at, fmt: 'ago', tone: 'warn' }))
          else if (thread.automation_state === 'active') lines.push(line('Closing cadence active', { tone: 'auto' }))
        }
        if (thread.category === 'seller' && lastIn) {
          const c = lastIn.classification || {}
          lines.push(line('Seller replied by email {at}', { at: lastIn.received_at, fmt: 'ago' }))
          if (clean(c.primary_intent)) lines.push(line(`Understood as ${human(c.primary_intent).toLowerCase()}`))
          if (clean(c.stage_after)) lines.push(line(`Stage set to ${STAGE_LABEL[c.stage_after] || human(c.stage_after)}`))
          if (clean(c.next_use_case)) lines.push(line(`Next question: ${human(clean(c.next_use_case).replace(/_probe$/, '')).toLowerCase()}`))
          if (Number(c.sms_followups_cancelled) > 0) lines.push(line('Pending SMS follow-up stopped — one conversation, two channels'))
        }
        lines.push(nextLine(next))
        const g = guardLine(next); if (g) lines.push(g)
        if (next.reason?.follow_up_at && ts(next.reason.follow_up_at) !== null && ts(next.reason.follow_up_at) !== ts(next.scheduled_for)) lines.push(line('Follow-up if no answer {at}', { at: next.reason.follow_up_at, fmt: 'until' }))
      } else {
        title = 'Why LeadCommand is handling it'
        if (lastIn) lines.push(line('Reply received {at} — being processed', { at: lastIn.received_at, fmt: 'ago', tone: 'auto' }))
      }
      if (sendOff) lines.push(line('Email sending is off — it waits until sending is turned on', { tone: 'warn' }))
      break
    }
    case 'waiting': {
      title = 'Why we’re waiting'
      if (thread.automation_state === 'taken_over') lines.push(line('You own this conversation — automation stays out of it {at}', { at: thread.taken_over_at || null, fmt: thread.taken_over_at ? 'ago' : null }))
      if (lastOut) lines.push(line(`${lastOut.source === 'manual' ? 'You' : 'LeadCommand'} sent “${clean(lastOut.subject) || 'an email'}” {at}`, { at: lastOut.sent_at || lastOut.updated_at, fmt: 'ago' }))
      if (thread.closing_case_id && closingCase) closingLines(closingCase, leg, lines)
      lines.push(line(`${role} has the ball`))
      lines.push(line('No follow-up is queued', { tone: 'muted' }))
      break
    }
    case 'unresolved': {
      title = 'Why this is unresolved'
      const n = Array.isArray(thread.resolution_candidates) ? thread.resolution_candidates.length : 0
      if (thread.resolution_status === 'ambiguous') lines.push(line(`${n || 'Several'} possible match${n === 1 ? '' : 'es'} — could not tell which seller or deal this is`))
      else lines.push(line('The sender matched no seller, buyer, title company or deal'))
      if (clean(thread.resolution_method).startsWith('automated:')) lines.push(line(`Looks like automated mail (${human(clean(thread.resolution_method).split(':')[1]).toLowerCase()})`))
      lines.push(line('Automation never replies to an unidentified sender'))
      break
    }
    default: {
      title = 'Why this is resolved'
      if (closingCase?.terminal_outcome) lines.push(line(`Closing ${human(closingCase.terminal_outcome).toLowerCase()}`))
      else if (ts(closingCase?.closed_at) !== null) lines.push(line('Closing closed {at}', { at: closingCase.closed_at, fmt: 'ago', tone: 'good' }))
      else if (thread.automation_state === 'completed') lines.push(line('Automation completed this conversation', { tone: 'good' }))
      else lines.push(line('Nothing is pending on either side'))
    }
  }
  // One fact, one line: a verbatim planner reason that repeats a timed fact keeps the timed one.
  const out = []
  for (const l of lines) {
    const key = l.text.replace(' {at}', '').toLowerCase()
    const i = out.findIndex((x) => x.text.replace(' {at}', '').toLowerCase() === key)
    if (i === -1) out.push(l)
    else if (l.at && !out[i].at) out[i] = l
  }
  return title ? { title, lines: out } : null
}

const SYSTEM_WORKFLOW = { seller: 'seller_inbound', closing: 'closing_execution', campaign: 'campaign_execution' }
const WORKFLOW_LABEL = { seller_inbound: 'Seller Conversation', closing_execution: 'Closing Execution', campaign_execution: 'Campaign Execution' }

/** Deep links to the systems this conversation is TRULY linked to — each from a stored id. */
export function buildLinks({ thread, summary, outbound }) {
  const links = []
  const ctx = summary.context || null
  if (thread.closing_case_id) {
    links.push({ system: 'closing_desk', label: 'Closing Desk', detail: ctx?.kind === 'closing' ? ctx.waiting_for : null, href: `/closing-desk?case=${encodeURIComponent(thread.closing_case_id)}` })
  }
  if (thread.sms_thread_key) {
    links.push({ system: 'inbox', label: 'Inbox', detail: 'SMS conversation · same seller brain', href: `/inbox?thread=${encodeURIComponent(thread.sms_thread_key)}`, thread_key: thread.sms_thread_key })
  }
  if (thread.category === 'seller' && (thread.sms_thread_key || thread.property_id)) {
    const qs = new URLSearchParams(Object.entries({ thread_key: thread.sms_thread_key, property_id: thread.property_id, master_owner_id: thread.master_owner_id }).filter(([, v]) => clean(v)))
    links.push({ system: 'deal_intelligence', label: 'Deal Intelligence', detail: ctx?.kind === 'seller' ? ctx.stage_label : null, href: `/deal-intelligence?${qs.toString()}` })
  }
  if (thread.category === 'buyer' && thread.property_id) {
    links.push({ system: 'buyer_match', label: 'Buyer Match', detail: 'Buyers for this property', href: `/buyer-match?property_id=${encodeURIComponent(thread.property_id)}` })
  }
  const flows = new Map()
  for (const q of outbound) {
    const rb = clean(q.requested_by)
    if (rb.startsWith('workflow:')) {
      const key = rb.slice('workflow:'.length).split('@')[0]
      if (key && !flows.has(`studio:${key}`)) flows.set(`studio:${key}`, { system: 'workflow_studio', label: 'Workflow Studio', detail: human(key), href: `/workflow-studio?studio=${encodeURIComponent(key)}` })
    } else if (SYSTEM_WORKFLOW[q.source]) {
      const key = SYSTEM_WORKFLOW[q.source]
      if (!flows.has(key)) flows.set(key, { system: 'workflow_studio', label: 'Workflow Studio', detail: WORKFLOW_LABEL[key], href: `/workflow-studio?wf=${key}` })
    }
  }
  links.push(...flows.values())
  const campaigns = [...new Set(outbound.map((q) => clean(q.campaign_id)).filter((id) => UUID.test(id)))]
  for (const id of campaigns) links.push({ system: 'campaign_command', label: 'Campaign Command', detail: 'Campaign that started this thread', href: `/campaign-command?campaign=${encodeURIComponent(id)}` })
  if (thread.property_id) links.push({ system: 'entity_graph', label: 'Entity Graph', detail: 'Property, owner and relationships', href: `/entity-graph/property/${encodeURIComponent(thread.property_id)}` })
  else if (thread.master_owner_id) links.push({ system: 'entity_graph', label: 'Entity Graph', detail: 'Owner and relationships', href: `/entity-graph/owner/${encodeURIComponent(thread.master_owner_id)}` })
  return links
}

/** Where the outbound messages came from — a workflow, a campaign, or a person. */
export function provenanceOf(q = {}) {
  const rb = clean(q.requested_by)
  if (q.source === 'manual') return { kind: 'operator', label: 'Sent by you', workflow: null }
  if (rb.startsWith('workflow:')) { const key = rb.slice(9).split('@')[0]; return { kind: 'workflow', label: `Workflow · ${human(key)}`, workflow: key } }
  if (SYSTEM_WORKFLOW[q.source]) { const key = SYSTEM_WORKFLOW[q.source]; return { kind: 'system', label: WORKFLOW_LABEL[key], workflow: key } }
  if (q.source) return { kind: 'system', label: human(q.source), workflow: null }
  return { kind: 'unknown', label: null, workflow: null }
}

export function buildThreadIntelligence({ thread, summary, outbound = [], inbound = [], closingCase = null, eventsByQueue = new Map(), delivery = null, market = null, now = Date.now() }) {
  const pending = outbound.filter((q) => PENDING.has(q.queue_status)).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
  const lastIn = lastInbound(inbound)
  const lastOut = outbound.filter((q) => SENTISH.has(q.queue_status)).sort((a, b) => String(a.sent_at || a.updated_at).localeCompare(String(b.sent_at || b.updated_at))).at(-1) || null
  const ctx = summary.context || null
  const stage = thread.category === 'seller' ? sellerStage(inbound) : null
  const mode = automationMode(summary, thread)

  const nextAction = summary.next ? { label: actionLabel(pending[0] || {}), at: summary.next.at, status: summary.next.status }
    : summary.approvals?.length ? { label: `Your approval · ${summary.approvals[0].subject || 'draft'}`, at: null, status: 'awaiting_approval' }
      : summary.state === 'needs_you' ? { label: 'Your decision', at: null, status: 'needs_you' }
        : null
  const owner = thread.automation_state === 'taken_over' ? 'you' : summary.ball === 'leadcommand' ? 'leadcommand' : summary.ball === 'them' ? 'them' : summary.ball === 'you' ? 'you' : null

  const eng = lastOut ? engagementFromEvents(eventsByQueue.get(lastOut.id) || []) : null
  return {
    summary: {
      intent: intentOf(summary, inbound),
      sentiment: null, // not recorded anywhere in the email plane — withheld rather than guessed
      stage: thread.category === 'seller'
        ? (stage || (ctx?.kind === 'seller' && ctx.stage_label ? { label: ctx.stage_label, moved: null, from: null, at: null } : null))
        : ctx?.kind === 'closing' ? { label: ctx.waiting_for, moved: null, from: null, at: null, closing: true } : null,
      lead_state: ctx?.kind === 'seller' ? [ctx.stage_label, ctx.contactability ? human(ctx.contactability) : null].filter(Boolean).join(' · ') || null
        : ctx?.kind === 'closing' ? `Closing · ${ctx.waiting_for}` : null,
      next_action: nextAction,
      last_reply_at: lastIn?.received_at || null,
      channel: {
        owner,
        preference: thread.contact_preference || null,
        sms_linked: Boolean(thread.sms_thread_key),
      },
    },
    automation: {
      ...mode,
      armed: pending.map((q) => ({ queue_id: q.id, label: actionLabel(q), at: q.scheduled_for || q.created_at, status: outboxStatus(q, now), sequence: q.sequence || null })),
      next_send_at: pending[0]?.scheduled_for || null,
      approvals: summary.approvals?.length || 0,
      send_enabled: delivery ? Boolean(delivery.send_enabled) : null,
      operator_switch: delivery ? Boolean(delivery.operator_switch) : null,
      taken_over_at: thread.taken_over_at || null,
    },
    why: buildWhy({ thread, summary, outbound, inbound, closingCase, delivery, now }),
    links: buildLinks({ thread, summary, outbound }),
    party: {
      name: thread.counterparty_name || null,
      email: thread.counterparty_email || null,
      role: ROLE[summary.counterparty?.role] || ROLE[thread.category] || null,
      resolution: thread.resolution_status || null,
      method: thread.resolution_method || null,
      candidates: Array.isArray(thread.resolution_candidates) ? thread.resolution_candidates.length : 0,
    },
    property: summary.property_address || thread.property_id ? { address: summary.property_address || null, market: market || null, property_id: thread.property_id || null } : null,
    delivery: lastOut ? {
      status: deliveryStatus(lastOut, eng),
      at: lastOut.sent_at || lastOut.updated_at || null,
      subject: lastOut.subject || null,
      from: lastOut.from_email || null,
      domain: lastOut.sending_domain || null,
      provider: lastOut.provider || null,
      provenance: provenanceOf(lastOut),
      engagement: { delivered_at: eng.delivered_at, open_signals: eng.open_signals, likely_human_opens: eng.likely_human_opens, clicks: eng.clicks, replied_at: eng.replied_at, bounce: eng.bounce },
    } : null,
    activity: {
      inbound: inbound.length,
      outbound: outbound.filter((q) => SENTISH.has(q.queue_status)).length,
      planned: pending.length,
      automated: summary.origin?.automated || 0,
      manual: summary.origin?.manual || 0,
      attachments: Number(thread.attachment_count) || 0,
      first_at: thread.created_at || null,
      last_at: thread.last_message_at || null,
    },
  }
}
