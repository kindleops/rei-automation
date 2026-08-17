/**
 * Single source of truth for the browser Google Maps credential.
 *
 * Canonical variable: `VITE_GOOGLE_MAPS_API_KEY`.
 * The `VITE_` prefix is Vite's own convention for values that are inlined into
 * the client bundle — this key is a *browser* credential by design. It is
 * visible in page source and network requests, and it is protected by HTTP
 * referrer restrictions configured on the key in Google Cloud, not by secrecy.
 * Never put a server-privileged Google key in this variable.
 *
 * There is deliberately no hardcoded fallback. A previous fallback shipped a
 * real key in tracked source (and therefore into git history and every built
 * bundle); when the variable was unset the app silently billed that key instead
 * of failing. Callers must handle a missing key — `getGoogleMapsApiKey()`
 * returns `null` and `loadGoogleMaps()` rejects.
 *
 * Google APIs this key is used for (all browser-side):
 *   · Maps JavaScript API   — Street View panorama only (no map is rendered
 *                             with Google; Map Command uses MapLibre + CARTO)
 *   · Street View Static API
 *   · Maps Static API       — satellite thumbnail
 *   · Maps Embed API
 */
const GOOGLE_MAPS_API_KEY =
  (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY?.trim() || null

let loadPromise: Promise<typeof google.maps> | null = null

/** The browser Maps key, or `null` when unconfigured. Never throws. */
export function getGoogleMapsApiKey(): string | null {
  return GOOGLE_MAPS_API_KEY
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps is only available in the browser'))
  }
  if (!GOOGLE_MAPS_API_KEY) {
    return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not configured'))
  }
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps)
  }
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&v=weekly`
    script.async = true
    script.defer = true
    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google.maps)
        return
      }
      reject(new Error('Google Maps failed to initialize'))
    }
    script.onerror = () => reject(new Error('Google Maps script failed to load'))
    document.head.appendChild(script)
  })

  return loadPromise
}
