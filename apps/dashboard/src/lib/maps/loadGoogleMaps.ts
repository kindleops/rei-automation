const GOOGLE_MAPS_API_KEY =
  (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY
  || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'

let loadPromise: Promise<typeof google.maps> | null = null

export function getGoogleMapsApiKey(): string {
  return GOOGLE_MAPS_API_KEY
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps is only available in the browser'))
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