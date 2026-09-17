import type { MarketPerformance, StatePerformance } from '../../../lib/data/kpiDashboardData'

/**
 * THE METRIC VOCABULARY for the geographic drill-down.
 *
 * Every mode here is a field the war-room endpoint actually returns for BOTH the
 * state leaderboard and the market leaderboard, so a metric selected at the national
 * level survives the drill into a state and then into a market. A mode that only
 * existed at one level would break the drill, which is why buyer demand — present on
 * markets, absent on states, and reported `available: false` by
 * `metric_availability` — is not in this list.
 */

export type GeoMetricId = 'sent' | 'delivered' | 'replied' | 'positive' | 'optOut'

export interface GeoMetric {
  id: GeoMetricId
  label: string
  shortLabel: string
  /** The raw count field. */
  countKey: 'sent' | 'delivered' | 'replied' | 'positive' | 'optOut'
  /** The derived rate field, where the endpoint publishes one. */
  rateKey: 'deliveryRate' | 'replyRate' | 'positiveRate' | 'optOutRate' | null
  rateLabel: string | null
  /** True when a HIGHER value is worse — opt-outs. Drives the colour ramp. */
  inverse: boolean
}

export const GEO_METRICS: GeoMetric[] = [
  { id: 'sent', label: 'Messages sent', shortLabel: 'Sent', countKey: 'sent', rateKey: null, rateLabel: null, inverse: false },
  { id: 'delivered', label: 'Delivered', shortLabel: 'Delivered', countKey: 'delivered', rateKey: 'deliveryRate', rateLabel: 'Delivery rate', inverse: false },
  { id: 'replied', label: 'Replies', shortLabel: 'Replies', countKey: 'replied', rateKey: 'replyRate', rateLabel: 'Reply rate', inverse: false },
  { id: 'positive', label: 'Positive replies', shortLabel: 'Positive', countKey: 'positive', rateKey: 'positiveRate', rateLabel: 'Positive rate', inverse: false },
  { id: 'optOut', label: 'Opt-outs', shortLabel: 'Opt-outs', countKey: 'optOut', rateKey: 'optOutRate', rateLabel: 'Opt-out rate', inverse: true },
]

export const getGeoMetric = (id: GeoMetricId): GeoMetric =>
  GEO_METRICS.find((metric) => metric.id === id) ?? GEO_METRICS[0]

/**
 * A rate needs a denominator worth dividing by.
 *
 * FL currently shows a 100% reply rate on TWO sends. Colouring the national map by
 * that would paint Florida as the strongest market in the country on the strength of
 * one conversation. Below this threshold the surface reports the count and says the
 * rate is not yet meaningful, rather than rendering a number that is arithmetically
 * correct and operationally false.
 */
export const MIN_VOLUME_FOR_RATE = 25

export const hasMeaningfulRate = (row: { sent: number }): boolean =>
  row.sent >= MIN_VOLUME_FOR_RATE

export const metricCount = (
  row: StatePerformance | MarketPerformance,
  metric: GeoMetric,
): number => Number(row[metric.countKey] ?? 0)

export const metricRate = (
  row: StatePerformance | MarketPerformance,
  metric: GeoMetric,
): number | null => {
  if (!metric.rateKey) return null
  if (!hasMeaningfulRate(row)) return null
  const value = Number(row[metric.rateKey])
  return Number.isFinite(value) ? value : null
}

/**
 * 0..1 intensity for the choropleth, scaled against the strongest observed value
 * rather than an absolute ceiling — a national map keyed to a fixed scale renders
 * every state the same colour when the whole business is small.
 */
export const metricIntensity = (
  row: StatePerformance | MarketPerformance | undefined,
  metric: GeoMetric,
  max: number,
): number => {
  if (!row || max <= 0) return 0
  const value = metricCount(row, metric)
  if (value <= 0) return 0
  // sqrt so a single dominant state does not flatten every other one to invisible.
  return Math.min(1, Math.sqrt(value / max))
}
