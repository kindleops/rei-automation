import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { PropertyActionHandlers, PropertyRecord } from './property.types'

interface PropertyVisualIntelligenceProps {
  property: PropertyRecord
  handlers: PropertyActionHandlers
}

type VisualTab = 'map' | 'satellite' | 'street'

const tabs: Array<{ id: VisualTab; label: string; icon: 'map' | 'layers' | 'eye' }> = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'satellite', label: 'Satellite', icon: 'layers' },
  { id: 'street', label: 'Street', icon: 'eye' },
]

const googleMapsUrl = (property: PropertyRecord) => {
  const query = property.lat !== null && property.lng !== null ? `${property.lat},${property.lng}` : property.address
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

export const PropertyVisualIntelligence = ({ property, handlers }: PropertyVisualIntelligenceProps) => {
  const [activeTab, setActiveTab] = useState<VisualTab>('map')
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const activeImage = useMemo(() => {
    if (activeTab === 'map') return property.media.mapImage
    if (activeTab === 'satellite') return property.media.satelliteImage
    return property.media.streetviewImage
  }, [activeTab, property.media.mapImage, property.media.satelliteImage, property.media.streetviewImage])

  useEffect(() => {
    setImageLoaded(false)
    setImageFailed(false)
  }, [activeImage])

  const showImage = Boolean(activeImage && !imageFailed)

  return (
    <section className="pi-visual-panel" aria-label="Visual intelligence">
      <div className="pi-visual-panel__toolbar">
        <div className="pi-visual-tabs" role="tablist" aria-label="Property visual tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'is-active' : ''}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon name={tab.icon} />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="pi-visual-panel__links">
          <button type="button" onClick={handlers.viewOnMap}>
            <Icon name="map" />
            Open Live Map
          </button>
          <a href={googleMapsUrl(property)} target="_blank" rel="noreferrer">
            <Icon name="arrow-up-right" />
            Google Maps
          </a>
        </div>
      </div>

      <div className={`pi-visual-frame ${showImage ? 'has-image' : 'is-placeholder'}`}>
        {showImage ? (
          <>
            {!imageLoaded && <div className="pi-visual-skeleton" aria-hidden="true" />}
            <img
              key={activeImage}
              src={activeImage ?? ''}
              alt={`${tabs.find((tab) => tab.id === activeTab)?.label ?? 'Property'} view for ${property.address}`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        ) : (
          <div className="pi-map-art pi-map-art--large" aria-hidden="true" />
        )}
        <div className="pi-visual-overlay">
          <div>
            <span>{property.market ?? 'Unknown Market'}</span>
            <strong>{property.street ?? property.address}</strong>
            <small>{[property.city, property.state, property.zip].filter(Boolean).join(', ') || 'Location unavailable'}</small>
          </div>
          <div className="pi-visual-pin">
            <Icon name="pin" />
          </div>
        </div>
      </div>
    </section>
  )
}
