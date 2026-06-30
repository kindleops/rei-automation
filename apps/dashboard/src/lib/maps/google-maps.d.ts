declare namespace google.maps {
  class LatLng {
    constructor(lat: number, lng: number)
    lat(): number
    lng(): number
  }

  class Geocoder {
    geocode(
      request: { address?: string; location?: LatLng },
      callback: (results: Array<{ geometry: { location: LatLng } }> | null, status: string) => void,
    ): void
  }

  class StreetViewService {
    getPanorama(
      request: { location: LatLng; radius?: number; source?: string },
      callback: (data: { location: { pano: string; latLng: LatLng } } | null, status: string) => void,
    ): void
  }

  class StreetViewPanorama {
    constructor(container: HTMLElement, opts?: Record<string, unknown>)
    setPosition(latLng: LatLng): void
    setPano(pano: string): void
    setPov(pov: { heading: number; pitch: number }): void
    setVisible(visible: boolean): void
  }

  namespace event {
    function trigger(instance: object, eventName: string): void
  }
}

declare const google: {
  maps: typeof google.maps
}

interface Window {
  google?: typeof google
}