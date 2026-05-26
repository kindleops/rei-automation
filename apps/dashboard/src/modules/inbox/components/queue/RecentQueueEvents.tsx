import { type FC } from 'react'

// TODO: wire to webhook_log + send_queue realtime Supabase subscription
// Expected shape when real-time API is available:
export interface RecentQueueEvent {
  id: string
  type: 'queue_run_started' | 'queue_row_sent' | 'delivery_received' | 'send_failed' | 'suppression_written' | 'webhook_received' | 'campaign_target_updated'
  detail: string
  market?: string
  at: string // ISO string
}

const EVENT_ICONS: Record<RecentQueueEvent['type'], string> = {
  queue_run_started:       '▶',
  queue_row_sent:          '→',
  delivery_received:       '✓',
  send_failed:             '✕',
  suppression_written:     '🚫',
  webhook_received:        '⚡',
  campaign_target_updated: '✎',
}

const EVENT_TONES: Record<RecentQueueEvent['type'], string> = {
  queue_run_started:       'blue',
  queue_row_sent:          'cyan',
  delivery_received:       'green',
  send_failed:             'red',
  suppression_written:     'amber',
  webhook_received:        'blue',
  campaign_target_updated: 'muted',
}

// TODO: replace with real-time subscription to webhook_log and send_queue tables
const MOCK_EVENTS: RecentQueueEvent[] = [
  { id: '1',  type: 'queue_run_started',       detail: 'Queue processor started run #4821',             market: undefined,     at: new Date(Date.now() -  1 * 60000).toISOString() },
  { id: '2',  type: 'queue_row_sent',          detail: 'Sent to …3847 — Dallas',                        market: 'Dallas',      at: new Date(Date.now() -  2 * 60000).toISOString() },
  { id: '3',  type: 'delivery_received',       detail: 'Delivered — …3847 Dallas',                      market: 'Dallas',      at: new Date(Date.now() -  3 * 60000).toISOString() },
  { id: '4',  type: 'queue_row_sent',          detail: 'Sent to …9921 — Houston',                       market: 'Houston',     at: new Date(Date.now() -  4 * 60000).toISOString() },
  { id: '5',  type: 'send_failed',             detail: 'Failed — …9921 Houston: TextGrid content filter', market: 'Houston',   at: new Date(Date.now() -  5 * 60000).toISOString() },
  { id: '6',  type: 'webhook_received',        detail: 'Webhook: delivered status for …3291',           market: undefined,     at: new Date(Date.now() -  6 * 60000).toISOString() },
  { id: '7',  type: 'suppression_written',     detail: 'Suppression written — opt-out keyword STOP',   market: 'Minneapolis', at: new Date(Date.now() -  8 * 60000).toISOString() },
  { id: '8',  type: 'campaign_target_updated', detail: 'campaign_target stage → sent_waiting',          market: 'Atlanta',     at: new Date(Date.now() -  9 * 60000).toISOString() },
  { id: '9',  type: 'delivery_received',       detail: 'Delivered — …1102 Atlanta',                     market: 'Atlanta',     at: new Date(Date.now() - 11 * 60000).toISOString() },
  { id: '10', type: 'queue_row_sent',          detail: 'Sent to …7821 — Los Angeles',                   market: 'Los Angeles', at: new Date(Date.now() - 13 * 60000).toISOString() },
  { id: '11', type: 'queue_run_started',       detail: 'Queue processor started run #4820',             market: undefined,     at: new Date(Date.now() - 15 * 60000).toISOString() },
  { id: '12', type: 'send_failed',             detail: 'Failed — …4412 Minneapolis: 21610 blacklist',  market: 'Minneapolis', at: new Date(Date.now() - 16 * 60000).toISOString() },
  { id: '13', type: 'webhook_received',        detail: 'Webhook: failed status for …9821',              market: undefined,     at: new Date(Date.now() - 18 * 60000).toISOString() },
  { id: '14', type: 'campaign_target_updated', detail: 'campaign_target stage → failed',                market: 'Charlotte',   at: new Date(Date.now() - 20 * 60000).toISOString() },
  { id: '15', type: 'delivery_received',       detail: 'Delivered — …2291 Charlotte',                   market: 'Charlotte',   at: new Date(Date.now() - 22 * 60000).toISOString() },
  { id: '16', type: 'queue_row_sent',          detail: 'Sent to …3301 — Phoenix',                       market: 'Phoenix',     at: new Date(Date.now() - 25 * 60000).toISOString() },
  { id: '17', type: 'suppression_written',     detail: 'Suppression written — no reply 90d rule',       market: 'Dallas',      at: new Date(Date.now() - 28 * 60000).toISOString() },
  { id: '18', type: 'webhook_received',        detail: 'Webhook: undelivered status for …8821',          market: undefined,    at: new Date(Date.now() - 31 * 60000).toISOString() },
  { id: '19', type: 'queue_row_sent',          detail: 'Sent to …9012 — Houston',                       market: 'Houston',     at: new Date(Date.now() - 34 * 60000).toISOString() },
  { id: '20', type: 'delivery_received',       detail: 'Delivered — …9012 Houston',                     market: 'Houston',     at: new Date(Date.now() - 36 * 60000).toISOString() },
]

const relTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ago`
}

export const RecentQueueEvents: FC = () => {
  return (
    <div className="sqd-section sqd-event-stream-section">
      <div className="sqd-section__head">
        <span className="sqd-section-eyebrow">Recent Queue Events</span>
        <span className="sqd-section-sub is-muted">Mock — TODO: wire to webhook_log + send_queue realtime subscription</span>
        <span className="sqd-panel__count">{MOCK_EVENTS.length} events</span>
      </div>
      <div className="sqd-event-stream">
        {MOCK_EVENTS.map(ev => (
          <div key={ev.id} className={`sqd-event-row is-${EVENT_TONES[ev.type]}`}>
            <span className={`sqd-event-row__icon is-${EVENT_TONES[ev.type]}`}>{EVENT_ICONS[ev.type]}</span>
            <span className="sqd-event-row__type">{ev.type.replace(/_/g, ' ')}</span>
            <span className="sqd-event-row__detail">{ev.detail}</span>
            {ev.market && <span className="sqd-event-row__market">{ev.market}</span>}
            <span className="sqd-event-row__time">{relTime(ev.at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
