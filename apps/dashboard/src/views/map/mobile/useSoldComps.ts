/**
 * Sold comps on the Map — every sale in view, immediately.
 *
 * get_map_sold_comps (mv_map_sold_comps: MLS + public record + investor
 * purchases, buyer attached, portfolio / institutional detected) for the padded
 * viewport, re-read when the camera settles or the filters change. Individual
 * sales from zoom 12.5, clusters below — nationwide at any zoom.
 *
 *   red        MLS sale          rose     public-record sale
 *   crimson    investor purchase gold ring institutional / hedge fund
 *   amber ring portfolio sale
 */
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'

export type CompSource = 'mls' | 'public_record' | 'investor'
export type BuyerClass = 'institutional' | 'hedge_fund' | 'builder' | 'portfolio' | 'llc_investor' | 'individual' | 'trust' | 'bank' | 'government' | 'unknown'

export interface CompFilters {
  sources: CompSource[]
  classes: BuyerClass[]
  window: '6m' | '12m' | '24m' | 'all'
  minPrice: number | null
  maxPrice: number | null
  portfolioOnly: boolean
  types: string[]
  minBeds: number | null
}

export const DEFAULT_COMP_FILTERS: CompFilters = {
  sources: [], classes: [], window: '12m', minPrice: null, maxPrice: null, portfolioOnly: false, types: [], minBeds: null,
}

export const COMP_SOURCE_LABEL: Record<CompSource, string> = { mls: 'MLS sale', public_record: 'Public record', investor: 'Investor purchase' }
export const BUYER_CLASS_LABEL: Record<BuyerClass, string> = {
  builder: 'Home builder',
  institutional: 'Institutional', hedge_fund: 'Hedge fund', portfolio: 'Portfolio buyer', llc_investor: 'LLC / investor',
  individual: 'Individual', trust: 'Trust / estate', bank: 'Bank / lender', government: 'Government', unknown: 'Buyer not on record',
}

export const COMP_COLOR = ['match', ['get', 'source'], 'mls', '#ff3b4f', 'public_record', '#ff7a8c', 'investor', '#d9163f', '#ff3b4f'] as const
export const COMP_RING = [
  'case',
  ['>', ['get', 'institutional'], 0], '#f5c542',
  ['>=', ['get', 'portfolio_size'], 2], '#ff9f0a',
  'rgba(255,255,255,0.85)',
] as const

const SRC = 'nx-comps'
export const COMP_LAYERS = { glow: 'nx-comps-glow', cluster: 'nx-comps-cluster', count: 'nx-comps-count', point: 'nx-comps-point', halo: 'nx-comps-selected' } as const

export function filtersToRpc(f: CompFilters, now = new Date()): Record<string, unknown> {
  const since = f.window === 'all' ? null : new Date(now.getTime() - ({ '6m': 183, '12m': 365, '24m': 730 } as const)[f.window] * 86400_000).toISOString().slice(0, 10)
  return {
    ...(f.sources.length ? { sources: f.sources } : {}),
    ...(f.classes.length ? { classes: f.classes.flatMap((c) => (c === 'institutional' ? ['institutional', 'hedge_fund'] : [c])) } : {}),
    ...(f.types.length ? { types: f.types } : {}),
    ...(f.minPrice ? { min_price: f.minPrice } : {}),
    ...(f.maxPrice ? { max_price: f.maxPrice } : {}),
    ...(since ? { since } : {}),
    ...(f.portfolioOnly ? { portfolio_only: true } : {}),
    ...(f.minBeds ? { min_beds: f.minBeds } : {}),
  }
}

export function activeCompFilterCount(f: CompFilters): number {
  return (f.sources.length ? 1 : 0) + (f.classes.length ? 1 : 0) + (f.types.length ? 1 : 0) + (f.minPrice || f.maxPrice ? 1 : 0)
    + (f.window !== '12m' ? 1 : 0) + (f.portfolioOnly ? 1 : 0) + (f.minBeds ? 1 : 0)
}

function ensure(map: maplibregl.Map) {
  if (!map.style) return
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const add = (spec: maplibregl.LayerSpecification) => { if (!map.getLayer(spec.id)) map.addLayer(spec) }
  add({
    id: COMP_LAYERS.glow, type: 'circle', source: SRC,
    paint: {
      'circle-radius': ['case', ['>', ['get', 'n'], 1], ['+', 14, ['*', 4, ['ln', ['get', 'n']]]], 11] as never,
      'circle-color': COMP_COLOR as never,
      'circle-blur': 1,
      'circle-opacity': 0.35,
    },
  })
  add({
    id: COMP_LAYERS.cluster, type: 'circle', source: SRC, filter: ['>', ['get', 'n'], 1],
    paint: {
      'circle-radius': ['case', ['<', ['get', 'n'], 5], ['+', 4.5, ['get', 'n']], ['+', 9, ['*', 2.6, ['ln', ['get', 'n']]]]] as never,
      'circle-color': ['case', ['<', ['get', 'n'], 5], '#ff3b4f', 'rgba(40, 6, 14, 0.82)'] as never,
      'circle-stroke-color': ['case', ['>', ['get', 'institutional'], 0], '#f5c542', '#ff3b4f'] as never,
      'circle-stroke-width': 2,
    },
  })
  add({
    id: COMP_LAYERS.count, type: 'symbol', source: SRC, filter: ['>=', ['get', 'n'], 5],
    layout: {
      'text-field': ['case', ['>=', ['get', 'n'], 1000], ['concat', ['to-string', ['round', ['/', ['get', 'n'], 100]]], '00+'], ['to-string', ['get', 'n']]] as never,
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-allow-overlap': false,
      'text-padding': 2,
    },
    paint: { 'text-color': '#ffe4e8' },
  })
  add({
    id: COMP_LAYERS.point, type: 'circle', source: SRC, filter: ['==', ['get', 'n'], 1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4.5, 16, 8] as never,
      'circle-color': COMP_COLOR as never,
      'circle-stroke-color': COMP_RING as never,
      'circle-stroke-width': ['case', ['any', ['>', ['get', 'institutional'], 0], ['>=', ['get', 'portfolio_size'], 2]], 2.6, 1.4] as never,
    },
  })
}

