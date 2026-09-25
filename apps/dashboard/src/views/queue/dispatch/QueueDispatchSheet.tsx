/**
 * Queue item detail — one communication, top to bottom:
 *   state and time → why (reason / recovery) → the message → where it goes →
 *   delivery path → diagnostics (collapsed) → the actions this row allows.
 *
 * Actions are exactly what resolveQueueCapability grants (the same authority
 * the backend enforces), and every one that changes what is sent asks first.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { QueueItem } from '../../../domain/queue/queue.types'
import { resolveSellerIdentity } from '../queue-ui-helpers'
import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import { resolveTouchStageDisplay } from '../../../domain/queue/queue-status-truth'
import { resolveQueueCapability, resolveQueueStateMap } from '../queue-mobile-semantics'
import {
  assetLine,
  dispatchReason,
  dispatchRecovery,
  dispatchStatus,
  dispatchWhen,
  formatPhone,
  languageLine,
  localWhen,
  segmentOf,
} from './queue-dispatch-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type ActionKey = 'approve' | 'retry' | 'reschedule' | 'hold' | 'cancel' | 'view-thread'

interface ActionSpec {
  key: ActionKey
  label: string
  icon: 'check' | 'zap' | 'clock' | 'pause' | 'x' | 'message'
  tone: 'primary' | 'secondary' | 'danger'
  confirm?: { title: string; body: string; cta: string }
}

function actionsFor(item: QueueItem): ActionSpec[] {
  const state = resolveQueueStateMap(item)
  const cap = resolveQueueCapability(item, state)
  const out: ActionSpec[] = []
  if (cap.canApprove) out.push({ key: 'approve', label: 'Approve', icon: 'check', tone: 'primary', confirm: { title: 'Approve this message?', body: 'It will send at its scheduled time, inside the seller’s contact window.', cta: 'Approve' } })
  if (cap.canRetry) out.push({ key: 'retry', label: 'Retry', icon: 'zap', tone: out.length ? 'secondary' : 'primary', confirm: { title: 'Retry this message?', body: `It goes back on the queue for the next processor pass. Attempt ${item.retryCount + 1} of ${item.maxRetries}.`, cta: 'Retry' } })
  if (cap.canReschedule) out.push({ key: 'reschedule', label: 'Move to tomorrow', icon: 'clock', tone: 'secondary', confirm: { title: 'Move to tomorrow?', body: 'The send moves 24 hours later. Contact-window rules still apply.', cta: 'Move' } })
  if (cap.canPause) out.push({ key: 'hold', label: 'Pause', icon: 'pause', tone: 'secondary', confirm: { title: 'Pause this message?', body: 'It stays in the queue but will not send until it is released.', cta: 'Pause' } })
  if (item.linkedInboxThreadId) out.push({ key: 'view-thread', label: 'Conversation', icon: 'message', tone: 'secondary' })
  if (['pre_send', 'blocked', 'failed'].includes(state.lifecycle)) {
    out.push({ key: 'cancel', label: 'Cancel', icon: 'x', tone: 'danger', confirm: { title: 'Cancel this message?', body: 'It will not send. This cannot be undone from the queue.', cta: 'Cancel message' } })
  }
  return out
}

function Fact({ k, v, mono }: { k: string; v: string | null | undefined; mono?: boolean }) {
  if (!v) return null
  return (
    <div className="qx-fact">
      <span className="qx-fact__k">{k}</span>
      <span className={cls('qx-fact__v', mono && 'is-mono')}>{v}</span>
    </div>
  )
}

export function QueueDispatchSheet({
  item,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onAction,
}: {
  item: QueueItem
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onAction: (action: string, id: string) => Promise<void> | void
}) {
  const [closing, setClosing] = useState(false)
  const [pending, setPending] = useState<ActionSpec | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPending(null) }, [item.id])

  const dismiss = () => { setClosing(true); window.setTimeout(onClose, 180) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const identity = resolveSellerIdentity(item)
  const status = dispatchStatus(item)
  const reason = dispatchReason(item)
  const recovery = dispatchRecovery(item)
  const when = dispatchWhen(item)
  const stage = resolveTouchStageDisplay(item)
  const actions = useMemo(() => actionsFor(item), [item])
  const seg = segmentOf(item)
  const state = useMemo(() => resolveQueueStateMap(item), [item])
  const place = [item.propertyCity, item.propertyState, item.propertyZip].filter(Boolean).join(', ')
  const messageMeta = [
    stage.stageCode,
    stage.stageLabel && stage.stageLabel !== 'Unknown / Needs reconciliation' ? stage.stageLabel : null,
    languageLine(item),
  ].filter(Boolean).join(' · ')
  const md = (item.metadata ?? {}) as Record<string, any>

  // One Street View request per opened row (never per list card).
  const lat = md.property_lat ?? md.latitude ?? null
  const lng = md.property_lng ?? md.longitude ?? null
  const streetQuery = [item.propertyAddress, item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const imageUrl = (md.streetview_image ?? md.streetviewImage ?? null) || (item.propertyAddress ? buildStreetViewUrl(streetQuery, lat, lng) : null)
  const [imageFailedFor, setImageFailedFor] = useState<string | null>(null)
  const [imageLoadedFor, setImageLoadedFor] = useState<string | null>(null)
  const showImage = Boolean(imageUrl && imageFailedFor !== item.id)
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat && lng ? `${lat},${lng}` : streetQuery)}`

  const steps = [
    { label: 'Scheduled', at: item.scheduledForUtc || item.scheduledForLocal, done: Boolean(item.scheduledForUtc || item.scheduledForLocal) },
    { label: 'Sent', at: item.sentAt, done: Boolean(item.sentAt) || state.delivery.isDelivered },
    { label: 'Delivered', at: item.deliveredAt, done: state.delivery.isDelivered },
  ]

  const run = async (spec: ActionSpec) => {
    if (spec.confirm && !pending) { setPending(spec); return }
    setBusy(true)
    try { await onAction(spec.key, item.id) } finally {
      setBusy(false)
      setPending(null)
    }
  }

  return createPortal(
    <div className={cls('qx-sheet', closing && 'is-closing')} role="presentation">
      <button type="button" className="qx-sheet__backdrop" aria-label="Close" onClick={dismiss} />
      <section className="qx-sheet__panel" role="dialog" aria-modal="true" aria-label={`${identity.primary} — queue item`}>
        <span className="qx-sheet__grip" aria-hidden="true" />
        <header className="qx-sheet__head">
          <div className="qx-sheet__id">
            <span className={cls('qx-pill', `is-${status.tone}`)}>
              {status.tone === 'cyan' && <span className="qx-pill__pulse" aria-hidden="true" />}
              {status.label}
            </span>
            <strong className="qx-sheet__name">{identity.primary}</strong>
          </div>
          <div className="qx-sheet__nav">
            <button type="button" className="qx-icon is-sm" disabled={index <= 0} onClick={onPrev} aria-label="Previous">
              <Icon name="chevron-left" size={15} />
            </button>
            <span className="qx-sheet__count">{index + 1}/{total}</span>
            <button type="button" className="qx-icon is-sm" disabled={index >= total - 1} onClick={onNext} aria-label="Next">
              <Icon name="chevron-right" size={15} />
            </button>
            <button type="button" className="qx-icon is-sm" onClick={dismiss} aria-label="Close" data-close>
              <Icon name="close" size={14} />
            </button>
          </div>
        </header>

        <div className="qx-sheet__scroll">
          {showImage && (
            <figure className={cls('qx-hero', imageLoadedFor === item.id && 'is-loaded')}>
              <img
                key={item.id}
                src={imageUrl!}
                alt={`Street view of ${item.propertyAddress || 'the property'}`}
                loading="lazy"
                onLoad={() => setImageLoadedFor(item.id)}
                onError={() => setImageFailedFor(item.id)}
              />
              <span className="qx-hero__scrim" aria-hidden="true" />
              <figcaption className="qx-hero__cap">
                <strong>{item.propertyAddress}</strong>
                <span>{[[item.propertyCity, item.propertyState].filter(Boolean).join(', '), assetLine(item)].filter(Boolean).join(' · ')}</span>
              </figcaption>
              <a className="qx-hero__maps" href={mapsHref} target="_blank" rel="noreferrer">
                <Icon name="map" size={12} />
                Maps
              </a>
            </figure>
          )}
          <div className="qx-when">
            <span className="qx-when__main">{when.primary}</span>
            {when.secondary && <span className="qx-when__sub">{when.secondary}</span>}
          </div>

          {reason && (
            <div className={cls('qx-note', `is-${reason.tone}`)} role="status">
              <Icon name={reason.tone === 'red' ? 'alert-circle' : 'alert'} size={15} />
              <div>
                <strong>{reason.title}</strong>
                <p>{reason.detail}</p>
              </div>
            </div>
          )}
          {recovery && (
            <div className={cls('qx-note', recovery.kind === 'recovering' ? 'is-cyan' : 'is-green')}>
              <Icon name={recovery.kind === 'recovering' ? 'refresh-cw' : 'check'} size={15} />
              <div>
                <strong>{recovery.title}</strong>
                <p>{recovery.detail}</p>
              </div>
            </div>
          )}

          {item.messageText && (
            <section className="qx-block">
              <h3 className="qx-block__title">Message{messageMeta && <em>{messageMeta}</em>}</h3>
              <p className="qx-bubble">{item.messageText}</p>
            </section>
          )}

          <section className="qx-block">
            <h3 className="qx-block__title">Property &amp; route</h3>
            <div className="qx-facts">
              <Fact k="Property" v={[item.propertyAddress, place].filter(Boolean).join(' · ') || null} />
              <Fact k="Asset" v={assetLine(item)} />
              <Fact k="Owner" v={identity.primary} />
              <Fact k="To" v={formatPhone(item.toPhoneNumber)} mono />
              <Fact k="From" v={[formatPhone(item.fromPhoneNumber), item.market].filter(Boolean).join(' · ') || null} />
              <Fact k="Campaign" v={item.campaignName ?? null} />
              <Fact k="Local time" v={item.timezone ? item.timezone.replace(/_/g, ' ') : null} />
            </div>
          </section>

          <section className="qx-block">
            <h3 className="qx-block__title">Delivery</h3>
            <ol className="qx-path">
              {steps.map((s) => (
                <li key={s.label} className={cls('qx-path__step', s.done && 'is-done')}>
                  <span className="qx-path__dot" aria-hidden="true" />
                  <span className="qx-path__label">{s.label}</span>
                  <span className="qx-path__at">{s.done ? (localWhen(s.at, item.timezone) ?? 'Recorded') : seg === 'attention' && s.label !== 'Scheduled' ? '—' : 'Pending'}</span>
                </li>
              ))}
            </ol>
          </section>

          <details className="qx-diag">
            <summary>Diagnostics</summary>
            <div className="qx-facts">
              <Fact k="Status" v={item.queueStatusRaw || item.status} mono />
              <Fact k="Reason code" v={reason?.code ?? null} mono />
              <Fact k="Retries" v={item.maxRetries ? `${item.retryCount} of ${item.maxRetries}` : null} />
              <Fact k="Template" v={item.selectedTemplateId || item.templateId} mono />
              <Fact k="Replaced template" v={md.template_reselected_from?.template_id ?? md.rotated_from_template_id ?? null} mono />
              <Fact k="Provider ID" v={item.providerMessageId} mono />
              <Fact k="Queue ID" v={item.id} mono />
              <Fact k="Updated" v={localWhen(item.updatedAt, item.timezone)} />
            </div>
          </details>
        </div>

        {pending ? (
          <footer className="qx-confirm" role="alertdialog" aria-label={pending.confirm?.title}>
            <strong>{pending.confirm?.title}</strong>
            <p>{pending.confirm?.body}</p>
            <div className="qx-confirm__row">
              <button type="button" className="qx-act is-secondary" onClick={() => setPending(null)} disabled={busy}>Back</button>
              <button type="button" className={cls('qx-act', pending.tone === 'danger' ? 'is-danger' : 'is-primary')} onClick={() => run(pending)} disabled={busy}>
                {busy ? 'Working…' : pending.confirm?.cta}
              </button>
            </div>
          </footer>
        ) : (
          <footer className="qx-actions">
            {actions.length === 0 && <span className="qx-actions__none">Nothing to do — {status.label.toLowerCase()}</span>}
            {actions.map((a) => (
              <button key={a.key} type="button" className={cls('qx-act', `is-${a.tone}`)} onClick={() => run(a)} disabled={busy}>
                <Icon name={a.icon} size={13} />
                {a.label}
              </button>
            ))}
          </footer>
        )}
      </section>
    </div>,
    document.body,
  )
}

// ── Picker sheets: filters and other views ──────────────────────────────────

export function QueueDispatchPicker({
  title,
  onClose,
  children,
  footer,
  className,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  const [closing, setClosing] = useState(false)
  const dismiss = () => { setClosing(true); window.setTimeout(onClose, 180) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return createPortal(
    <div className={cls('qx-sheet', 'is-picker', className, closing && 'is-closing')} role="presentation">
      <button type="button" className="qx-sheet__backdrop" aria-label="Close" onClick={dismiss} />
      <section className="qx-sheet__panel" role="dialog" aria-modal="true" aria-label={title}>
        <span className="qx-sheet__grip" aria-hidden="true" />
        <header className="qx-sheet__head">
          <strong className="qx-sheet__name">{title}</strong>
          <button type="button" className="qx-icon is-sm" onClick={dismiss} aria-label="Close" data-close>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="qx-sheet__scroll">{children}</div>
        {footer && <footer className="qx-actions">{footer}</footer>}
      </section>
    </div>,
    document.body,
  )
}
