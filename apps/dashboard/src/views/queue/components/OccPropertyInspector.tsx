import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../shared/asset-type-icons'
import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import type { QueueItem } from '../../../domain/queue/queue.types'
import { STAGE_LABELS } from '../../../domain/queue/queue.types'
import {
  resolveMessageLanguage,
  resolveMessageSource,
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
  isNonRetryableRow,
} from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtPhone = (p: string | null | undefined) => (p ? `···${String(p).replace(/\D/g, '').slice(-4)}` : '—')

const fmtWhen = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting carrier',
  sent: 'With carrier',
  delivered: 'Delivered',
  failed: 'Failed',
  bounced: 'Bounced',
  rejected: 'Rejected',
}

const STAGE_TONE: Record<string, string> = {
  S1: 'blue', S2: 'cyan', S3: 'violet', S4: 'amber', S5: 'green',
  manual_reply: 'muted', auto_reply: 'teal',
}

function DossierChip({
  icon,
  children,
  tone,
  mono,
  title,
}: {
  icon?: IconName
  children: ReactNode
  tone?: string
  mono?: boolean
  title?: string
}) {
  return (
    <span className={cls('occ-mchip', 'occ-dossier-chip', tone && `is-${tone}`, mono && 'is-mono')} title={title}>
      {icon && <Icon name={icon} size={10} />}
      <span className="occ-mchip__val">{children}</span>
    </span>
  )
}

function DossierSection({ title, children, tone }: { title: string; children: ReactNode; tone?: 'failure' | 'diag' }) {
  return (
    <section className={cls('occ-dossier-section', tone && `occ-dossier-section--${tone}`)}>
      <h3 className="occ-dossier-section__title">{title}</h3>
      {children}
    </section>
  )
}

function TimelineStep({
  label,
  relative,
  absolute,
  state,
}: {
  label: string
  relative: string
  absolute: string | null
  state: 'done' | 'active' | 'pending'
}) {
  return (
    <div className={cls('occ-dossier-step', `is-${state}`)} title={absolute ?? undefined}>
      <span className="occ-dossier-step__rail" aria-hidden="true">
        <span className="occ-dossier-step__dot" />
      </span>
      <div className="occ-dossier-step__copy">
        <span className="occ-dossier-step__label">{label}</span>
        <span className="occ-dossier-step__time">{relative}</span>
      </div>
    </div>
  )
}

interface OccPropertyInspectorProps {
  item: QueueItem
  mode: 'queue' | 'event'
  onClose?: () => void
  onOpenQueueRow?: () => void
  onNavigate?: (target: 'property' | 'campaign' | 'template' | 'inbox') => void
  actions?: ReactNode
}