function setVis(map: maplibregl.Map, on: boolean) {
  for (const id of Object.values(COMP_LAYERS)) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') } catch { /* ignore */ }
  }
}

export interface CompsState { loading: boolean; total: number; institutional: number; error: string | null }

export function useSoldComps(map: maplibregl.Map | null, epoch: number, on: boolean, filters: CompFilters): CompsState {
  const [state, setState] = useState<CompsState>({ loading: false, total: 0, institutional: 0, error: null })
  const seq = useRef(0)
  const last = useRef<GeoJSON.FeatureCollection | null>(null)

  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        ensure(map)
        setVis(map, on)
        if (last.current && on) {
          const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
          if (src && (src as unknown as { _data?: unknown })._data !== last.current) src.setData(last.current)
        }
      } catch { /* style mid-swap */ }
    }
    apply()
    map.on('styledata', apply)
    return () => { map.off('styledata', apply) }
  }, [map, epoch, on])

  useEffect(() => {
    if (!map || !on) return
    if (!shouldUseSupabase()) { setState((s) => ({ ...s, error: 'Comps unavailable' })); return }
    const rpcFilters = filtersToRpc(filters)
    let timer = 0
    const load = async () => {
      const id = ++seq.current
      const b = map.getBounds()
      const padLat = (b.getNorth() - b.getSouth()) * 0.2
      const padLng = (b.getEast() - b.getWest()) * 0.2
      setState((s) => ({ ...s, loading: true, error: null }))
      const { data, error } = await getSupabaseClient().rpc('get_map_sold_comps', {
        p_min_lat: b.getSouth() - padLat, p_min_lng: b.getWest() - padLng,
        p_max_lat: b.getNorth() + padLat, p_max_lng: b.getEast() + padLng,
        p_zoom: map.getZoom(), p_filters: rpcFilters,
      })
      if (id !== seq.current) return
      if (error || !Array.isArray(data)) { setState({ loading: false, total: 0, institutional: 0, error: 'Comps unavailable' }); return }
      let total = 0
      let inst = 0
      const features = (data as Array<Record<string, unknown>>).map((r) => {
        const n = Number(r.n) || 1
        total += n
        inst += Number(r.institutional) || 0
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [Number(r.lng), Number(r.lat)] },
          properties: {
            comp_id: r.comp_id ?? null, n, price: Number(r.price) || 0, sold_on: r.sold_on ?? null, source: r.source ?? 'mls',
            buyer_class: r.buyer_class ?? 'unknown', portfolio_size: Number(r.portfolio_size) || 1, institutional: Number(r.institutional) || 0,
          },
        }
      })
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
      last.current = fc
      try { ensure(map); (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData(fc) } catch { /* ignore */ }
      setState({ loading: false, total, institutional: inst, error: null })
    }
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void load() }, 220) }
    schedule()
    map.on('moveend', schedule)
    return () => { map.off('moveend', schedule); window.clearTimeout(timer) }
  }, [map, epoch, on, JSON.stringify(filters)])

  return state
}

export interface CompDetail {
  comp_id: string
  source: CompSource
  sold_on: string | null
  price: number | null
  per_door: number | null
  ppsf: number | null
  lat: number
  lng: number
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  property_type: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  year_built: number | null
  units: number | null
  estimated_value: number | null
  streetview_image: string | null
  buyer: string | null
  owner_type: string | null
  out_of_state_owner: boolean | null
  buyer_class: BuyerClass
  portfolio_size: number
  portfolio: Array<{ comp_id: string; address: string; lat: number; lng: number; type: string | null }> | null
  buyer_stats: { purchases: number; first: string | null; last: string | null; markets: number; median_price?: number | null } | null
  /** Everything the source record knows (blanks dropped). */
  details: Record<string, string | number | boolean | null> | null
}

export async function loadCompDetail(compId: string): Promise<CompDetail | null> {
  const { data, error } = await getSupabaseClient().rpc('get_map_sold_comp', { p_comp_id: compId })
  if (error || !data) return null
  return data as CompDetail
}
