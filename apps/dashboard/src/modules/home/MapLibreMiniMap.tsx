import { useEffect, useMemo, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

type MarketSnapshot = {
  name: string
  lng: number
  lat: number
  activeLeads: number
  hotReplies: number
  queueDepth: number
  pressure: number
}

interface MapLibreMiniMapProps {
  markets: MarketSnapshot[]
  heatMode: boolean
  leadPulses: boolean
  expanded?: boolean
  activeMarketName?: string
  onMarketSelect?: (marketName: string) => void
}

const SOURCE_ID = 'home-mini-markets'
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const toGeoJson = (market: MarketSnapshot): GeoJSON.Feature<GeoJSON.Point> => ({
  type: 'Feature',
  geometry: {
    type: 'Point',
    coordinates: [market.lng, market.lat],
  },
  properties: {
    name: market.name,
    activeLeads: market.activeLeads,
    hotReplies: market.hotReplies,
    queueDepth: market.queueDepth,
    pressure: market.pressure,
  },
})

export const MapLibreMiniMap = ({
  markets,
  heatMode,
  leadPulses,
  expanded = false,
  activeMarketName,
  onMarketSelect,
}: MapLibreMiniMapProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const pulseTimerRef = useRef<number | null>(null)
  const activeMarketNameRef = useRef(activeMarketName)
  const heatModeRef = useRef(heatMode)
  const leadPulsesRef = useRef(leadPulses)
  const onMarketSelectRef = useRef(onMarketSelect)

  const marketGeoJson = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      type: 'FeatureCollection',
      features: markets.map(toGeoJson),
    }),
    [markets]
  )

  useEffect(() => {
    activeMarketNameRef.current = activeMarketName
  }, [activeMarketName])

  useEffect(() => {
    heatModeRef.current = heatMode
  }, [heatMode])

  useEffect(() => {
    leadPulsesRef.current = leadPulses
  }, [leadPulses])

  useEffect(() => {
    onMarketSelectRef.current = onMarketSelect
  }, [onMarketSelect])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [-95.8, 36.9],
      zoom: 3.35,
      minZoom: 2.8,
      maxZoom: 7,
      attributionControl: false,
      interactive: true,
      dragRotate: false,
      pitchWithRotate: false,
    })

    mapRef.current = map

    map.on('load', () => {
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: marketGeoJson,
      })

      map.addLayer({
        id: 'home-mini-heat',
        type: 'heatmap',
        source: SOURCE_ID,
        paint: {
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'pressure'],
            50,
            0.2,
            95,
            1,
          ],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            0.4,
            6,
            1.2,
          ],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(32,42,50,0)',
            0.25,
            'rgba(50,124,162,0.24)',
            0.55,
            'rgba(38,187,154,0.34)',
            0.8,
            'rgba(244,179,79,0.44)',
            1,
            'rgba(246,107,107,0.52)',
          ],
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            18,
            6,
            38,
          ],
          'heatmap-opacity': heatModeRef.current ? 0.55 : 0,
        },
      })

      map.addLayer({
        id: 'home-mini-pulse',
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': 18,
          'circle-color': 'rgba(56, 189, 248, 0.14)',
          'circle-stroke-color': 'rgba(56, 189, 248, 0.3)',
          'circle-stroke-width': 1,
          'circle-opacity': leadPulsesRef.current ? 0.9 : 0,
        },
      })

      map.addLayer({
        id: 'home-mini-point',
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['get', 'pressure'],
            55,
            4,
            95,
            8,
          ],
          'circle-color': [
            'interpolate',
            ['linear'],
            ['get', 'pressure'],
            55,
            '#4ad8a4',
            75,
            '#45c8ff',
            90,
            '#f5b849',
            100,
            '#f87171',
          ],
          'circle-stroke-width': 1.2,
          'circle-stroke-color': 'rgba(255,255,255,0.56)',
        },
      })

      map.addLayer({
        id: 'home-mini-selected-ring',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'name'], activeMarketNameRef.current ?? ''],
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(56, 189, 248, 0.12)',
          'circle-stroke-color': 'rgba(185, 235, 255, 0.82)',
          'circle-stroke-width': 1.4,
          'circle-blur': 0.2,
        },
      })

      map.addLayer({
        id: 'home-mini-label',
        type: 'symbol',
        source: SOURCE_ID,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.35],
          'text-anchor': 'top',
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#d6f7ff',
          'text-halo-color': 'rgba(5, 10, 14, 0.92)',
          'text-halo-width': 1.4,
          'text-opacity': 0.9,
        },
      })

      map.on('mouseenter', 'home-mini-point', () => {
        map.getCanvas().style.cursor = 'pointer'
      })

      map.on('mouseleave', 'home-mini-point', () => {
        map.getCanvas().style.cursor = ''
      })

      map.on('click', 'home-mini-point', (event) => {
        const feature = event.features?.[0]
        if (!feature || feature.geometry.type !== 'Point') return

        const props = feature.properties as {
          name: string
          activeLeads: number
          hotReplies: number
          queueDepth: number
          pressure: number
        }

        const [lng, lat] = feature.geometry.coordinates
        onMarketSelectRef.current?.(props.name)

        const popupHtml = `
          <div class="home-mini-popup">
            <h4>${props.name}</h4>
            <div class="home-mini-popup__grid">
              <span>Active leads</span><strong>${props.activeLeads}</strong>
              <span>Hot replies</span><strong>${props.hotReplies}</strong>
              <span>Queue depth</span><strong>${props.queueDepth}</strong>
              <span>Pressure score</span><strong>${props.pressure}</strong>
            </div>
          </div>
        `

        new maplibregl.Popup({ closeButton: false, offset: 16, maxWidth: '220px' })
          .setLngLat([lng, lat])
          .setHTML(popupHtml)
          .addTo(map)
      })

      map.fitBounds(
        [
          [Math.min(...markets.map((m) => m.lng)) - 7.8, Math.min(...markets.map((m) => m.lat)) - 4.2],
          [Math.max(...markets.map((m) => m.lng)) + 5.6, Math.max(...markets.map((m) => m.lat)) + 5.2],
        ],
        { padding: 26, animate: false }
      )
    })

    return () => {
      if (pulseTimerRef.current) window.clearInterval(pulseTimerRef.current)
      map.remove()
      mapRef.current = null
    }
  }, [marketGeoJson, markets])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getSource(SOURCE_ID)) return

    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource
    source.setData(marketGeoJson)
  }, [marketGeoJson])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('home-mini-heat')) return
    map.setPaintProperty('home-mini-heat', 'heatmap-opacity', heatMode ? 0.55 : 0)
  }, [heatMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('home-mini-selected-ring')) return
    map.setFilter('home-mini-selected-ring', ['==', ['get', 'name'], activeMarketName ?? ''])
  }, [activeMarketName])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('home-mini-pulse')) return

    map.setPaintProperty('home-mini-pulse', 'circle-opacity', leadPulses ? 0.85 : 0)

    if (pulseTimerRef.current) {
      window.clearInterval(pulseTimerRef.current)
      pulseTimerRef.current = null
    }

    if (!leadPulses) return

    let t = 0
    pulseTimerRef.current = window.setInterval(() => {
      if (!map.getLayer('home-mini-pulse')) return
      t += 0.08
      const radius = 14 + Math.abs(Math.sin(t)) * 16
      map.setPaintProperty('home-mini-pulse', 'circle-radius', radius)
      map.setPaintProperty('home-mini-pulse', 'circle-opacity', 0.2 + Math.abs(Math.sin(t)) * 0.55)
    }, 80)

    return () => {
      if (pulseTimerRef.current) {
        window.clearInterval(pulseTimerRef.current)
        pulseTimerRef.current = null
      }
    }
  }, [leadPulses])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    window.setTimeout(() => map.resize(), 120)
  }, [expanded])

  return <div ref={containerRef} className="home-v2-maplibre" aria-label="Live market intelligence mini map" />
}
