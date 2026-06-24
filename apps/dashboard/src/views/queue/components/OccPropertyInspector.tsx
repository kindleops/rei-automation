import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../shared/asset-type-icons'
import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import type { QueueItem } from '../../../domain/queue/queue.types'
import {
  resolveMessageLanguage,
  resolveMessageSource,
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
  isNonRetryableRow,
} from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const InspRow = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="occ-insp-row">
    <span className="occ-insp-label">{label}</span>
    <span className={cls('occ-insp-value', tone && `is-${tone}`)}>{value || '—'}</span>
  </div>
)

interface OccPropertyInspectorProps {
  item: QueueItem
  mode: 'queue' | 'event'
  onClose?: () => void
  onOpenQueueRow?: () => void
  onNavigate?: (target: 'property' | 'campaign' | 'template' | 'inbox') => void
  actions?: React.ReactNode
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

  return (
    <aside className="occ-cmd-dock occ-dossier occ-property-inspector">
      <header className="occ-cmd-dock__head">
        <div>
          <strong>{identity.primary}</strong>
          {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
          <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>
            {mode === 'event' ? (item.lastEventType ?? statusView.primary) : statusView.primary}
          </span>
        </div>
        <div className="occ-cmd-dock__head-actions">
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close"><Icon name="close" size={12} /></button>
          )}
        </div>
      </header>

      <div className="occ-property-visual">
        {showImage ? (
          <>
            {!imageLoaded && <div className="occ-property-visual__skeleton" aria-hidden="true" />}
            <img
              src={imageUrl!}
              alt={`Street view for ${item.propertyAddress}`}
              loading="lazy"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        ) : (
          <div className="occ-property-visual__fallback">
            <Icon name="map" size={24} />
            <span>Street View unavailable</span>
            <small>{item.propertyAddress || 'No address on file'}</small>
          </div>
        )}
        <div className="occ-property-visual__actions">
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`} target="_blank" rel="noreferrer">
            Open in Google Maps
          </a>
          {onNavigate && (
            <button type="button" onClick={() => onNavigate('property')}>View property</button>
          )}
        </div>
      </div>

      <div className="occ-cmd-dock__body">
        <InspRow label="Address" value={<><span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={10} /></span> {item.propertyAddress}</>} />
        {cityState && <InspRow label="Location" value={`${cityState}${item.propertyZip ? ` ${item.propertyZip}` : ''} · ${item.market}`} />}
        <InspRow label="Property type" value={item.propertyType} />
        <InspRow label="Owner / seller" value={item.sellerDisplayName || item.sellerName} />
        <InspRow label="Campaign" value={item.campaignName ?? item.campaignId} />
        <InspRow label="Seller stage" value={item.stageLabel ?? item.currentStage} />

        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Execution</div>
          <InspRow label="Template" value={resolveTemplateLabel(item)} />
          <InspRow label="Sender" value={item.fromPhoneNumber} />
          <InspRow label="Recipient" value={item.toPhoneNumber} />
          <InspRow label="Queue state" value={item.statusLabel} />
          <InspRow label="Provider" value={item.deliveryStatus} />
          <InspRow label="Sent" value={item.sentAt ? new Date(item.sentAt).toLocaleString() : '—'} />
          <InspRow label="Delivered" value={item.deliveredAt ? new Date(item.deliveredAt).toLocaleString() : '—'} />
          <InspRow label="Failure / block" value={item.failedReason || item.blockedReason || statusView.blocking} tone={item.failedReason || item.blockedReason ? 'red' : undefined} />
          <InspRow label="Retries" value={item.retryCount} />
          <InspRow label="Cost" value={item.estimatedCost > 0 ? `$${item.estimatedCost.toFixed(3)}` : '—'} />
          <InspRow label="Suppression" value={item.safetyStatus} />
          <InspRow label="Decision reason" value={item.routingReason || item.guardReason} />
        </div>

        {item.messageText && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Rendered message</div>
            <p className="occ-insp-message">{item.messageText}</p>
          </div>
        )}

        {mode === 'event' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Event</div>
            <InspRow label="Type" value={item.lastEventType} />
            <InspRow label="Timestamp" value={item.lastEventAt ? new Date(item.lastEventAt).toLocaleString() : '—'} />
            <InspRow label="Intent" value={item.extractedIntent} />
            <InspRow label="Stage before / after" value={`${item.stageBefore ?? '—'} → ${item.stageAfter ?? '—'}`} />
          </div>
        )}

        <InspRow label="Source" value={resolveMessageLanguage(item)} />
        <InspRow label="Language" value={resolveMessageSource(item)} />
        <InspRow label="Retry" value={retryBlocked ? 'Non-retryable' : item.retryEligible ? 'Eligible' : 'No'} tone={item.retryEligible && !retryBlocked ? 'green' : undefined} />
      </div>

      <footer className="occ-cmd-dock__actions occ-property-inspector__nav">
        {actions}
        {onOpenQueueRow && <button type="button" className="occ-action-btn is-secondary" onClick={onOpenQueueRow}>Open Queue Row</button>}
        {onNavigate && (
          <>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('inbox')}>Open Inbox</button>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('campaign')}>Open Campaign</button>
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onNavigate('template')}>Open Template</button>
          </>
        )}
      </footer>
    </aside>
  )
}