export function OccPropertyInspector({ item, mode, onClose, onOpenQueueRow, onNavigate, actions }: OccPropertyInspectorProps) {
  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const asset = resolveAssetTypeIcon(item.propertyType)
  const retryBlocked = isNonRetryableRow(item)
  const cityState = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const lat = item.metadata?.property_lat ?? item.metadata?.latitude ?? null
  const lng = item.metadata?.property_lng ?? item.metadata?.longitude ?? null
  const cachedStreet = item.metadata?.streetview_image ?? item.metadata?.streetviewImage ?? null

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  useEffect(() => {
    setImageFailed(false)
    setImageLoaded(false)
    if (cachedStreet) {
      setImageUrl(cachedStreet)
      return
    }
    const built = buildStreetViewUrl(item.propertyAddress, lat, lng)
    setImageUrl(built)
  }, [item.id, cachedStreet, item.propertyAddress, lat, lng])

  const mapsQuery = useMemo(() => {
    if (lat && lng) return `${lat},${lng}`
    return item.propertyAddress
  }, [lat, lng, item.propertyAddress])

  const showImage = Boolean(imageUrl && !imageFailed)

  const stageLabel = item.stageLabel ?? (item.stageCode ? STAGE_LABELS[item.stageCode] : null)
  const stageTone = item.stageCode ? (STAGE_TONE[item.stageCode] ?? 'muted') : 'muted'
  const workflowLane = resolveMessageSource(item)
  const templateLabel = resolveTemplateLabel(item)
  const languageLabel = resolveMessageLanguage(item)
  const sourceLabel = item.campaignName ?? item.automationSource ?? item.useCase ?? 'Queue'
  const deliveryLabel = DELIVERY_STATUS_LABELS[item.deliveryStatus] ?? item.deliveryStatus ?? '—'
  const ownerLabel = item.sellerDisplayName || item.sellerName
  const locationLine = [
    cityState,
    item.propertyZip,
    item.market ? item.market : null,
  ].filter(Boolean).join(' · ')

  const scheduledDone = Boolean(item.scheduledForLocal)
  const sentDone = Boolean(item.sentAt)
  const deliveredDone = Boolean(item.deliveredAt)

  const sentState: 'done' | 'active' | 'pending' = deliveredDone || sentDone
    ? 'done'
    : item.status === 'sending' || item.status === 'sent'
      ? 'active'
      : 'pending'

  const deliveredState: 'done' | 'active' | 'pending' = deliveredDone
    ? 'done'
    : sentDone && item.deliveryStatus === 'pending'
      ? 'active'
      : 'pending'

  const showRoutingDetail = Boolean(
    item.routingReason || item.guardReason || item.safetyStatus || item.estimatedCost > 0,
  )

  const accentTone = statusView.tone
  const isDock = Boolean(onClose)

  return (
    <aside
      className={cls(
        'occ-cmd-dock',
        'occ-dossier',
        'occ-property-inspector',
        'occ-dossier-panel',
        isDock && 'is-dock',
      )}
      style={{ '--occ-dossier-accent': `var(--occ-${accentTone === 'muted' ? 'dim' : accentTone})` } as React.CSSProperties}
    >
      {isDock && (
        <header className="occ-dossier-dock-chrome">
          <div className="occ-dossier-dock-chrome__lead">
            <span className="occ-dossier-dock-chrome__eyebrow">{mode === 'event' ? 'Event' : 'Queue item'}</span>
            <strong className="occ-dossier-dock-chrome__title">{identity.primary}</strong>
          </div>
          <button type="button" className="occ-dossier-dock-chrome__close" onClick={onClose} aria-label="Close dossier">
            <Icon name="close" size={14} />
          </button>
        </header>
      )}

      <div className="occ-dossier-hero">
        <div className="occ-property-visual occ-dossier-hero__visual">
          {showImage ? (
            <>
              {!imageLoaded && <div className="occ-property-visual__skeleton" aria-hidden="true" />}
              <img
                src={imageUrl!}
                alt={`Street view for ${item.propertyAddress || 'property'}`}
                loading="lazy"
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageFailed(true)}
              />
            </>
          ) : (
            <div className="occ-property-visual__fallback">
              <Icon name="map" size={24} />
              <span>No street view</span>
              <small>{item.propertyAddress || 'Address not on file'}</small>
            </div>
          )}
          <div className="occ-dossier-hero__scrim" aria-hidden="true" />
          <div className="occ-dossier-hero__overlay">
            <div className="occ-dossier-hero__chips">
              <span className={cls('occ-status-pill', 'occ-status-pill--dossier', `is-${statusView.tone}`)}>
                {mode === 'event' ? (item.lastEventType ?? statusView.primary) : statusView.primary}
              </span>
              {item.market && <DossierChip icon="pin" tone="cyan">{item.market}</DossierChip>}
              {item.stageCode && (
                <DossierChip icon="layers" tone={stageTone} title={stageLabel ?? undefined}>
                  {item.stageCode}
                </DossierChip>
              )}
              <DossierChip icon="hash" mono title="Touch number">T{item.touchNumber}</DossierChip>
            </div>
            <div className="occ-dossier-hero__actions">
              <a
                className="occ-dossier-hero__map-btn"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="map" size={11} />
                Maps
              </a>
              {onNavigate && (
                <button type="button" className="occ-dossier-hero__map-btn" onClick={() => onNavigate('property')}>
                  Property
                </button>
              )}
            </div>
          </div>
        </div>

      </div>

      <div className="occ-cmd-dock__body occ-dossier-panel__body">
        <div className="occ-dossier-identity">
          <div className={cls('occ-dossier-identity__avatar', identity.glyph === 'property' && 'is-property')}>
            <Icon name={asset.icon} size={14} />
          </div>
          <div className="occ-dossier-identity__copy">
            <strong className="occ-dossier-identity__name">{identity.primary}</strong>
            {identity.secondary && <span className="occ-dossier-identity__sub">{identity.secondary}</span>}
            <div className="occ-dossier-identity__meta">
              {identity.phoneEnding && <DossierChip mono tone="dim">{identity.phoneEnding}</DossierChip>}
              {ownerLabel && ownerLabel !== identity.primary && (
                <DossierChip tone="muted" title="Owner on record">{ownerLabel}</DossierChip>
              )}
            </div>
          </div>
        </div>

        <div className="occ-dossier-property">
          <span className="occ-dossier-property__icon" aria-hidden="true">
            <Icon name="pin" size={12} />
          </span>
          <div className="occ-dossier-property__copy">
            <strong>{item.propertyAddress || 'No address on file'}</strong>
            {locationLine && <span>{locationLine}</span>}
          </div>
          {item.propertyType && (
            <DossierChip tone="muted" title={asset.label}>{item.propertyType}</DossierChip>
          )}
        </div>

        {statusView.blocking && (
          <div className="occ-dossier-alert" role="status">
            <Icon name="alert" size={14} />
            <div>
              <strong>{statusView.hasCurrentException ? 'Needs attention' : 'Note'}</strong>
              <p>{statusView.blocking}</p>
            </div>
          </div>
        )}

        {statusView.historicalWarnings.length > 0 && (
          <DossierSection title="Historical notes" tone="diag">
            <div className="occ-dossier-chip-row">
              {statusView.historicalWarnings.map((warn) => (
                <DossierChip key={warn} tone="amber">{warn}</DossierChip>
              ))}
            </div>
          </DossierSection>
        )}

        <DossierSection title="Outbound message">
          <div className="occ-dossier-chip-row">
            <DossierChip icon="zap" title={workflowLane}>{workflowLane}</DossierChip>
            <DossierChip icon="file-text" title={templateLabel}>{templateLabel}</DossierChip>
            <DossierChip tone="muted" title="Message language">{languageLabel}</DossierChip>
            <DossierChip tone="muted" title="Automation source">{sourceLabel}</DossierChip>
          </div>
          {item.messageText && (
            <blockquote className="occ-dossier-quote">
              <span className="occ-dossier-quote__mark" aria-hidden="true">"</span>
              <p>{item.messageText}</p>
            </blockquote>
          )}
        </DossierSection>

        <DossierSection title="Delivery">
          <div className="occ-dossier-timeline">
            <TimelineStep
              label="Scheduled"
              relative={scheduledDone ? relTime(item.scheduledForLocal) : 'Not yet'}
              absolute={fmtWhen(item.scheduledForLocal)}
              state={scheduledDone ? 'done' : item.status === 'scheduled' ? 'active' : 'pending'}
            />
            <TimelineStep
              label="Sent"
              relative={sentDone ? relTime(item.sentAt) : 'Pending'}
              absolute={fmtWhen(item.sentAt)}
              state={sentState}
            />
            <TimelineStep
              label="Delivered"
              relative={deliveredDone ? relTime(item.deliveredAt) : deliveryLabel}
              absolute={fmtWhen(item.deliveredAt)}
              state={deliveredState}
            />
          </div>
          <div className="occ-dossier-chip-row occ-dossier-chip-row--tight">
            <DossierChip icon="activity" title="Carrier status">{deliveryLabel}</DossierChip>
            {(item.retryCount > 0 || item.status === 'failed' || item.status === 'retry') && (
              <DossierChip tone={retryBlocked ? 'red' : 'amber'} title="Retry attempts">
                {item.retryCount} {item.retryCount === 1 ? 'retry' : 'retries'}
              </DossierChip>
            )}
            {item.estimatedCost > 0 && (
              <DossierChip mono tone="muted">${item.estimatedCost.toFixed(3)}</DossierChip>
            )}
            {retryBlocked
              ? <DossierChip tone="red">Won&apos;t retry</DossierChip>
              : item.retryEligible
                ? <DossierChip tone="green">Retry eligible</DossierChip>
                : null}
          </div>
        </DossierSection>

        <DossierSection title="Contact & routing">
          <div className="occ-dossier-route">
            <div className="occ-dossier-route__lane">
              <span className="occ-dossier-route__dir">From</span>
              <DossierChip icon="phone" mono title={item.fromPhoneNumber ?? undefined}>{fmtPhone(item.fromPhoneNumber)}</DossierChip>
            </div>
            <span className="occ-dossier-route__arrow" aria-hidden="true">
              <Icon name="chevron-right" size={12} />
            </span>
            <div className="occ-dossier-route__lane">
              <span className="occ-dossier-route__dir">To</span>
              <DossierChip icon="phone" mono title={item.toPhoneNumber ?? undefined}>{fmtPhone(item.toPhoneNumber)}</DossierChip>
            </div>
          </div>
          <div className="occ-dossier-chip-row">
            {(item.campaignName ?? item.campaignId) && (
              <DossierChip icon="zap" title="Campaign">{item.campaignName ?? item.campaignId}</DossierChip>
            )}
            {stageLabel && (
              <DossierChip icon="layers" tone={stageTone} title="Conversation stage">{stageLabel}</DossierChip>
            )}
            {item.statusLabel && (
              <DossierChip tone="muted" title="Queue state">{item.statusLabel}</DossierChip>
            )}
          </div>
        </DossierSection>

        {showRoutingDetail && (
          <DossierSection title="Routing detail">
            <div className="occ-dossier-kv">
              {item.routingReason && (
                <div className="occ-dossier-kv__row">
                  <span>Routing</span>
                  <span>{item.routingReason}</span>
                </div>
              )}
              {item.guardReason && (
                <div className="occ-dossier-kv__row">
                  <span>Guard</span>
                  <span>{item.guardReason}</span>
                </div>
              )}
              {item.safetyStatus && item.safetyStatus !== 'clear' && (
                <div className="occ-dossier-kv__row">
                  <span>Suppression</span>
                  <span className="is-amber">{item.safetyStatus}</span>
                </div>
              )}
            </div>
          </DossierSection>
        )}

        {mode === 'event' && (
          <DossierSection title="Latest event">
            <div className="occ-dossier-kv">
              <div className="occ-dossier-kv__row">
                <span>Event</span>
                <span>{item.lastEventType ?? '—'}</span>
              </div>
              <div className="occ-dossier-kv__row">
                <span>When</span>
                <span>{item.lastEventAt ? relTime(item.lastEventAt) : '—'}</span>
              </div>
              {item.extractedIntent && (
                <div className="occ-dossier-kv__row">
                  <span>Intent</span>
                  <span>{item.extractedIntent}</span>
                </div>
              )}
              {(item.stageBefore || item.stageAfter) && (
                <div className="occ-dossier-kv__row">
                  <span>Stage shift</span>
                  <span>{item.stageBefore ?? '—'} → {item.stageAfter ?? '—'}</span>
                </div>
              )}
            </div>
          </DossierSection>
        )}
      </div>

      <footer className="occ-cmd-dock__actions occ-property-inspector__nav occ-dossier-panel__actions">
        {actions}
        {onOpenQueueRow && (
          <button type="button" className="occ-action-btn is-secondary" onClick={onOpenQueueRow}>
            Open queue row
          </button>
        )}
        {onNavigate && (
          <>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('inbox')}>Inbox</button>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('campaign')}>Campaign</button>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('template')}>Template</button>
          </>
        )}
      </footer>
    </aside>
  )
}