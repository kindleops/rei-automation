/**
 * Live Activity event card — what happened, the actual message, why it
 * matters, and the next move.
 *
 * Reads the real rows behind the event (message_events + inbox_thread_state):
 * direction, body, delivery status and failure reason, stage before → after,
 * intent, the thread's stage and next action. Actions reuse existing flows only:
 *   Retry send        POST /api/cockpit/queue/retry (the queue's own authority
 *                     gates still decide) — confirmed first, failed sends only
 *   Open conversation the Inbox thread
 *   Next step         the property card, whose stage action the operator reviews
 * Nothing on this card sends a message by itself.
 */
import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { retryQueueItem } from '../../../lib/api/backendClient'
import { pushRoutePath } from '../../../app/router'
import type { LiveActivityEvent } from '../live-activity-engine'
import { orbColor } from './useLiveOrbs'
import { agoLabel } from './map-mobile-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '')

interface MessageRow {
  direction: string | null
  message_body: string | null
  delivery_status: string | null
  failure_reason: string | null
  error_message: string | null
  failure_bucket: string | null
  is_final_failure: boolean | null
  queue_id: string | null
  stage_before: string | null
  stage_after: string | null
  detected_intent: string | null
  created_at: string | null
  thread_key: string | null
  seller_display_name: string | null
  property_address: string | null
}
interface ThreadRow {
  stage: string | null
  seller_stage: string | null
  next_action: string | null
  is_hot_lead: boolean | null
  last_intent: string | null
  lead_temperature: string | null
  is_suppressed: boolean | null
  seller_display_name: string | null
}

const KIND: Record<string, { eyebrow: string; icon: string }> = {
  new_reply: { eyebrow: 'Seller replied', icon: 'message' },
  positive_reply: { eyebrow: 'Positive reply', icon: 'message' },
  opt_out: { eyebrow: 'Opted out', icon: 'slash' },
  message_failed: { eyebrow: 'Message failed', icon: 'alert-circle' },
  message_delivered: { eyebrow: 'Delivered', icon: 'check-double' },
  message_sent: { eyebrow: 'Sent', icon: 'send' },
  stage_change: { eyebrow: 'Stage move', icon: 'trending-up' },
  hot_lead: { eyebrow: 'Hot lead', icon: 'bolt' },
  offer: { eyebrow: 'Offer stage', icon: 'dollar-sign' },
  contract: { eyebrow: 'Contract stage', icon: 'file-text' },
  closing: { eyebrow: 'Closing', icon: 'key' },
}

/** Why this needs the operator, in one sentence, from the real fields. */
export function eventWhy(e: Pick<LiveActivityEvent, 'type' | 'detail'>, m: MessageRow | null, t: ThreadRow | null): string {
  const next = t?.next_action ? label(t.next_action) : null
  switch (e.type) {
    case 'new_reply':
    case 'positive_reply': {
      const intent = m?.detected_intent || t?.last_intent
      const moved = m?.stage_after && m.stage_after !== m.stage_before ? ` and moved to ${label(m.stage_after)}` : ''
      return `The seller answered${intent ? ` — reads as ${label(intent)}` : ''}${moved}. ${next ? `Next: ${next}.` : 'Reply while they are engaged.'}`
    }
    case 'message_failed': {
      const reason = m?.failure_reason || m?.error_message || m?.failure_bucket
      return `Not delivered${reason ? `: ${reason}` : ''}.${m?.is_final_failure ? ' The carrier marked it final.' : ' It can be retried.'}`
    }
    case 'opt_out':
      return 'The seller asked to stop. All outreach to this number is suppressed.'
    case 'message_delivered':
      return `Delivered to the seller's phone. ${next ? `Next: ${next}.` : 'Waiting on a reply.'}`
    case 'message_sent':
      return 'Handed to the carrier; delivery confirmation pending.'
    case 'stage_change':
      return `${e.detail ? `${e.detail[0].toUpperCase()}${e.detail.slice(1)} → ` : ''}${label(t?.seller_stage || t?.stage) || 'new stage'}. ${next ? `Next: ${next}.` : ''}`
    default:
      return next ? `Next: ${next}.` : 'Activity on this property.'
  }
}

