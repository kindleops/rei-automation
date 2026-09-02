import { useEffect, useState } from 'react'

/**
 * Street View availability gate.
 *
 * The Street View *image* endpoint answers HTTP 200 with a grey "Sorry, we have no
 * imagery here" JPEG when a location has no panorama. Rendering that response as the
 * property hero is indistinguishable from a real photo to the <img> tag, so the only
 * authoritative signal is the metadata endpoint, which reports a real status code.
 *
 * Pixel heuristics on the returned JPEG are deliberately NOT used — they are not
 * authoritative and break whenever Google restyles the apology image.
 */
export type StreetViewHeroState = 'loading' | 'available' | 'unavailable' | 'error'

/** Results are cached per URL so a Peek → Focus promotion cannot refetch. */
const availabilityCache = new Map<string, StreetViewHeroState>()
const inflight = new Map<string, Promise<StreetViewHeroState>>()

/**
 * Only Google Street View URLs need gating; a non-Google image asset is already authoritative.
 *
 * A stored `streetview_image` may be a PRE-SIGNED URL. Its `signature` is computed over the
 * image path, so carrying it onto the metadata path makes Google reject the request with
 * 403 "Provided 'signature' is not valid for the provided API key". Metadata is unsigned and
 * free, so the signing params are dropped.
 */
export const toStreetViewMetadataUrl = (imageUrl: string): string | null => {
  if (!imageUrl.includes('/maps/api/streetview?')) return null
  // String surgery, not URL round-tripping: re-serialising through URL rewrites %20 as +
  // and would silently alter the request we send.
  return imageUrl
    .replace('/maps/api/streetview?', '/maps/api/streetview/metadata?')
    .replace(/([?&])(signature|secret)=[^&]*/g, '$1')
    .replace(/&{2,}/g, '&')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '')
}

const probe = (metadataUrl: string): Promise<StreetViewHeroState> => {
  const existing = inflight.get(metadataUrl)
  if (existing) return existing
  const request = fetch(metadataUrl)
    .then(async (response): Promise<StreetViewHeroState> => {
      if (!response.ok) return 'error'
      const payload = await response.json() as { status?: string }
      // OK is the only status that guarantees a real panorama. ZERO_RESULTS and
      // NOT_FOUND both mean "no imagery"; the rest are API/quota failures.
      if (payload?.status === 'OK') return 'available'
      if (payload?.status === 'ZERO_RESULTS' || payload?.status === 'NOT_FOUND') return 'unavailable'
      return 'error'
    })
    .catch((): StreetViewHeroState => 'error')
    .then((result) => {
      availabilityCache.set(metadataUrl, result)
      inflight.delete(metadataUrl)
      return result
    })
  inflight.set(metadataUrl, request)
  return request
}

const resolveSync = (
  imageUrl: string | null | undefined,
  metadataUrl: string | null,
): StreetViewHeroState => {
  if (!imageUrl) return 'unavailable'
  if (!metadataUrl) return 'available'
  return availabilityCache.get(metadataUrl) ?? 'loading'
}

export const useStreetViewAvailability = (imageUrl: string | null | undefined): StreetViewHeroState => {
  const metadataUrl = imageUrl ? toStreetViewMetadataUrl(imageUrl) : null
  const [state, setState] = useState<StreetViewHeroState>(() => resolveSync(imageUrl, metadataUrl))
  const [trackedUrl, setTrackedUrl] = useState(imageUrl)

  // Adjusting state during render (React's documented pattern) rather than in an effect:
  // the synchronous verdict for a new property is known immediately, and routing it through
  // an effect would render one wrong frame first.
  if (imageUrl !== trackedUrl) {
    setTrackedUrl(imageUrl)
    setState(resolveSync(imageUrl, metadataUrl))
  }

  useEffect(() => {
    if (!metadataUrl || availabilityCache.has(metadataUrl)) return
    let cancelled = false
    void probe(metadataUrl).then((result) => { if (!cancelled) setState(result) })
    return () => { cancelled = true }
  }, [metadataUrl])

  return state
}
