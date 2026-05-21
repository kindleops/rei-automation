/**
 * Buyer activity rollup handler — called by the Vite buyer activity API plugin.
 * Reads from recently_sold_properties and rolls up into buyer_activity_geo_rollups.
 * NOT included in tsc compilation — runs only in Vite dev server context.
 */

export interface BuyerRollupPayload {
  timeframe_days: number
  geo_levels: Array<'zip' | 'county' | 'market'>
  apply: boolean
}

export interface BuyerRollupResult {
  scanned_rows: number
  rollups_generated: number
  rollups_upserted: number
  examples: Array<{ geo_level: string; geo_key: string; purchase_count: number; buyer_heat_score: number }>
  errors: string[]
}

export const validateBuyerRollupPayload = (body: unknown): BuyerRollupPayload | null => {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b['timeframe_days'] !== 'number' || b['timeframe_days'] < 1) return null
  if (!Array.isArray(b['geo_levels']) || b['geo_levels'].length === 0) return null
  return {
    timeframe_days: b['timeframe_days'] as number,
    geo_levels: b['geo_levels'] as Array<'zip' | 'county' | 'market'>,
    apply: b['apply'] === true,
  }
}
