import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import { buildStreetViewUrl } from '../../../../domain/inbox/inbox-normalization'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import { resolveTouchStageDisplay } from '../../../../domain/queue/queue-status-truth'
import {
  resolveMessageLanguage,
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
} from '../../queue-ui-helpers'
import {
  resolveQueueAttention,
  resolveQueueCapability,
  resolveQueueStateMap,
} from '../../queue-mobile-semantics'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const relTime = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const fmtWhen = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const fmtPhone = (p: string | null | undefined) =>
  p ? `···${String(p).replace(/\D/g, '').slice(-4)}` : null

/** 'clear', 'ok' and 'none' all mean "no suppression" — none is worth a row. */
const CLEAN_SAFETY = new Set(['', 'clear', 'ok', 'none', 'null', 'clean'])
const isSuppressed = (status: string | null | undefined) =>
  Boolean(status) && !CLEAN_SAFETY.has(String(status).trim().toLowerCase())

/** Section that never renders when it has nothing to say. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qms-block">
      <h3 className="qms-block__title">{title}</h3>
      {children}
    </section>
  )
}

function Step({
  label,
  when,
  absolute,
  state,
}: {
  label: string
  when: string
  absolute: string | null
  state: 'done' | 'active' | 'pending'
}) {
  return (
    <div className={cls('qms-step', `is-${state}`)} title={absolute ?? undefined}>
      <span className="qms-step__dot" aria-hidden="true" />
      <span className="qms-step__label">{label}</span>
      <span className="qms-step__when">{when}</span>
    </div>
  )
}

interface QueueMobileItemSheetProps {
  item: QueueItem
  mode: 'queue' | 'event'
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onAction: (action: string, id: string) => void
}

export function QueueMobileItemSheet({
  item,
  mode,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onAction,
}: QueueMobileItemSheetProps) {
  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const state = useMemo(() => resolveQueueStateMap(item), [item])
  const attention = useMemo(() => resolveQueueAttention(item, state), [item, state])
  const capability = useMemo(() => resolveQueueCapability(item, state), [item, state])
  const stage = resolveTouchStageDisplay(item)

  const lat = item.metadata?.property_lat ?? item.metadata?.latitude ?? null
  const lng = item.metadata?.property_lng ?? item.metadata?.longitude ?? null
  const cachedStreet = item.metadata?.streetview_image ?? item.metadata?.streetviewImage ?? null
  // Derived rather than effect-synced so navigating to the next item cannot
  // render one frame carrying the previous property's street view.
  const imageUrl = cachedStreet ?? buildStreetViewUrl(item.propertyAddress, lat, lng)
  const [imageFailedFor, setImageFailedFor] = useState<string | null>(null)
  const showImage = Boolean(imageUrl && imageFailedFor !== item.id)
  const mapsQuery = lat && lng ? `${lat},${lng}` : item.propertyAddress

  // One location line — city/state/zip/market deduplicated against each other.
  const locationParts: string[] = []
  const cityState = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  if (cityState) locationParts.push(cityState)
  if (item.propertyZip) locationParts.push(item.propertyZip)
  if (item.market && !locationParts.some((p) => p.toLowerCase() === item.market.toLowerCase())) {
    const marketBase = item.market.replace(/,\s*[A-Z]{2}$/, '')
    if (!cityState.toLowerCase().startsWith(marketBase.toLowerCase())) locationParts.push(item.market)
  }
  const locationLine = locationParts.join(' · ')

  const owner = item.sellerDisplayName || item.sellerName
  const templateLabel = resolveTemplateLabel(item)
  const languageLabel = resolveMessageLanguage(item)
  const messageContext = [
    templateLabel !== '—' ? templateLabel : (stage.stageLabel ?? null),
    languageLabel !== 'Unknown' ? languageLabel : null,
  ].filter(Boolean).join(' · ')

  const scheduledDone = Boolean(item.scheduledForLocal)
  const sentDone = Boolean(item.sentAt)
  const deliveredDone = Boolean(item.deliveredAt) || state.delivery.isDelivered

  const routingRows = [
    item.routingReason ? { k: 'Routing', v: item.routingReason } : null,
    item.guardReason ? { k: 'Guard', v: item.guardReason } : null,
    isSuppressed(item.safetyStatus) ? { k: 'Suppression', v: item.safetyStatus! } : null,
    item.routingRuleName ? { k: 'Rule', v: item.routingRuleName } : null,
    item.estimatedCost > 0 ? { k: 'Cost', v: `$${item.estimatedCost.toFixed(3)}` } : null,
  ].filter(Boolean) as Array<{ k: string; v: string }>

  const eventRows = mode === 'event'
    ? ([
        item.lastEventType ? { k: 'Event', v: item.lastEventType } : null,
        item.lastEventAt ? { k: 'When', v: relTime(item.lastEventAt) ?? '—' } : null,
        item.extractedIntent ? { k: 'Intent', v: item.extractedIntent } : null,
        item.stageBefore || item.stageAfter
          ? { k: 'Stage shift', v: `${item.stageBefore ?? '—'} → ${item.stageAfter ?? '—'}` }
          : null,
      ].filter(Boolean) as Array<{ k: string; v: string }>)
    : []

  const primaryActions: Array<{ key: string; label: string; icon: 'zap' | 'clock' | 'pause' | 'check' }> = []
  if (capability.canApprove) primaryActions.push({ key: 'approve', label: 'Approve', icon: 'check' })
  if (capability.canRetry) primaryActions.push({ key: 'retry', label: 'Retry', icon: 'zap' })
  if (capability.canReschedule) primaryActions.push({ key: 'reschedule', label: 'Reschedule', icon: 'clock' })
  if (capability.canPause) primaryActions.push({ key: 'hold', label: 'Pause', icon: 'pause' })

  // Keyed to the row so the panel closes implicitly on Prev / Next.
  const [moreForId, setMoreForId] = useState<string | null>(null)
  const moreOpen = moreForId === item.id

  return createPortal(
    <MobileBottomSheet open snap="expanded" onClose={onClose} className="qms-sheet">
      <header className="qms-chrome">
        <div className="qms-chrome__lead">
          <span className="qms-chrome__eyebrow">{mode === 'event' ? 'Event' : 'Queue item'}</span>
          <strong className="qms-chrome__name">{identity.primary}</strong>
        </div>
        <div className="qms-chrome__nav">
          <button type="button" className="qms-chrome__btn" disabled={index <= 0} onClick={onPrev} aria-label="Previous item">
            <Icon name="chevron-left" size={15} />
          </button>
          <span className="qms-chrome__counter">{index + 1} / {total}</span>
          <button type="button" className="qms-chrome__btn" disabled={index >= total - 1} onClick={onNext} aria-label="Next item">
            <Icon name="chevron-right" size={15} />
          </button>
          <button type="button" className="qms-chrome__btn is-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className="qms-body">
        {showImage && (
          <div className="qms-hero">
            <img
              src={imageUrl!}
              alt={`Street view for ${item.propertyAddress || 'property'}`}
              loading="lazy"
              onError={() => setImageFailedFor(item.id)}
            />
            <span className="qms-hero__scrim" aria-hidden="true" />
            <div className="qms-hero__chips">
              <span className={cls('qms-hero__status', `is-${statusView.tone}`)}>
                {mode === 'event' ? (item.lastEventType ?? statusView.primary) : statusView.primary}
              </span>
            </div>
            <a
              className="qms-hero__maps"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="map" size={11} />
              Maps
            </a>
          </div>
        )}

        <div className="qms-identity">
          <div className="qms-identity__copy">
            <strong className="qms-identity__address">{item.propertyAddress || 'No address on file'}</strong>
            {locationLine && <span className="qms-identity__place">{locationLine}</span>}
          </div>
          <div className="qms-identity__contact">
            {identity.phoneEnding && <span className="qms-tag is-mono">{identity.phoneEnding}</span>}
            {owner && owner !== identity.primary && <span className="qms-tag">{owner}</span>}
            {!showImage && (
              <a
                className="qms-tag is-link"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="map" size={10} />
                Maps
              </a>
            )}
          </div>
        </div>

        {attention.needsAttention && (
          <div className={cls('qms-attention', `is-${attention.tone}`)} role="status">
            <Icon name="alert" size={14} />
            <div>
              <strong>{attention.headline}</strong>
              {attention.detail && <p>{attention.detail}</p>}
            </div>
          </div>
        )}

        {item.messageText && (
          <Block title="Outbound message">
            {messageContext && <span className="qms-msg__context">{messageContext}</span>}
            <blockquote className="qms-msg">{item.messageText}</blockquote>
          </Block>
        )}

        <Block title="Delivery">
          <div className="qms-timeline">
            <Step
              label="Scheduled"
              when={scheduledDone ? (relTime(item.scheduledForLocal) ?? '—') : 'Not set'}
              absolute={fmtWhen(item.scheduledForLocal)}
              state={scheduledDone ? 'done' : item.status === 'scheduled' ? 'active' : 'pending'}
            />
            <Step
              label="Sent"
              when={sentDone
                ? (relTime(item.sentAt) ?? '—')
                : deliveredDone ? 'Not recorded' : 'Pending'}
              absolute={fmtWhen(item.sentAt)}
              state={deliveredDone || sentDone ? 'done' : state.lifecycle === 'in_flight' ? 'active' : 'pending'}
            />
            <Step
              label="Delivered"
              when={deliveredDone ? (relTime(item.deliveredAt) ?? 'Confirmed') : state.delivery.status}
              absolute={fmtWhen(item.deliveredAt)}
              state={deliveredDone ? 'done' : sentDone ? 'active' : 'pending'}
            />
          </div>
        </Block>

        <Block title="What this row can do">
          <div className={cls('qms-capability', `is-${capability.tone}`)}>
            <span className="qms-capability__label">{capability.label}</span>
            <p className="qms-capability__copy">{capability.explanation}</p>
          </div>
          {(item.retryCount > 0 || state.lifecycle === 'failed') && (
            <span className="qms-capability__meta">
              {item.retryCount} of {item.maxRetries} retries used
            </span>
          )}
        </Block>

        <Block title="Routing">
          <div className="qms-route">
            <span className="qms-tag is-mono">{fmtPhone(item.fromPhoneNumber) ?? 'No sender'}</span>
            <Icon name="chevron-right" size={12} />
            <span className="qms-tag is-mono">{fmtPhone(item.toPhoneNumber) ?? 'No recipient'}</span>
          </div>
          <div className="qms-tags">
            {item.market && <span className="qms-tag">{item.market}</span>}
            {(item.campaignName ?? item.campaignId) && (
              <span className="qms-tag">{item.campaignName ?? item.campaignId}</span>
            )}
            {stage.stageCode && <span className="qms-tag">{stage.stageCode}{stage.touchLabel !== '—' ? ` · ${stage.touchLabel}` : ''}</span>}
          </div>
          {routingRows.length > 0 && (
            <div className="qms-kv">
              {routingRows.map((r) => (
                <div key={r.k} className="qms-kv__row"><span>{r.k}</span><span>{r.v}</span></div>
              ))}
            </div>
          )}
        </Block>

        {eventRows.length > 0 && (
          <Block title="Event">
            <div className="qms-kv">
              {eventRows.map((r) => (
                <div key={r.k} className="qms-kv__row"><span>{r.k}</span><span>{r.v}</span></div>
              ))}
            </div>
          </Block>
        )}

        {statusView.historicalWarnings.length > 0 && (
          <Block title="Historical notes">
            <div className="qms-tags">
              {statusView.historicalWarnings.map((w) => (
                <span key={w} className="qms-tag is-amber">{w}</span>
              ))}
            </div>
          </Block>
        )}
      </div>

      <footer className="qms-actions">
        {mode === 'event' ? (
          <button type="button" className="qms-action is-secondary" onClick={() => onAction('open-queue-row', item.id)}>
            Open queue row
          </button>
        ) : (
          <>
            {primaryActions.length === 0 && (
              <span className="qms-actions__none">No action available · {capability.label}</span>
            )}
            {primaryActions.map((a, i) => (
              <button
                key={a.key}
                type="button"
                className={cls('qms-action', i === 0 ? 'is-primary' : 'is-secondary')}
                onClick={() => onAction(a.key, item.id)}
              >
                <Icon name={a.icon} size={12} />
                {a.label}
              </button>
            ))}
            <button
              type="button"
              className="qms-action is-more"
              onClick={() => setMoreForId(moreOpen ? null : item.id)}
              aria-expanded={moreOpen}
            >
              More
              <Icon name={moreOpen ? 'chevron-down' : 'chevron-up'} size={12} />
            </button>
          </>
        )}
      </footer>

      {moreOpen && mode === 'queue' && (
        <div className="qms-more" role="group" aria-label="Secondary actions">
          {item.linkedInboxThreadId && (
            <button type="button" className="qms-more__btn" onClick={() => onAction('view-thread', item.id)}>Open conversation</button>
          )}
          {state.lifecycle === 'blocked' && (
            <button type="button" className="qms-more__btn" onClick={() => onAction('retry-routing', item.id)}>Re-resolve routing</button>
          )}
          {/* `cancel` is the only single-row stop mutation the backend exposes; there
              is no distinct per-row suppress endpoint, so none is offered here. */}
          <button type="button" className="qms-more__btn is-danger" onClick={() => onAction('cancel', item.id)}>Cancel row</button>
        </div>
      )}
    </MobileBottomSheet>,
    document.body,
  )
}
