/**
 * CALENDAR 5.0 · ACTIONS — every way the calendar leaves itself.
 *
 *   open        navigate to the owning app (the shell turns a navigation to
 *               an app that is already open into "focus it")
 *   openBeside  split the workspace and open the owning app next to the
 *               calendar, carrying the exact subject in its path
 *   select      publish the subject as the workspace selection (linked
 *               context) — panes that follow the selection follow it
 *   reschedule / cancel
 *               the two canonical queue actions, only for events whose
 *               read model grants them (event.actions); the same calls the
 *               Queue and the Inbox make, with dry_run: false
 *
 * The calendar holds no state of its own: after a write it re-reads the
 * projection and the event moves in place (stable source identity).
 */
import { pushRoutePath } from '../../../app/router'
import { cancelQueueItem, rescheduleQueueItem } from '../../../lib/api/backendClient'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import { openInSplit } from '../../../modules/desktop/split-workspace'
import type { DeskEvent } from '../../../domain/calendar/calendar-timeline-api'
import { MIN } from './temporal-time'

export const APP_NAME: Record<string, string> = {
  campaigns: 'Campaign Command', inbox: 'Inbox', closing: 'Closing Desk', pipeline: 'Pipeline', workflow: 'Workflow Studio', email: 'Email Command', queue: 'Queue',
}

export interface Destination { key: string; label: string; app: string; path: string; conversation?: { threadKey: string; propertyId: string | null } }

/** Where an event can take the operator — owning app first, then its related subjects (§47, §49). */
export function destinations(e: DeskEvent): Destination[] {
  const out: Destination[] = []
  const l = e.links || {}
  const q = (o: Record<string, string | null | undefined>) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) s.set(k, v); const t = s.toString(); return t ? `?${t}` : '' }
  if (e.deep_link) out.push({ key: 'own', label: e.deep_link.label, app: e.deep_link.app, path: e.deep_link.path, ...(e.deep_link.app === 'inbox' && l.thread_key ? { conversation: { threadKey: l.thread_key, propertyId: l.property_id ?? null } } : {}) })
  const add = (d: Destination) => { if (!out.some((x) => x.app === d.app)) out.push(d) }
  // A MISSED campaign start never fires late on its own (rc-7.1 D4): the two
  // operator choices, each opening Campaign Command's own sheet — Start now
  // (the existing activation path, texting hours shown) or Reschedule.
  if (l.campaign_id && e.status === 'missed') {
    out.push({ key: 'campaign_start_now', label: 'Start now', app: 'campaigns', path: `/campaign-command${q({ campaign: l.campaign_id, intent: 'start_now' })}` })
    out.push({ key: 'campaign_reschedule', label: 'Reschedule', app: 'campaigns', path: `/campaign-command${q({ campaign: l.campaign_id, intent: 'reschedule' })}` })
  }
  if (l.thread_key) add({ key: 'conversation', label: 'Open conversation', app: 'inbox', path: `/inbox${q({ thread: l.thread_key })}`, conversation: { threadKey: l.thread_key, propertyId: l.property_id ?? null } })
  if (l.campaign_id) add({ key: 'campaign', label: 'Open campaign', app: 'campaigns', path: `/campaign-command${q({ campaign: l.campaign_id })}` })
  if (l.closing_case_id) add({ key: 'closing', label: 'Open closing', app: 'closing', path: `/closing-desk${q({ case: l.closing_case_id })}` })
  if (l.opportunity_id) add({ key: 'deal', label: 'Open deal', app: 'pipeline', path: `/pipeline${q({ opp: l.opportunity_id })}` })
  if (l.run_id && !out.some((x) => x.app === 'workflow')) add({ key: 'run', label: 'Open run', app: 'workflow', path: `/workflow-studio${q({ run: l.run_id })}` })
  // a failed or blocked send is a queue fact: the Queue explains it (§45)
  if (e.source === 'send_queue' && (e.status === 'blocked' || e.type === 'scheduled_message_group')) add({ key: 'queue', label: 'Open Queue', app: 'queue', path: '/queue' })
  return out
}

/** Navigate to the owning app. A conversation goes through the Inbox's own entry. */
export function open(d: Destination) {
  if (d.conversation) { openInboxThread({ threadKey: d.conversation.threadKey, propertyId: d.conversation.propertyId }); return }
  pushRoutePath(d.path)
}

/** Open the owning app beside the calendar, with the subject in its path (§48–49). */
export function openBeside(d: Destination, e?: DeskEvent) {
  if (e) select(e)
  openInSplit(d.path)
}

/** Publish the event's subject as the workspace selection (linked panes follow). */
export function select(e: DeskEvent) {
  const l = e.links || {}
  if (!l.property_id && !l.thread_key && !l.opportunity_id) return
  setPropertyLocator({ propertyId: l.property_id ?? undefined, threadKey: l.thread_key ?? undefined, opportunityId: l.opportunity_id ?? undefined, address: e.place ?? undefined })
}

/* ── writes: the canonical queue actions, guarded ── */

export class WriteRefused extends Error {}

/** The latest moment (ms) a write may still be made for an event, given its lead time. */
export function writeDeadline(e: DeskEvent) {
  const lead = (e.actions?.reschedule?.min_lead_minutes ?? 10) * MIN
  return Date.parse(e.start) - lead
}

/** Move a message you scheduled. Refuses (without calling) when the send is too close or the target is. */
export async function rescheduleMessage(e: DeskEvent, toMs: number, now = Date.now()) {
  const a = e.actions?.reschedule
  if (!a) throw new WriteRefused('This event cannot be rescheduled from the calendar.')
  const lead = a.min_lead_minutes * MIN
  if (Date.parse(e.start) - now <= lead) throw new WriteRefused(`It sends in under ${a.min_lead_minutes} minutes — the queue may already hold it. Use the Queue.`)
  if (toMs - now <= lead) throw new WriteRefused(`Pick a time at least ${a.min_lead_minutes} minutes from now.`)
  const res = await rescheduleQueueItem(a.queue_id, new Date(toMs).toISOString())
  if (!res.ok) throw new Error(res.message || 'The queue refused the change. Nothing was changed.')
  const body = res.data as { dry_run?: boolean; ok?: boolean } | null
  if (body?.dry_run === true || body?.ok === false) throw new Error('The queue did not apply the change. Nothing was changed.')
  return res
}

/** Cancel a message you scheduled — the queue row is cancelled, not deleted. */
export async function cancelMessage(e: DeskEvent, now = Date.now()) {
  const a = e.actions?.cancel
  if (!a) throw new WriteRefused('This event cannot be cancelled from the calendar.')
  const lead = (e.actions?.reschedule?.min_lead_minutes ?? 10) * MIN
  if (Date.parse(e.start) - now <= lead) throw new WriteRefused('It sends in a few minutes — the queue may already hold it. Use the Queue.')
  const res = await cancelQueueItem(a.queue_id)
  if (!res.ok) throw new Error(res.message || 'The queue refused the cancel. Nothing was changed.')
  const body = res.data as { dry_run?: boolean; ok?: boolean } | null
  if (body?.dry_run === true || body?.ok === false) throw new Error('The queue did not apply the cancel. Nothing was changed.')
  return res
}