export function MapEventCard({ event, onClose, onShowProperty }: { event: LiveActivityEvent; onClose: () => void; onShowProperty: (e: LiveActivityEvent) => void }) {
  const [msg, setMsg] = useState<MessageRow | null>(null)
  const [thread, setThread] = useState<ThreadRow | null>(null)
  const [retry, setRetry] = useState<'idle' | 'confirm' | 'working' | 'done' | { error: string }>('idle')
  const kind = KIND[event.type] ?? { eyebrow: label(event.type), icon: 'activity' }
  const color = orbColor(event.type)

  useEffect(() => {
    if (!shouldUseSupabase()) return
    let alive = true
    const sb = getSupabaseClient()
    void (async () => {
      const cols = 'direction,message_body,delivery_status,failure_reason,error_message,failure_bucket,is_final_failure,queue_id,stage_before,stage_after,detected_intent,created_at,thread_key,seller_display_name,property_address'
      let m: MessageRow | null = null
      if (event.messageEventId) {
        const { data } = await sb.from('message_events').select(cols).eq('id', event.messageEventId).maybeSingle()
        m = (data as MessageRow | null) ?? null
      } else if (event.threadKey) {
        const { data } = await sb.from('message_events').select(cols).eq('thread_key', event.threadKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
        m = (data as MessageRow | null) ?? null
      }
      if (!alive) return
      setMsg(m)
      const key = event.threadKey || m?.thread_key
      if (key) {
        const { data } = await sb.from('inbox_thread_state')
          .select('stage,seller_stage,next_action,is_hot_lead,last_intent,lead_temperature,is_suppressed,seller_display_name')
          .eq('thread_key', key).maybeSingle()
        if (alive) setThread((data as ThreadRow | null) ?? null)
      }
    })()
    return () => { alive = false }
  }, [event.id, event.messageEventId, event.threadKey])

  const body = msg?.message_body || (event.type === 'stage_change' ? null : event.detail) || null
  const inbound = (msg?.direction || (event.type === 'new_reply' || event.type === 'positive_reply' || event.type === 'opt_out' ? 'inbound' : 'outbound')) === 'inbound'
  const failed = event.type === 'message_failed' || msg?.delivery_status === 'failed'
  const threadKey = event.threadKey || msg?.thread_key || null
  const queueId = event.queueId || msg?.queue_id || null
  const seller = thread?.seller_display_name || msg?.seller_display_name || event.subtitle
  const where = event.address || msg?.property_address || event.market
  const when = Date.parse(event.occurredAt || event.createdAt || '')
  const stage = thread?.seller_stage || thread?.stage

  const openConversation = () => { if (threadKey) { onClose(); pushRoutePath(`/inbox?thread=${encodeURIComponent(threadKey)}`) } }

  return (
    <div className="mx-evt" role="dialog" aria-label={kind.eyebrow} style={{ ['--evt' as string]: color }} data-map-card="event">
      <div className="mx-evt__head">
        <span className="mx-evt__icon" aria-hidden="true"><Icon name={kind.icon as never} size={17} /></span>
        <div className="mx-evt__title">
          <span className="mx-evt__eyebrow">{kind.eyebrow}{Number.isFinite(when) ? ` · ${agoLabel(when, Date.now())}` : ''}</span>
          <strong>{seller || 'Seller'}</strong>
          {where && <button type="button" className="mx-evt__where" onClick={() => onShowProperty(event)}>{where}</button>}
        </div>
        <button type="button" className="mx-btn is-sm" aria-label="Close" data-map-sheet-close onClick={onClose}><Icon name="close" size={13} /></button>
      </div>

      {body && (
        <div className={cls('mx-evt__bubble', inbound ? 'is-in' : 'is-out', failed && 'is-failed')}>
          <p>{body}</p>
          <span>{inbound ? 'Seller' : failed ? 'Not delivered' : msg?.delivery_status === 'delivered' ? 'Delivered' : 'Sent'}</span>
        </div>
      )}

      <p className="mx-evt__why">{eventWhy(event, msg, thread)}</p>

      <div className="mx-evt__chips">
        {stage && <span>Stage · {label(stage)}</span>}
        {(thread?.is_hot_lead || thread?.lead_temperature === 'hot') && <span className="is-hot">Hot</span>}
        {(msg?.detected_intent || thread?.last_intent) && <span>Intent · {label(msg?.detected_intent || thread?.last_intent)}</span>}
        {thread?.is_suppressed && <span className="is-stop">Suppressed</span>}
      </div>

      <div className="mx-evt__actions">
        {failed && queueId && retry === 'idle' && !msg?.is_final_failure && (
          <button type="button" className="mx-act is-primary" onClick={() => setRetry('confirm')} data-evt-action="retry">Retry send</button>
        )}
        {retry === 'confirm' && queueId && (
          <div className="mx-area__confirm">
            <p>Put this message back in the queue? The queue's own checks (suppression, routing, send windows) still decide whether it goes.</p>
            <div className="mx-area__row is-two">
              <button type="button" className="mx-act" onClick={() => setRetry('idle')}>Cancel</button>
              <button
                type="button"
                className="mx-act is-primary"
                onClick={async () => {
                  setRetry('working')
                  const res = await retryQueueItem(queueId)
                  setRetry(res.ok ? 'done' : { error: (res as { message?: string }).message || 'retry_failed' })
                }}
              >Requeue</button>
            </div>
          </div>
        )}
        {retry === 'working' && <button type="button" className="mx-act is-primary" disabled>Requeuing…</button>}
        {retry === 'done' && <p className="mx-note">Back in the queue — it will go out when the queue's checks allow.</p>}
        {typeof retry === 'object' && <p className="mx-note is-error">Couldn't requeue ({retry.error}).</p>}

        <div className="mx-area__row is-two">
          {threadKey && <button type="button" className="mx-act" onClick={openConversation} data-evt-action="conversation">Open conversation</button>}
          {event.type !== 'opt_out' && typeof event.lat === 'number' && (
            <button type="button" className={cls('mx-act', !failed && 'is-primary')} onClick={() => { onClose(); onShowProperty(event) }} data-evt-action="next">
              {failed ? 'Show property' : 'Next step'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
