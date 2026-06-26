import type { AnyRecord } from '../../lib/data/shared'

export interface ResolvedCoordinates {
  latitude: number | null
  longitude: number | null
  lat: number | null
  lng: number | null
  coordinate_source: string
  coordinate_confidence: number
  is_market_fallback: boolean
  is_subject_resolved: boolean
  failure_reason: string | null
}

function parseCoordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(n) || Math.abs(n) < 0.0001) return null
  return n
}

function isPlausible(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null) return false
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false
  return true
}

function detectReversed(lat: number | null, lng: number | null) {
  if (lat === null || lng === null) return { lat, lng, reversed: false }
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) return { lat: lng, lng: lat, reversed: true }
  return { lat, lng, reversed: false }
}

function pickCoord(sources: unknown[], keys: string[]): number | null {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const record = source as AnyRecord
    for (const key of keys) {
      const value = parseCoordinate(record[key])
      if (value !== null) return value
    }
  }
  return null
}

export function resolveCoordinatesFromContext(sources: {
  dealContext?: AnyRecord | null
  thread?: AnyRecord | null
  property?: AnyRecord | null
  rawPayload?: AnyRecord | null
  propertyRecord?: AnyRecord | null
}): ResolvedCoordinates {
  const { dealContext, thread, property, rawPayload, propertyRecord } = sources
  const propertyBag = [
    propertyRecord,
    property,
    dealContext?.property,
    dealContext,
    thread,
    rawPayload,
  ].filter(Boolean)

  const chains: Array<{ id: string; confidence: number; latKeys: string[]; lngKeys: string[] }> = [
    {
      id: 'properties_table',
      confidence: 95,
      latKeys: ['latitude', 'lat'],
      lngKeys: ['longitude', 'lng'],
    },
    {
      id: 'deal_context',
      confidence: 90,
      latKeys: ['latitude', 'lat'],
      lngKeys: ['longitude', 'lng'],
    },
    {
      id: 'property_record',
      confidence: 88,
      latKeys: ['latitude', 'lat'],
      lngKeys: ['longitude', 'lng'],
    },
    {
      id: 'raw_payload',
      confidence: 75,
      latKeys: ['latitude', 'lat', 'parcel_latitude', 'parcel_lat', 'situs_latitude'],
      lngKeys: ['longitude', 'lng', 'lon', 'parcel_longitude', 'parcel_lng', 'situs_longitude'],
    },
  ]

  for (const chain of chains) {
    const rawLat = pickCoord(propertyBag, chain.latKeys)
    const rawLng = pickCoord(propertyBag, chain.lngKeys)
    const { lat, lng, reversed } = detectReversed(rawLat, rawLng)
    if (isPlausible(lat, lng)) {
      return {
        latitude: lat,
        longitude: lng,
        lat,
        lng,
        coordinate_source: chain.id,
        coordinate_confidence: reversed ? Math.max(40, chain.confidence - 15) : chain.confidence,
        is_market_fallback: false,
        is_subject_resolved: true,
        failure_reason: null,
      }
    }
  }

  const zip = String(
    dealContext?.propertyZip ??
      dealContext?.property_zip ??
      property?.property_address_zip ??
      thread?.property_zip ??
      '',
  ).trim()
  const market = String(dealContext?.market ?? property?.market ?? thread?.market ?? '').trim()

  return {
    latitude: null,
    longitude: null,
    lat: null,
    lng: null,
    coordinate_source: zip || market ? 'market_search_only' : 'unresolved',
    coordinate_confidence: zip || market ? 18 : 0,
    is_market_fallback: Boolean(zip || market),
    is_subject_resolved: false,
    failure_reason: zip || market
      ? 'Exact parcel coordinates unavailable; market-level search only'
      : 'No coordinates found in deal context or property record',
  }
}

export function subjectHasCoordinates(coords: ResolvedCoordinates): boolean {
  return coords.is_subject_resolved && coords.latitude !== null && coords.longitude !== null
}