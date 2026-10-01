import type { InspectorModel, InspectorRenderer, InspectorTone } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { InspectorReadError, clip, count, enc, isoOrNull, joinParts, present, readInspector, text, when, words } from '../inspector-read'

/**
 * SELLER — GET /api/cockpit/inbox/thread-dossier?thread_key=… (the Inbox's
 * own dossier). The conversation's canonical state is the thread-state row
 * (`inbox_thread_state`): contactability + suppression, automation state and
 * lane, next action, last inbound. Scheduled sends come from the thread's
 * send_queue rows. The inspector renders these; it decides none of them.
 */

export interface ThreadState {
  thread_key?: string
  seller_display_name?: string | null
  property_id?: string | null
  prospect_id?: string | null
  master_owner_id?: string | null
  market?: string | null
  seller_stage?: string | null
  lead_temperature?: string | null
  last_intent?: string | null
  contactability_status?: string | null
  is_suppressed?: boolean | null
  suppressed_at?: string | null
  automation_state?: string | null
  automation_lane?: string | null
  paused_reason?: string | null
  snoozed_until?: string | null
  next_action?: string | null
  next_action_at?: string | null
  next_scheduled_for?: string | null
  pending_queue_count?: number | null
  failed_queue_count?: number | null
  blocked_queue_count?: number | null
  latest_message_body?: string | null
  latest_direction?: string | null
  last_inbound_at?: string | null
  last_outbound_at?: string | null
  manual_stage_lock?: boolean | null
  updated_at?: string | null
}

export interface QueueRow { id?: string; queue_status?: string | null; scheduled_for?: string | null }
export interface TimelineRow { timestamp?: string; event_type?: string; status?: string | null }

export interface ThreadDossier {
  diagnostics?: {
    thread_key?: string
    context?: { selected_thread?: { inbox_thread_state?: ThreadState | null; send_queue?: QueueRow[] | null } | null } | null
    automation_timeline?: TimelineRow[] | null
    linkedRecords?: { propertyIds?: string[] } | null
  } | null
}

/** contactability_status as written by the autopilot (inbox_thread_state). */
const CONTACT: Record<string, { label: string; blocks: boolean }> = {
  contactable: { label: 'Contactable', blocks: false },
  opted_out: { label: 'Opted out (STOP)', blocks: true },
  do_not_text: { label: 'Do not text', blocks: true },
  do_not_contact: { label: 'Do not contact', blocks: true },
  invalid_number: { label: 'Invalid number', blocks: true },
}

const LANE: Record<string, string> = {
  active_conversation: 'Active conversation',
  cold_reactivation: 'Cold follow-up',
  manual_review: 'Manual review',
  disqualified: 'Disqualified',
}

const NEXT: Record<string, string> = {
  human_review: 'Your review',
  schedule_follow_up: 'Schedule a follow-up',
  send_message_now: 'Send a reply now',
  no_action_contact_blocked: 'None — contact is blocked',
}

const TIMELINE: Record<string, string> = {
  inbound_received: 'Seller replied',
  outbound_sent: 'Message sent',
  auto_reply_queued: 'Reply queued',
  outbound_failed: 'Message failed',
  follow_up_scheduled: 'Follow-up scheduled',
}

const OPEN_QUEUE = new Set(['queued', 'scheduled', 'pending', 'ready', 'retry_scheduled'])

/** The dossier answers 200 for any key; an unknown thread has no state row and no timeline. */
export const hasConversation = (body: ThreadDossier): boolean =>
  Boolean(body.diagnostics?.context?.selected_thread?.inbox_thread_state) || Boolean(body.diagnostics?.automation_timeline?.length)

