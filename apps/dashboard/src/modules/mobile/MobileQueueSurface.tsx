import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import type { QueueProcessorHealth } from '../../lib/data/inboxData'
import type {
  CampaignControlDiagnostics,
  QueueCommandCaps,
  QueueCommandMode,
} from '../inbox/components/QueueCommandCenter'
import './mobile-queue-surface.css'

/**
 * Q — THE MOBILE QUEUE WORK SURFACE.
 *
 * What this replaces: QueueCommandCenter, the desktop operations panel, rendered
 * inside a half-height sheet. That panel is a dense control board — mode selector,
 * six editable cap fields, a "Why Critical" matrix, ten action buttons, campaign
 * diagnostics — and at 390px in 52vh it was a scrollable wall with no answer to the
 * only question the dock's Q button is asking: is the outbound system working, and
 * is anything stuck.
 *
 * §6 asks for urgent work, queued items, counts, state, context and actions, from
 * the canonical queue data and WITHOUT a second scoring model. So the ordering here
 * is the processor's own: attention first (what the health read already flagged),
 * then flow, then throughput, then where to go next. Nothing is ranked by anything
 * this file invents.
 *
 * Deep operations stay in the Queue application — the full-screen route that already
 * has search, filters and per-row detail. This surface is the peek and the jump, not
 * a second control board, which is also why it never edits caps: two places to change
 * a live send limit is how a cap gets changed twice.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/** The three caps that describe throughput. The other three are per-lane run limits
 *  and belong to the desktop control board, where there is room to explain them. */
const CAP_FIELDS: Array<{ key: keyof QueueCommandCaps; label: string }> = [
  { key: 'sends_per_run', label: 'Sends per run' },
  { key: 'max_per_number_per_day', label: 'Per number / day' },
  { key: 'max_per_market_per_hour', label: 'Per market / hour' },
]

const MODE_LABEL: Record<QueueCommandMode, string> = {
  paused: 'Paused',
  assisted: 'Assisted',
  automatic: 'Automatic',
}

/**
 * The PROCESSOR's own word, not the folded health tone.
 *
 * `status` collapses to four tones for colouring; this is what the badge says, so an
 * empty queue reads "Idle" rather than "Healthy" (which claims more) or an empty pill
 * (which is what happened while `status` was blind-cast from a vocabulary it did not
 * share).
 */
const PROCESSOR_STATE_LABEL: Record<QueueProcessorHealth['processorState'], string> = {
  healthy: 'Healthy',
  idle: 'Idle',
  degraded: 'Degraded',
  attention: 'Attention',
  unknown: 'Unknown',
}

const num = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** `—` is the honest render of a count that has not been read, and 0 is not it. */
const count = (value: number | null | undefined): string =>
  value == null ? '—' : value.toLocaleString()

export interface MobileQueueSurfaceProps {
  open: boolean
  onClose: () => void
  health: QueueProcessorHealth | null
  control: CampaignControlDiagnostics | null
  mode: QueueCommandMode
  caps: QueueCommandCaps
  /** False until the control endpoint answers — the caps shown are defaults, not truth. */
  capsHydrated: boolean
  loading: boolean
  onRefresh: () => void
  /**
   * OPERATIONS, supplied only by a host that can actually perform them.
   *
   * The inbox top bar owns the real handlers (they write through the queue control
   * authority). PortableCommandShell does not — its versions were every one of them
   * `pushRoutePath('/queue')`, i.e. ten buttons that all did the same thing and none
   * of which did what they said. An absent handler renders no button, which is the
   * same rule the dock already applies to Tasks and Live Activity.
   */
  ops?: {
    actionLoading?: string | null
    onRunSafeBatch?: () => void
    onRunQueueNow?: () => void
    onEmergencyPause?: () => void
    onRetryFailed?: () => void
    onReprocessPaused?: () => void
    onReconcileDelivery?: () => void
    onCapsChange?: (patch: Partial<QueueCommandCaps>) => void
  }
}

