/**
 * NO KEY IN SOURCE.
 *
 * This read VITE_GOOGLE_MAPS_API_KEY with a literal Google Maps key as the
 * `||` fallback, so the key shipped in every built bundle and worked whether
 * or not the environment was configured — which is exactly why nobody noticed
 * it was missing from the environment.
 *
 * Config is now the only source. With none, Maps FAILS CLOSED: getGoogleMapsApiKey
 * returns null, hasGoogleMapsApiKey is false, and callers omit the imagery
 * rather than firing a request with a checked-in credential.
 *
 * A guard test (maps-key-hygiene.test.ts) fails if a literal key returns to
 * source.
 */
const GOOGLE_MAPS_API_KEY =
  ((import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY || '').trim()

let loadPromise: Promise<typeof google.maps> | null = null

export function getGoogleMapsApiKey(): string | null {
  return GOOGLE_MAPS_API_KEY || null
}

/** Callers must check this before offering any Maps-backed visual. */
export function hasGoogleMapsApiKey(): boolean {
  return GOOGLE_MAPS_API_KEY.length > 0
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps is only available in the browser'))
  }
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps)
  }
  if (loadPromise) return loadPromise
  if (!GOOGLE_MAPS_API_KEY) {
    // Fail closed rather than requesting with no key (or a checked-in one).
    return Promise.reject(new Error('google_maps_api_key_not_configured'))
  }

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