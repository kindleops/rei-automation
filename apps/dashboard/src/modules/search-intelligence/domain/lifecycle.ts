/**
 * Lifecycle → what each surface is allowed to show.
 *
 * A property in PLANNED…READY_FOR_VERIFICATION renders in PLANNING mode:
 * architecture, keywords, geography and launch waves only. LIVE adds the live
 * modes' frames (still unavailable until connected). CONNECTED onward wakes
 * each live surface individually as its provider reports — the same
 * components, no redesign: they read a Metric and render whichever state it is.
 */
import type { IntelligenceMode, PropertyConnection, PropertyLifecycle, SearchProperty } from './types'
import { LIFECYCLE } from './types'

export const LIFECYCLE_LABEL: Record<PropertyLifecycle, string> = {
  PLANNED: 'Planned',
  BUILDING: 'Building',
  READY_FOR_VERIFICATION: 'Ready for verification',
  LIVE: 'Live',
  CONNECTED: 'Connected',
  BASELINE_COLLECTION: 'Baseline collection',
  ACTIVE_INTELLIGENCE: 'Active intelligence',
}

/** What it takes to move to the next step — evidence, not a button. */
export const LIFECYCLE_EXIT: Record<PropertyLifecycle, string> = {
  PLANNED: 'Architecture registered and a build started',
  BUILDING: 'Every launch-wave page READY and the production cutover checklist passed',
  READY_FOR_VERIFICATION: 'DNS serving the new site and the property verified with the search provider',
  LIVE: 'A read-only Search Console connection reporting its first day',
  CONNECTED: 'A complete baseline window reported',
  BASELINE_COLLECTION: 'Baseline window closed; movement can be measured',
  ACTIVE_INTELLIGENCE: '—',
}

export const lifecycleIndex = (l: PropertyLifecycle) => LIFECYCLE.indexOf(l)

export function intelligenceMode(p: Pick<SearchProperty, 'lifecycle'>): IntelligenceMode {
  return lifecycleIndex(p.lifecycle) >= lifecycleIndex('CONNECTED') ? 'LIVE_INTELLIGENCE' : 'PLANNING'
}

/** Live surfaces a property may frame, each gated on its own provider. */
export type LiveSurface = 'impressions' | 'clicks' | 'sessions' | 'conversions' | 'leads' | 'outcomes'

export const LIVE_SURFACE_PROVIDER: Record<LiveSurface, readonly PropertyConnection['provider'][]> = {
  impressions: ['SEARCH_CONSOLE'],
  clicks: ['SEARCH_CONSOLE'],
  sessions: ['GA4', 'FIRST_PARTY', 'CLOUDFLARE'],
  conversions: ['FIRST_PARTY', 'GA4'],
  leads: ['LEADCOMMAND'],
  outcomes: ['LEADCOMMAND'],
}

export const LIVE_SURFACE_LABEL: Record<LiveSurface, string> = {
  impressions: 'Impressions',
  clicks: 'Organic clicks',
  sessions: 'Recent sessions',
  conversions: 'Conversions',
  leads: 'Leads',
  outcomes: 'Outcomes',
}

/** Is a live surface awake for this property? Requires launch AND one of its providers connected. */
export function surfaceAwake(p: SearchProperty, surface: LiveSurface, connections: readonly PropertyConnection[]): boolean {
  if (lifecycleIndex(p.lifecycle) < lifecycleIndex('LIVE')) return false
  return LIVE_SURFACE_PROVIDER[surface].some((prov) => {
    const c = connections.find((x) => x.propertyId === p.id && x.provider === prov)
    return c?.state === 'CONNECTED' || c?.state === 'SYNCING' || c?.state === 'DEGRADED'
  })
}
