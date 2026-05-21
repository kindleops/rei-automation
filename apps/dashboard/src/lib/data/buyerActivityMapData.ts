import { getSupabaseClient } from '../supabaseClient'

export type BuyerDemandMetric =
  | 'buyer_activity_6mo'
  | 'investor_demand'
  | 'buyer_heat'
  | 'sold_price'

export interface BuyerDemandLayerPoint {
  id: string
  layer: 'buyer_demand'
  label: string
  lat: number
  lng: number
  value: number
  score: number
  metric: BuyerDemandMetric
  geo_level: string
  geo_key: string
  metadata: {
    purchase_count: number
    buyer_count: number
    corporate_buyer_count: number
    avg_purchase_price: number | null
    median_purchase_price: number | null
    buyer_heat_score: number
    velocity_score: number
    liquidity_score: number
    investor_demand_score: number
  }
}

const METRIC_SCORE_FIELD: Record<BuyerDemandMetric, string> = {
  buyer_activity_6mo: 'velocity_score',
  investor_demand: 'investor_demand_score',
  buyer_heat: 'buyer_heat_score',
  sold_price: 'avg_purchase_price',
}

export const loadBuyerDemandLayerPoints = async (
  metric: BuyerDemandMetric,
  limit = 750,
): Promise<BuyerDemandLayerPoint[]> => {
  const supabase = getSupabaseClient()
  const scoreField = METRIC_SCORE_FIELD[metric]

  const { data, error } = await supabase
    .from('buyer_activity_geo_rollups')
    .select([
      'geo_level', 'geo_key', 'centroid_lat', 'centroid_lng',
      'purchase_count', 'buyer_count', 'corporate_buyer_count',
      'avg_purchase_price', 'median_purchase_price',
      'buyer_heat_score', 'velocity_score', 'liquidity_score', 'investor_demand_score',
    ].join(','))
    .gt('purchase_count', 0)
    .order(scoreField, { ascending: false, nullsFirst: false })
    .limit(limit)

  if (error || !data) return []

  return (data as unknown as Record<string, unknown>[])
    .filter((row) => {
      const lat = Number(row['centroid_lat'])
      const lng = Number(row['centroid_lng'])
      return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
    })
    .map((row): BuyerDemandLayerPoint => {
      const geoKey = String(row['geo_key'] ?? '')
      const geoLevel = String(row['geo_level'] ?? '')
      const score = Number(row[scoreField] ?? 0)
      const avgPrice = row['avg_purchase_price'] != null ? Number(row['avg_purchase_price']) : null
      return {
        id: `buyer-demand-${geoLevel}-${geoKey}-${metric}`,
        layer: 'buyer_demand',
        label: geoKey,
        lat: Number(row['centroid_lat']),
        lng: Number(row['centroid_lng']),
        value: metric === 'sold_price' ? (avgPrice ?? 0) : score,
        score,
        metric,
        geo_level: geoLevel,
        geo_key: geoKey,
        metadata: {
          purchase_count: Number(row['purchase_count'] ?? 0),
          buyer_count: Number(row['buyer_count'] ?? 0),
          corporate_buyer_count: Number(row['corporate_buyer_count'] ?? 0),
          avg_purchase_price: avgPrice,
          median_purchase_price: row['median_purchase_price'] != null ? Number(row['median_purchase_price']) : null,
          buyer_heat_score: Number(row['buyer_heat_score'] ?? 0),
          velocity_score: Number(row['velocity_score'] ?? 0),
          liquidity_score: Number(row['liquidity_score'] ?? 0),
          investor_demand_score: Number(row['investor_demand_score'] ?? 0),
        },
      }
    })
}

export const formatShortPrice = (value: number): string => {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`
  return `$${Math.round(value)}`
}
