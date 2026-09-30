import { Icon } from '../../shared/icons'
import { pushRoutePath } from '../../app/router'
import type { QueueCommandState } from '../mobile/useQueueCommandState'

/**
 * Q — the send machine at a glance. Read-only: every figure is the processor's
 * own health report; changing anything happens in the Queue app itself.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString())
const ago = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s)) return '—'
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function queueTone(q: QueueCommandState): 'live' | 'warn' | 'down' | 'idle' {
  const s = q.health?.status
  if (q.mode === 'paused') return 'idle'
  if (s === 'critical') return 'down'
  if (s === 'warning') return 'warn'
  if (s === 'healthy') return 'live'
  return 'idle'
}

export function queueLabel(q: QueueCommandState): string {
  if (!q.health && q.loading) return 'Reading queue…'
  if (q.mode === 'paused') return 'Sending paused'
  const s = q.health?.status
  if (s === 'critical') return 'Queue needs attention'
  if (s === 'warning') return 'Queue degraded'
  if (s === 'healthy') return q.mode === 'automatic' ? 'Automation live' : 'Assisted sending'
  return 'Queue status unknown'
}

export function DesktopQueuePanel({ queue, onClose }: { queue: QueueCommandState; onClose: () => void }) {
  const h = queue.health
  const tone = queueTone(queue)
  const tiles: Array<[string, number | null | undefined, string?]> = [
    ['Queued', h?.queuedCount],
    ['Scheduled', h?.scheduledCount],
    ['Sending', h?.sendingCount],
    ['Sent today', h?.sentTodayCount],
    ['Delivered today', h?.deliveredTodayCount],
    ['Failed today', h?.failedTodayCount, (h?.failedTodayCount ?? 0) > 0 ? 'is-bad' : undefined],
  ]
  return (
    <div className="dsk-pop dsk-pop--queue" role="dialog" aria-label="Queue">
      <header className="dsk-pop__head">
        <span className={cls('dsk-q-orb', `is-${tone}`)} aria-hidden><i /></span>
        <div>
          <p className="dsk-pop__eyebrow">Send machine</p>
          <h3>{queueLabel(queue)}</h3>
        </div>
        <button type="button" className="dsk-pop__icon" onClick={() => queue.refresh()} aria-label="Refresh queue"><Icon name="refresh-cw" size={14} /></button>
      </header>
      <div className="dsk-q-grid">
        {tiles.map(([label, value, mod]) => (
          <div key={label} className={cls('dsk-q-tile', mod)}>
            <b>{n(value)}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <dl className="dsk-pop__facts">
        <div><dt>Mode</dt><dd>{queue.mode === 'automatic' ? 'Automatic' : queue.mode === 'paused' ? 'Paused' : 'Assisted'}</dd></div>
        <div><dt>Behind the lag window</dt><dd className={(h?.queuedOlderThanLagWindow ?? 0) > 0 ? 'is-warn' : ''}>{n(h?.queuedOlderThanLagWindow)}</dd></div>
        <div><dt>Blocked</dt><dd>{n(h?.blockedCount)}</dd></div>
        <div><dt>Last send</dt><dd>{ago(h?.latestSentAt)}</dd></div>
        <div><dt>Last delivery report</dt><dd>{ago(h?.latestWebhookAt)}</dd></div>
      </dl>
      <button type="button" className="dsk-pop__cta" onClick={() => { onClose(); pushRoutePath('/queue') }}>
        Open Queue <Icon name="arrow-up-right" size={13} />
      </button>
    </div>
  )
}
