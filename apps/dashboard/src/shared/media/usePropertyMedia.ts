/**
 * The one hook every property-media surface uses (constitution §13).
 *
 * Guarantees it provides, so call sites do not have to re-implement them:
 *  - R13.1 keyed only by normalized coordinates / property id / address
 *  - R13.2 no remount or refetch on theme change, pane resize, or scroll —
 *          nothing in this hook reads layout or theme state
 *  - R13.3 the last valid image URL is preserved across a key change
 *  - R13.5 progress is scoped to the media element, never the panel
 *  - R13.7 every failure resolves to one typed reason
 *  - R13.9 verdicts cached by stable key with an explicit TTL
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { buildMediaIdentity, hasResolvableLocation, type IdentityInput } from './identity'
import {
  forgetAvailability,
  peekAvailability,
  probeStreetAvailability,
  type AvailabilityStatus,
} from './availability'
import {
  peekPropertyLocation,
  requestPropertyLocation,
  subscribeToPropertyLocations,
} from './propertyLocations'
import type { MediaFailureReason, PropertyMediaIdentity } from './types'
import {
  buildAerialImageUrl,
  buildStreetImageUrl,
  getMapsApiKey,
  type MediaSizeName,
} from './urls'

export interface UsePropertyMediaOptions extends IdentityInput {
  size?: MediaSizeName
  /** Skip the metadata probe (e.g. an offscreen row). Defaults to true. */
  enabled?: boolean
  /**
   * Recover coordinates from the `properties` table when the caller only has a
   * property id. Off for surfaces that already carry real coordinates.
   */
  resolveMissingCoordinates?: boolean
}

export interface PropertyMediaResult {
  identity: PropertyMediaIdentity
  /** Street pane. */
  street: {
    status: 'probing' | 'ready' | 'failed'
    /** The URL to paint. Null while probing or after a failure. */
    url: string | null
    /** Last URL that painted successfully for ANY key on this surface (R13.3). */
    lastGoodUrl: string | null
    reason: MediaFailureReason | null
    panoDate: string | null
    onLoaded: () => void
    onError: () => void
    retry: () => void
  }
  /** Aerial pane — retries independently of street (R13.6). */
  aerial: {
    status: 'ready' | 'failed'
    url: string | null
    reason: MediaFailureReason | null
    onLoaded: () => void
    onError: () => void
    retry: () => void
  }
}

const noopSubscribe = () => () => {}