export const MobileQueueSurface = ({
  open,
  onClose,
  health,
  control,
  mode,
  caps,
  capsHydrated,
  loading,
  onRefresh,
  ops,
}: MobileQueueSurfaceProps) => {
  const status = health?.status ?? 'unknown'
  const processorState = health?.processorState ?? 'unknown'
  // Limits are read-only until asked for. §14's progressive-disclosure rule applies
  // to a live send cap more than to anything else on this screen.
  const [editingCaps, setEditingCaps] = useState(false)

  /**
   * Read health ON OPEN when there is none.
   *
   * The inbox host only starts its health poll after a deliberate 10s background
   * bootstrap gap, so an operator who taps Q inside the first ten seconds — which is
   * most of them, since the dock is the first thing on screen — met a surface where
   * every count read "—" and the header said the queue was PAUSED and UNKNOWN. That
   * is an accurate description of what the client knew and a terrible description of
   * the system. Opening the surface is an explicit request for the answer, so it asks.
   *
   * Guarded by a ref rather than by `health`: a genuinely empty read must not turn
   * into a refetch loop.
   */
  const requestedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      requestedRef.current = false
      return
    }
    if (health || requestedRef.current) return
    requestedRef.current = true
    onRefresh()
  }, [open, health, onRefresh])

  /**
   * ATTENTION, taken from the health read rather than recomputed.
   *
   * Each row is a count the processor already publishes and already treats as a
   * problem. Rows at zero are dropped: a list of seven "0" reasons reads as noise,
   * and the operator is looking for the one that is not zero.
   */
  const attention = useMemo(() => {
    if (!health) return []
    const rows: Array<{ id: string; label: string; value: number; tone: 'critical' | 'warning' }> = [
      { id: 'failed', label: 'Failed today', value: health.failedTodayCount, tone: 'critical' },
      { id: 'blocked', label: 'Blocked', value: health.blockedCount, tone: 'warning' },
      { id: 'routing', label: 'Routing / template gaps', value: health.routingBlockedCount, tone: 'warning' },
      { id: 'suppression', label: 'Suppression blocked', value: health.suppressionBlockedCount, tone: 'warning' },
      { id: 'blank', label: 'Blank body blocked', value: health.blankBodyBlockedCount, tone: 'warning' },
      { id: 'paused', label: 'Paused / invalid', value: health.pausedInvalidCount, tone: 'warning' },
      { id: 'stale', label: `Queued beyond the lag window`, value: health.queuedOlderThanLagWindow, tone: 'warning' },
      { id: 'duplicate', label: 'Duplicate active rows', value: health.duplicateActiveCount, tone: 'critical' },
    ]
    return rows.filter((row) => Number(row.value) > 0)
  }, [health])

  /** Blocked reasons, straight from the control diagnostics. */
  const blockedReasons = useMemo(() => {
    const raw = control?.blocked_reason_counts
    if (!raw) return []
    return Object.entries(raw)
      .map(([reason, value]) => ({ reason, value: num(value) ?? 0 }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value)
      .slice(0, 6)
  }, [control?.blocked_reason_counts])

  const nextWindow = control?.next_send_window ?? null
  const activeCampaign = control?.active_campaign ?? null

  /**
   * Only operations whose handler exists. Ordered least-to-most consequential, with
   * the stop control tinted — a paused system is recoverable, a system that sent the
   * wrong batch is not.
   */
  const queueOperations = useMemo(() => {
    if (!ops) return []
    const entries: Array<{ id: string; label: string; run: () => void; tone?: 'warning' }> = []
    if (ops.onRunSafeBatch) entries.push({ id: 'safe-batch', label: 'Run safe batch', run: ops.onRunSafeBatch })
    if (ops.onRunQueueNow) entries.push({ id: 'run-now', label: 'Run queue now', run: ops.onRunQueueNow })
    if (ops.onRetryFailed) entries.push({ id: 'retry', label: 'Retry failed', run: ops.onRetryFailed })
    if (ops.onReprocessPaused) entries.push({ id: 'reprocess', label: 'Reprocess paused', run: () => ops.onReprocessPaused?.() })
    if (ops.onReconcileDelivery) entries.push({ id: 'reconcile', label: 'Reconcile delivery', run: ops.onReconcileDelivery })
    if (ops.onEmergencyPause) entries.push({ id: 'pause', label: 'Emergency pause', run: ops.onEmergencyPause, tone: 'warning' })
    return entries
  }, [ops])

  const go = (path: string) => {
    onClose()
    pushRoutePath(path)
  }

  if (!open || typeof document === 'undefined') return null

  const layer = (
    <div className="nx-mqs" role="dialog" aria-modal="true" aria-label="Queue intelligence">
      <header className="nx-mqs__bar">
        <div className="nx-mqs__title">
          <strong>Queue</strong>
          <span className={cls('nx-mqs__status', `is-${status}`)}>
            <i aria-hidden />
            {PROCESSOR_STATE_LABEL[processorState]}
          </span>
        </div>
        <div className="nx-mqs__bar-actions">
          <button
            type="button"
            className="nx-mqs__bar-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh queue health"
          >
            <Icon name="refresh-cw" size={14} />
          </button>
          <button type="button" className="nx-mqs__close" aria-label="Close queue" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      <div className="nx-mqs__body">
        {/* ── The operating posture. The single most load-bearing fact on this
              surface: whether the system is sending at all. ───────────────── */}
        <section className="nx-mqs__section">
          {/*
            `mode` defaults to 'paused' in the state hook before the control endpoint
            answers, so rendering it unconditionally announced "PAUSED — outbound
            sending is stopped" about a system that might be sending. Until the read
            lands the honest answer is that we do not know it yet.
          */}
          <div className={cls('nx-mqs__posture', capsHydrated ? `is-${mode}` : 'is-unknown')}>
            <span className="nx-mqs__posture-mode">{capsHydrated ? MODE_LABEL[mode] : 'Reading…'}</span>
            <span className="nx-mqs__posture-detail">
              {!capsHydrated
                ? 'The queue control authority has not answered yet.'
                : mode === 'paused'
                  ? 'Outbound sending is stopped.'
                  : mode === 'automatic'
                    ? 'The processor is sending on its own schedule.'
                    : 'Sends require an operator run.'}
            </span>
          </div>
          {health?.checkedAt ? (
            <p className="nx-mqs__checked">Health read {formatRelativeTime(health.checkedAt)}</p>
          ) : loading ? (
            <p className="nx-mqs__checked">Reading queue health…</p>
          ) : (
            <p className="nx-mqs__checked">Queue health could not be read.</p>
          )}
        </section>

        {/* ── Attention. First because it is the only part that is work. ───── */}
        <section className="nx-mqs__section">
          <h4>Needs attention</h4>
          {!health && loading ? (
            <p className="nx-mqs__empty">Reading queue health…</p>
          ) : !health ? (
            <p className="nx-mqs__empty">
              Queue health is unavailable, so nothing can be said about stuck work.
            </p>
          ) : attention.length === 0 ? (
            <p className="nx-mqs__empty">Nothing is stuck. No failures, blocks or stale rows.</p>
          ) : (
            <div className="nx-mqs__rows">
              {attention.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={cls('nx-mqs__row', `is-${row.tone}`)}
                  onClick={() => go('/queue')}
                >
                  <span className="nx-mqs__row-label">{row.label}</span>
                  <b>{row.value.toLocaleString()}</b>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── Flow. What is in the pipe right now. ─────────────────────────── */}
        <section className="nx-mqs__section">
          <h4>In flight</h4>
          <div className="nx-mqs__strip">
            <div><span>Queued</span><b>{count(health?.queuedCount)}</b></div>
            <div><span>Scheduled</span><b>{count(health?.scheduledCount)}</b></div>
            <div><span>Sending</span><b>{count(health?.sendingCount)}</b></div>
          </div>
          {health?.oldestQueuedAt ? (
            <p className="nx-mqs__note">Oldest queued row {formatRelativeTime(health.oldestQueuedAt)}.</p>
          ) : null}
        </section>

        {/* ── Throughput. Today, from the same health read. ────────────────── */}
        <section className="nx-mqs__section">
          <h4>Today</h4>
          <div className="nx-mqs__strip">
            <div><span>Sent</span><b>{count(health?.sentTodayCount)}</b></div>
            <div><span>Delivered</span><b>{count(health?.deliveredTodayCount)}</b></div>
            <div className={health && health.failedTodayCount > 0 ? 'is-critical' : undefined}>
              <span>Failed</span><b>{count(health?.failedTodayCount)}</b>
            </div>
          </div>
          {health?.latestSentAt ? (
            <p className="nx-mqs__note">Last send {formatRelativeTime(health.latestSentAt)}.</p>
          ) : null}
          {health && !health.webhookHealthy ? (
            <p className="nx-mqs__note is-warning">
              Delivery webhook is stale
              {health.latestWebhookAt ? ` — last callback ${formatRelativeTime(health.latestWebhookAt)}.` : '.'}
            </p>
          ) : null}
        </section>

        {blockedReasons.length > 0 ? (
          <section className="nx-mqs__section">
            <h4>Why rows are blocked</h4>
            <div className="nx-mqs__rows">
              {blockedReasons.map((entry) => (
                <div key={entry.reason} className="nx-mqs__row is-static">
                  <span className="nx-mqs__row-label">{entry.reason.replace(/_/g, ' ')}</span>
                  <b>{entry.value.toLocaleString()}</b>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Context: what is running and when the next window opens. ─────── */}
        {activeCampaign || nextWindow ? (
          <section className="nx-mqs__section">
            <h4>Context</h4>
            {activeCampaign ? (
              <button type="button" className="nx-mqs__context" onClick={() => go('/campaign-command')}>
                <span className="nx-mqs__context-label">Active campaign</span>
                <strong>{activeCampaign.campaign_name || activeCampaign.name || activeCampaign.id}</strong>
                <small>
                  {count(num(activeCampaign.ready_targets))} ready · {count(num(activeCampaign.scheduled_targets))} scheduled
                </small>
              </button>
            ) : null}
            {nextWindow ? (
              <div className="nx-mqs__context is-static">
                <span className="nx-mqs__context-label">Next send window</span>
                <strong>{nextWindow.market || nextWindow.state || 'Market not named'}</strong>
                <small>
                  {nextWindow.window_start_utc
                    ? `Opens ${formatRelativeTime(nextWindow.window_start_utc)}`
                    : 'Window start not published'}
                  {nextWindow.status ? ` · ${nextWindow.status}` : ''}
                </small>
              </div>
            ) : null}
          </section>
        ) : null}

        {queueOperations.length > 0 ? (
          <section className="nx-mqs__section">
            <h4>Operations</h4>
            <div className="nx-mqs__ops">
              {queueOperations.map((operation) => (
                <button
                  key={operation.id}
                  type="button"
                  className={cls('nx-mqs__op', operation.tone && `is-${operation.tone}`)}
                  disabled={Boolean(ops?.actionLoading)}
                  onClick={operation.run}
                >
                  {ops?.actionLoading === operation.id ? 'Working…' : operation.label}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="nx-mqs__section">
          <div className="nx-mqs__section-head">
            <h4>Throughput limits</h4>
            {ops?.onCapsChange ? (
              <button type="button" className="nx-mqs__link" onClick={() => setEditingCaps((v) => !v)}>
                {editingCaps ? 'Done' : 'Adjust'}
              </button>
            ) : null}
          </div>

          {editingCaps && ops?.onCapsChange ? (
            <div className="nx-mqs__caps">
              {CAP_FIELDS.map((field) => (
                <label key={field.key} className="nx-mqs__cap">
                  <span>{field.label}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={caps[field.key]}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (!Number.isFinite(next) || next < 1) return
                      ops.onCapsChange?.({ [field.key]: next } as Partial<QueueCommandCaps>)
                    }}
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="nx-mqs__strip is-compact">
              <div><span>Per run</span><b>{caps.sends_per_run}</b></div>
              <div><span>Per number / day</span><b>{caps.max_per_number_per_day}</b></div>
              <div><span>Per market / hr</span><b>{caps.max_per_market_per_hour}</b></div>
            </div>
          )}

          {!capsHydrated ? (
            <p className="nx-mqs__note is-warning">
              Showing defaults — the control endpoint has not answered, so these are not
              the live caps.
            </p>
          ) : null}
        </section>
      </div>

      {/* Thumb-zone, above the home indicator. */}
      <footer className="nx-mqs__actions">
        <button type="button" className="nx-mqs__action is-primary" onClick={() => go('/queue')}>
          Open Queue
        </button>
        <button type="button" className="nx-mqs__action" onClick={() => go('/campaign-command')}>
          Campaigns
        </button>
      </footer>
    </div>
  )

  return createPortal(layer, document.body)
}
