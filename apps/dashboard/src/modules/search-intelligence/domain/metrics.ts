/**
 * The no-fake-metric contract.
 *
 * Every measure the workspace can show is a `Metric`: either a VALUE reported
 * by a connected provider (with its provider and data-through date) or
 * UNAVAILABLE with a reason the UI renders in words. There is no code path
 * that turns "unavailable" into 0, and `formatMetric` refuses to print a
 * number for an unavailable metric. Tests assert both.
 */
import type { PageMeasures, PropertyConnection, PropertyLifecycle, ProviderId, SearchProperty } from './types'
import { LIFECYCLE } from './types'

export type UnavailableReason =
  | 'SEARCH_CONSOLE_NOT_CONNECTED'
  | 'ANALYTICS_NOT_CONNECTED'
  | 'TELEMETRY_NOT_DEPLOYED'
  | 'AWAITING_LAUNCH'
  | 'BASELINE_PENDING'
  | 'NO_RANKING_HISTORY'
  | 'RESEARCH_NOT_CONNECTED'
  | 'BRIDGE_NOT_CONNECTED'
  | 'NOT_REPORTED'

export type Metric<T = number> =
  | { state: 'VALUE'; value: T; provider: ProviderId; through: string }
  | { state: 'UNAVAILABLE'; reason: UnavailableReason; provider: ProviderId | null }

/** The exact words for every empty state (owner-approved vocabulary from the brief). */
export const UNAVAILABLE_COPY: Record<UnavailableReason, { title: string; body: string }> = {
  SEARCH_CONSOLE_NOT_CONNECTED: { title: 'Search Console not connected', body: 'Impressions, clicks, CTR and position appear once read-only Search Console access exists for this property.' },
  ANALYTICS_NOT_CONNECTED: { title: 'Analytics not connected', body: 'Sessions, landing pages and acquisition appear once an analytics provider is connected.' },
  TELEMETRY_NOT_DEPLOYED: { title: 'First-party telemetry not deployed', body: 'The event schema is designed; no tracking is running on this site.' },
  AWAITING_LAUNCH: { title: 'Awaiting site launch', body: 'This property has not launched. Planning data is shown; nothing here is traffic.' },
  BASELINE_PENDING: { title: 'Baseline collection begins after launch', body: 'Movement needs a baseline window of reported data first.' },
  NO_RANKING_HISTORY: { title: 'No ranking history yet', body: 'Position change needs at least two reported windows.' },
  RESEARCH_NOT_CONNECTED: { title: 'No research provider connected', body: 'Volume and difficulty come from an external research provider. None is connected; none is required.' },
  BRIDGE_NOT_CONNECTED: { title: 'LeadCommand outcomes not linked', body: 'Lead, conversation, offer and deal outcomes attach through the LeadCommand bridge once it exists.' },
  NOT_REPORTED: { title: 'Not reported', body: 'The connected provider reported no row for this object in the window.' },
}

export const unavailable = (reason: UnavailableReason, provider: ProviderId | null = null): Metric<never> => ({ state: 'UNAVAILABLE', reason, provider })

export const isValue = <T,>(m: Metric<T>): m is Extract<Metric<T>, { state: 'VALUE' }> => m.state === 'VALUE'

const lifecycleIndex = (l: PropertyLifecycle) => LIFECYCLE.indexOf(l)
export const isLaunched = (p: Pick<SearchProperty, 'lifecycle'>) => lifecycleIndex(p.lifecycle) >= lifecycleIndex('LIVE')

/** The connection record for a provider, or null. */
export function connectionOf(connections: readonly PropertyConnection[], propertyId: string, provider: ProviderId): PropertyConnection | null {
  return connections.find((c) => c.propertyId === propertyId && c.provider === provider) ?? null
}
const isConnected = (c: PropertyConnection | null) => c?.state === 'CONNECTED' || c?.state === 'SYNCING' || c?.state === 'DEGRADED'

/**
 * Why a Search Console measure is (un)available for a property, in priority
 * order: launch first (a site that is not live has no search footprint to
 * measure, whatever is connected), then the connector, then the baseline.
 */
export function searchMeasureGate(property: SearchProperty, connections: readonly PropertyConnection[]): UnavailableReason | null {
  if (!isLaunched(property)) return 'AWAITING_LAUNCH'
  if (!isConnected(connectionOf(connections, property.id, 'SEARCH_CONSOLE'))) return 'SEARCH_CONSOLE_NOT_CONNECTED'
  if (lifecycleIndex(property.lifecycle) < lifecycleIndex('BASELINE_COLLECTION')) return 'BASELINE_PENDING'
  return null
}

export function analyticsMeasureGate(property: SearchProperty, connections: readonly PropertyConnection[]): UnavailableReason | null {
  if (!isLaunched(property)) return 'AWAITING_LAUNCH'
  const any = (['GA4', 'FIRST_PARTY', 'CLOUDFLARE'] as const).some((p) => isConnected(connectionOf(connections, property.id, p)))
  return any ? null : 'ANALYTICS_NOT_CONNECTED'
}

/**
 * A page's search measure. Reported facts win; absent facts are UNAVAILABLE
 * with the gate's reason, or NOT_REPORTED when the gate is open but the
 * provider has no row. Never 0 by default.
 */
export function pageSearchMetric(
  key: 'impressions' | 'clicks' | 'position',
  facts: PageMeasures | undefined,
  gate: UnavailableReason | null,
): Metric<number> {
  if (facts && facts.provider === 'SEARCH_CONSOLE') {
    const v = facts[key]
    if (typeof v === 'number' && Number.isFinite(v)) return { state: 'VALUE', value: v, provider: 'SEARCH_CONSOLE', through: facts.through }
  }
  return unavailable(gate ?? 'NOT_REPORTED', 'SEARCH_CONSOLE')
}

/** CTR is derived only from two reported values over the same window. */
export function ctrOf(clicks: Metric<number>, impressions: Metric<number>): Metric<number> {
  if (isValue(clicks) && isValue(impressions) && impressions.value > 0 && clicks.through === impressions.through) {
    return { state: 'VALUE', value: clicks.value / impressions.value, provider: clicks.provider, through: clicks.through }
  }
  if (!isValue(impressions)) return impressions as Metric<number>
  if (!isValue(clicks)) return clicks as Metric<number>
  return unavailable('NOT_REPORTED', clicks.provider)
}

/** Format a metric for display; an unavailable metric yields its words, never a digit. */
export function formatMetric(m: Metric<number>, unit: 'count' | 'rate' | 'position' = 'count'): string {
  if (m.state === 'UNAVAILABLE') return UNAVAILABLE_COPY[m.reason].title
  if (unit === 'rate') return `${(m.value * 100).toFixed(1)}%`
  if (unit === 'position') return m.value.toFixed(1)
  return Math.round(m.value).toLocaleString('en-US')
}