export function usePropertyMedia(options: UsePropertyMediaOptions): PropertyMediaResult {
  const {
    size = 'card',
    enabled = true,
    resolveMissingCoordinates = false,
    propertyId,
    address,
    lat,
    lng,
    storedStreetUrl,
    storedAerialUrl,
  } = options

  // Subscribe to the shared property-location cache only when we need it, so
  // surfaces that already have coordinates never re-render on unrelated
  // batch completions.
  const locationVersion = useSyncExternalStore(
    resolveMissingCoordinates ? subscribeToPropertyLocations : noopSubscribe,
    () => (resolveMissingCoordinates ? peekPropertyLocation(propertyId)?.propertyId ?? null : null),
    () => null,
  )

  const seededIdentity = useMemo(
    () => buildMediaIdentity({ propertyId, address, lat, lng, storedStreetUrl, storedAerialUrl }),
    [propertyId, address, lat, lng, storedStreetUrl, storedAerialUrl],
  )

  // Ask for coordinates whenever the caller could not supply real ones.
  //
  // Deliberately NOT gated on the address being absent: exact coordinates beat
  // geocoding an address string every time, so a row that has an address but
  // no coordinates still gets recovered rather than silently geocoded. Once the
  // data layer emits real coordinates this branch stops firing entirely,
  // because `seededIdentity.lat` will already be populated.
  const needsRecovery =
    resolveMissingCoordinates && seededIdentity.lat == null && Boolean(propertyId)
  useEffect(() => {
    if (needsRecovery) requestPropertyLocation(propertyId)
  }, [needsRecovery, propertyId])

  const identity = useMemo(() => {
    if (!resolveMissingCoordinates) return seededIdentity
    const recovered = peekPropertyLocation(propertyId)
    if (!recovered) return seededIdentity
    return buildMediaIdentity({
      propertyId,
      address: seededIdentity.address ?? recovered.address,
      lat: seededIdentity.lat ?? recovered.lat,
      lng: seededIdentity.lng ?? recovered.lng,
      storedStreetUrl: seededIdentity.storedStreetUrl ?? recovered.streetviewImage,
      storedAerialUrl: seededIdentity.storedAerialUrl,
    })
    // locationVersion is the external-store tick that makes this recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededIdentity, propertyId, resolveMissingCoordinates, locationVersion])

  const key = identity.key
  const keyRef = useRef(key)

  const streetImageUrl = useMemo(() => buildStreetImageUrl(identity, size), [identity, size])
  const aerialImageUrl = useMemo(() => buildAerialImageUrl(identity, size), [identity, size])
  const resolvedStreetUrl = identity.storedStreetUrl ?? streetImageUrl
  const resolvedAerialUrl = identity.storedAerialUrl ?? aerialImageUrl

  // ── Street availability ────────────────────────────────────────────────
  const initialStatus = (): AvailabilityStatus | null => {
    if (key === 'none') return { state: 'unavailable', reason: 'NO_COORDINATES' }
    if (!getMapsApiKey() && !identity.storedStreetUrl) {
      return { state: 'unavailable', reason: 'KEY_MISSING' }
    }
    // A server-provided image needs no probe.
    if (identity.storedStreetUrl) return { state: 'available', panoDate: null }
    return peekAvailability(key)
  }

  const [availability, setAvailability] = useState<AvailabilityStatus | null>(initialStatus)
  const [streetImageFailed, setStreetImageFailed] = useState(false)
  const [aerialFailed, setAerialFailed] = useState(false)
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  // Re-sync every piece of local state when the stable key changes.
  // Without this, a `memo`'d component recycled by a virtualised list keeps the
  // previous property's `failed` flag — the defect that made one bad row poison
  // every row that reused its slot.
  if (keyRef.current !== key) {
    keyRef.current = key
    setAvailability(initialStatus())
    setStreetImageFailed(false)
    setAerialFailed(false)
    // lastGoodUrl is deliberately NOT cleared (R13.3).
  }

  useEffect(() => {
    if (!enabled) return
    if (key === 'none') return
    if (identity.storedStreetUrl) return
    if (availability) return
    // Nothing to ask the provider about yet — a coordinate/address lookup is
    // still outstanding. Asking now would produce a NO_COORDINATES verdict that
    // is about our data pipeline, not about the imagery.
    if (!hasResolvableLocation(identity)) return

    let cancelled = false
    void probeStreetAvailability(identity).then((status) => {
      if (!cancelled) setAvailability(status)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, key, identity, availability, retryTick])

  // A record whose location is still being recovered is *probing*, not failed.
  // Only once recovery has settled with nothing do we assert NO_COORDINATES.
  const locationPending =
    !hasResolvableLocation(identity) &&
    resolveMissingCoordinates &&
    Boolean(propertyId) &&
    peekPropertyLocation(propertyId) === undefined

  const streetStatus: 'probing' | 'ready' | 'failed' = (() => {
    if (locationPending) return 'probing'
    if (!hasResolvableLocation(identity) && !identity.storedStreetUrl) return 'failed'
    if (!availability) return enabled ? 'probing' : 'failed'
    if (availability.state === 'unavailable') return 'failed'
    if (streetImageFailed) return 'failed'
    return resolvedStreetUrl ? 'ready' : 'failed'
  })()

  const streetReason: MediaFailureReason | null = (() => {
    if (streetStatus !== 'failed') return null
    if (!getMapsApiKey()) return 'KEY_MISSING'
    if (!hasResolvableLocation(identity) && !identity.storedStreetUrl) return 'NO_COORDINATES'
    if (!availability) return 'NO_COORDINATES'
    if (availability.state === 'unavailable') return availability.reason
    if (streetImageFailed) return 'NO_PANORAMA_AT_LOCATION'
    if (!getMapsApiKey()) return 'KEY_MISSING'
    return 'NO_COORDINATES'
  })()

  const onStreetLoaded = useCallback(() => {
    if (resolvedStreetUrl) setLastGoodUrl(resolvedStreetUrl)
  }, [resolvedStreetUrl])

  const onStreetError = useCallback(() => {
    setStreetImageFailed(true)
  }, [])

  const retryStreet = useCallback(() => {
    forgetAvailability(key)
    setStreetImageFailed(false)
    setAvailability(null)
    setRetryTick((n) => n + 1)
  }, [key])

  // ── Aerial (independent of street, R13.6) ──────────────────────────────
  const aerialStatus: 'ready' | 'failed' =
    resolvedAerialUrl && !aerialFailed ? 'ready' : 'failed'
  const aerialReason: MediaFailureReason | null = (() => {
    if (aerialStatus === 'ready') return null
    if (aerialFailed) return 'PROVIDER_ERROR'
    if (!getMapsApiKey()) return 'KEY_MISSING'
    return 'NO_COORDINATES'
  })()

  const retryAerial = useCallback(() => setAerialFailed(false), [])

  return {
    identity,
    street: {
      status: streetStatus,
      url: streetStatus === 'ready' ? resolvedStreetUrl : null,
      lastGoodUrl,
      reason: streetReason,
      panoDate: availability?.state === 'available' ? availability.panoDate : null,
      onLoaded: onStreetLoaded,
      onError: onStreetError,
      retry: retryStreet,
    },
    aerial: {
      status: aerialStatus,
      url: aerialStatus === 'ready' ? resolvedAerialUrl : null,
      reason: aerialReason,
      onLoaded: () => undefined,
      onError: () => setAerialFailed(true),
      retry: retryAerial,
    },
  }
}
