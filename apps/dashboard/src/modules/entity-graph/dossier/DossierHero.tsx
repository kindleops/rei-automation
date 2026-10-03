/**
 * The dossier hero — the property, seen.
 *
 * Street View is asked with `return_error_code=true`, so a location Google has
 * no imagery for answers 404 instead of the grey "Sorry, we have no imagery
 * here" tile (which loads as a perfectly good 200 image and used to be what
 * operators saw). On 404 the hero drops to a satellite frame of the parcel; if
 * that fails too, or no Maps key is configured, a liquid-glass field carries
 * the address. Never a grey box.
 */
import { useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { InteractiveStreetViewPanorama } from '../../deal-intelligence/InteractiveStreetViewPanorama'
import { getCachedStreetViewStatus, rememberStreetViewResult } from '../../inbox/utils/streetViewImageCache'

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

type Tier = 'street' | 'satellite' | 'none'

function hasCoords(lat?: number | null, lng?: number | null): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001
}

function streetUrl(address: string | null, lat?: number | null, lng?: number | null): string | null {
  if (!MAPS_KEY) return null
  const location = hasCoords(lat, lng) ? `${lat},${lng}` : (address ?? '').trim()
  if (!location) return null
  const params = new URLSearchParams({
    size: '640x400', scale: '2', location, fov: '80', pitch: '3', source: 'outdoor',
    return_error_code: 'true', key: MAPS_KEY,
  })
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`
}

function satelliteUrl(address: string | null, lat?: number | null, lng?: number | null): string | null {
  if (!MAPS_KEY) return null
  const center = hasCoords(lat, lng) ? `${lat},${lng}` : (address ?? '').trim()
  if (!center) return null
  const params = new URLSearchParams({
    center, zoom: '19', size: '640x400', scale: '2', maptype: 'satellite', key: MAPS_KEY,
  })
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
}

function initialTier(street: string | null, satellite: string | null): Tier {
  if (street && getCachedStreetViewStatus(street) !== 'failed') return 'street'
  if (satellite) return 'satellite'
  return 'none'
}

type Props = {
  address: string | null
  locality: string | null
  lat: number | null
  lng: number | null
  chips: string[]
  onOpenMap: () => void
  /** Browser 1.0: research this property's records beside Entity Graph */
  onResearch?: (() => void) | null
  children?: ReactNode
}

export function DossierHero({ address, locality, lat, lng, chips, onOpenMap, onResearch, children }: Props) {
  const street = streetUrl(address, lat, lng)
  const satellite = satelliteUrl(address, lat, lng)
  const key = `${street ?? ''}|${satellite ?? ''}`

  const [tier, setTier] = useState<Tier>(() => initialTier(street, satellite))
  const [loaded, setLoaded] = useState(false)
  const [lookAround, setLookAround] = useState(false)
  const [panoFailed, setPanoFailed] = useState(false)
  const [renderedKey, setRenderedKey] = useState(key)
  if (renderedKey !== key) {
    setRenderedKey(key)
    setTier(initialTier(street, satellite))
    setLoaded(false)
    setLookAround(false)
    setPanoFailed(false)
  }

  const src = tier === 'street' ? street : tier === 'satellite' ? satellite : null
  const interactive = lookAround && tier === 'street' && !panoFailed

  return (
    <section className={`egd-hero is-${tier}${loaded ? ' is-loaded' : ''}`}>
      <div className="egd-hero__media">
        <div className="egd-hero__liquid" aria-hidden="true"><i /><i /><i /></div>
        {interactive ? (
          <InteractiveStreetViewPanorama address={address} lat={lat} lng={lng} visible onFailure={() => setPanoFailed(true)} />
        ) : src ? (
          <img
            key={src}
            src={src}
            alt={tier === 'street' ? `Street View of ${address ?? 'the property'}` : `Satellite view of ${address ?? 'the property'}`}
            decoding="async"
            onLoad={() => {
              setLoaded(true)
              if (tier === 'street' && street) rememberStreetViewResult(street, true)
            }}
            onError={() => {
              setLoaded(false)
              if (tier === 'street') {
                if (street) rememberStreetViewResult(street, false)
                setTier(satellite ? 'satellite' : 'none')
              } else {
                setTier('none')
              }
            }}
          />
        ) : null}
        {!interactive ? <div className="egd-hero__scrim" aria-hidden="true" /> : null}
        {tier === 'satellite' && loaded && !interactive ? (
          <span className="egd-hero__badge"><Icon name="globe" /> Satellite · no street imagery here</span>
        ) : null}
      </div>

      {!interactive ? (
        <div className="egd-hero__id">
          {chips.length ? (
            <div className="egd-hero__chips">
              {chips.map((chip) => <span key={chip}>{chip}</span>)}
            </div>
          ) : null}
          <h2>{address ?? 'Address not recorded'}</h2>
          {locality ? <p>{locality}</p> : null}
        </div>
      ) : null}

      <div className="egd-hero__tools">
        {tier === 'street' && loaded ? (
          <button type="button" className={`egd-glassbtn${interactive ? ' is-on' : ''}`} onClick={() => { setPanoFailed(false); setLookAround((v) => !v) }}>
            <Icon name="eye" />
            {interactive ? 'Done' : 'Look around'}
          </button>
        ) : null}
        <button type="button" className="egd-glassbtn" onClick={onOpenMap}>
          <Icon name="map" />
          Map
        </button>
        {onResearch ? (
          <button type="button" className="egd-glassbtn" onClick={onResearch}>
            <Icon name="compass" />
            Research
          </button>
        ) : null}
      </div>
      {children}
    </section>
  )
}
