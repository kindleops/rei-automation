/**
 * Google Maps JS SDK loader.
 *
 * No hardcoded key fallback (constitution R13.12). When the key is unset the
 * loader rejects with `KEY_MISSING` so media surfaces can render the truthful
 * typed failure state instead of silently issuing requests with a literal.
 */
import { getMapsApiKey } from '../../shared/media/urls'

let loadPromise: Promise<typeof google.maps> | null = null

/** `null` when VITE_GOOGLE_MAPS_API_KEY is unset for this build. */
export function getGoogleMapsApiKey(): string | null {
  return getMapsApiKey()
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps is only available in the browser'))
  }
  const apiKey = getMapsApiKey()
  if (!apiKey) {
    return Promise.reject(new Error('KEY_MISSING: VITE_GOOGLE_MAPS_API_KEY is not configured'))
  }
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps)
  }
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`
    script.async = true
    script.defer = true
    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google.maps)
        return
      }
      reject(new Error('Google Maps failed to initialize'))
    }
    script.onerror = () => {
      // Let a later call retry rather than caching a permanently rejected promise.
      loadPromise = null
      reject(new Error('Google Maps script failed to load'))
    }
    document.head.appendChild(script)
  })

  return loadPromise
}