export function shapeSeller(body: ThreadDossier, ref: EntityRef, now = Date.now()): InspectorModel {
  const dx = body.diagnostics ?? {}
  const ts: ThreadState = dx.context?.selected_thread?.inbox_thread_state ?? {}
  const threadKey = text(ts.thread_key) ?? text(dx.thread_key) ?? text(ref.hint?.thread_key) ?? ref.id
  const name = text(ts.seller_display_name) ?? text(ref.label)
  const propertyId = text(ts.property_id) ?? text(ref.hint?.property_id) ?? text(dx.linkedRecords?.propertyIds?.[0])

  const contact = ts.contactability_status ? CONTACT[ts.contactability_status] ?? { label: words(ts.contactability_status) ?? '', blocks: false } : null
  const blocked = Boolean(ts.is_suppressed) || Boolean(contact?.blocks)
  const automation = words(ts.automation_state)

  let status: InspectorModel['status'] = null
  if (blocked) status = { label: ts.is_suppressed && !contact?.blocks ? 'Suppressed' : contact!.label, tone: 'crit' as InspectorTone }
  else if (ts.paused_reason) status = { label: 'Automation paused', tone: 'attention' }
  else if (ts.next_action === 'human_review' || ts.automation_lane === 'manual_review') status = { label: 'Needs your review', tone: 'attention' }
  else if (ts.automation_state === 'running') status = { label: 'Automation running', tone: 'live' }

  // the next send actually on the queue for this thread, else the state's own pointer
  const queued = (dx.context?.selected_thread?.send_queue ?? [])
    .filter((q) => OPEN_QUEUE.has(String(q.queue_status ?? '')) && isoOrNull(q.scheduled_for))
    .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))[0]
  const nextSend = isoOrNull(queued?.scheduled_for) ?? isoOrNull(ts.next_scheduled_for)

  const nextAction = ts.next_action ? NEXT[ts.next_action] ?? ts.next_action : null
  const nextAt = isoOrNull(ts.next_action_at)
  const overdue = nextAt && Date.parse(nextAt) < now ? 'overdue' : null
  const inbound = ts.latest_direction === 'inbound' ? clip(text(ts.latest_message_body), 140) : null

  const queueIssues = joinParts([
    ts.failed_queue_count ? count(ts.failed_queue_count, 'failed send') : null,
    ts.blocked_queue_count ? count(ts.blocked_queue_count, 'blocked send') : null,
    ts.pending_queue_count ? count(ts.pending_queue_count, 'pending send') : null,
  ])

  const relations: InspectorModel['relations'] = []
  if (propertyId) relations.push({ label: 'Property', ref: { type: 'property', id: propertyId, label: text(ref.hint?.property_label), hint: { property_id: propertyId, thread_key: threadKey } } })

  const activity = (dx.automation_timeline ?? [])
    .filter((e) => isoOrNull(e.timestamp))
    .slice(0, 6)
    .map((e) => ({ at: e.timestamp as string, text: TIMELINE[e.event_type ?? ''] ?? words(e.event_type) ?? 'Activity' }))

  return {
    title: name ?? 'Seller',
    eyebrow: joinParts([text(ts.market), words(ts.seller_stage)]),
    status,
    facts: present([
      { label: 'Contact', value: joinParts([contact?.label ?? null, ts.is_suppressed ? `Suppressed${ts.suppressed_at ? ` ${when(ts.suppressed_at)}` : ''}` : null]) },
      { label: 'Automation', value: joinParts([automation, ts.automation_lane ? LANE[ts.automation_lane] ?? words(ts.automation_lane) : null]) },
      { label: 'Paused', value: words(ts.paused_reason) },
      { label: 'Snoozed until', value: when(ts.snoozed_until) },
      { label: 'Next action', value: nextAction ? joinParts([nextAction, nextAt ? when(nextAt) : null, overdue]) : null },
      { label: 'Next scheduled send', value: nextSend ? when(nextSend) : null },
      { label: 'Queue', value: queueIssues },
      { label: 'Latest inbound', value: joinParts([when(ts.last_inbound_at), inbound ? `“${inbound}”` : null]) },
      { label: 'Last outbound', value: when(ts.last_outbound_at) },
      { label: 'Stage', value: joinParts([words(ts.seller_stage), ts.manual_stage_lock ? 'locked by you' : null]) },
      { label: 'Temperature', value: words(ts.lead_temperature) },
      { label: 'Last intent', value: words(ts.last_intent) },
    ]),
    relations,
    activity,
    open: [
      { label: 'Inbox', path: `/inbox?thread=${enc(threadKey)}` },
      ...(propertyId ? [{ label: 'Deal Intelligence', path: `/deal-intelligence?property_id=${enc(propertyId)}` }] : []),
    ],
    mission: { label: name ?? 'Seller', threadKey, propertyId, prospectId: text(ts.prospect_id), masterOwnerId: text(ts.master_owner_id) },
    replay: { type: 'seller', id: threadKey, label: name },
    freshness: ts.updated_at ? `Conversation state as of ${when(ts.updated_at)}` : null,
  }
}

export const sellerInspector: InspectorRenderer = {
  type: 'seller',
  noun: 'Seller',
  glyph: 'user',
  load: async (ref, signal) => {
    const tk = text(ref.hint?.thread_key) ?? ref.id
    const body = await readInspector<ThreadDossier>(`/api/cockpit/inbox/thread-dossier?thread_key=${enc(tk)}`, signal)
    if (!hasConversation(body)) throw new InspectorReadError('not_found', 'no conversation on record')
    return shapeSeller(body, ref)
  },
}
