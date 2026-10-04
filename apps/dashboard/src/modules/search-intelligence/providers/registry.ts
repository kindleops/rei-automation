/**
 * Provider abstraction (§16, §18–20, §32, §34).
 *
 * The browser knows WHAT a provider is and WHETHER it is connected — never
 * how to authenticate to it. Every connector runs server-side (apps/api,
 * src/lib/domain/search-intelligence/), reads its credential through the
 * server-only secret store, and is read-only by scope. No credential, key
 * file or token is referenced in this bundle, and none is stored in a DB row:
 * a connection row holds a secret-store REFERENCE name only.
 */
import type { ConnectionState, ProviderId } from '../domain/types'

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  /** what this provider is the truth for */
  role: string
  /** the facts it will contribute */
  grain: readonly string[]
  refresh: string
  /** the read-only scope requested, as the provider names it */
  scope: string
  /** where its credential lives */
  credential: string
  /** optional providers never block a surface */
  optional: boolean
  vendors?: readonly string[]
}

export const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
  SEARCH_CONSOLE: {
    id: 'SEARCH_CONSOLE', label: 'Google Search Console', role: 'Search acquisition — what Google shows and what searchers click',
    grain: ['query', 'page', 'date', 'device', 'country', 'clicks', 'impressions', 'CTR', 'average position', 'index status'],
    refresh: 'Historical backfill (up to 16 months), then a daily incremental pull. The provider reports with a 2–3 day lag; a day with no row is “not yet reported”, never zero.',
    scope: 'webmasters.readonly', credential: 'Server-only secret store (service-account or OAuth refresh token). Never in the browser and never in a DB row.', optional: false,
  },
  GA4: {
    id: 'GA4', label: 'Google Analytics 4', role: 'On-site sessions and acquisition, if a GA4 property exists',
    grain: ['landing page', 'source / medium', 'region / city', 'sessions', 'users', 'conversions', 'realtime active users'],
    refresh: 'A daily report pull, plus an on-demand realtime read while a surface is open.', scope: 'analytics.readonly',
    credential: 'Server-only secret store. GA4 is not assumed to exist.', optional: true,
  },
  FIRST_PARTY: {
    id: 'FIRST_PARTY', label: 'First-party telemetry', role: 'On-site behaviour — page views, forms, address entry, valuation, offers shown',
    grain: ['the 13 designed events (see Connections → Telemetry)'], refresh: 'Event stream into Search Intelligence-owned tables (designed; not deployed).',
    scope: 'Write-only collector on the site; this workspace only reads aggregates.', credential: 'No third-party credential. The collector is authenticated by site origin and a server-side signing key.', optional: true,
  },
  CLOUDFLARE: {
    id: 'CLOUDFLARE', label: 'Cloudflare Web Analytics', role: 'Privacy-first traffic counts at the edge, independent of Google',
    grain: ['path', 'country', 'referrer', 'visits', 'page views'], refresh: 'A daily GraphQL Analytics pull.', scope: 'Account Analytics: Read',
    credential: 'Server-only secret store (a scoped API token).', optional: true,
  },
  EXTERNAL_RESEARCH: {
    id: 'EXTERNAL_RESEARCH', label: 'External research', role: 'Market-size context — volume, difficulty, SERP competitors, backlinks',
    grain: ['search volume', 'keyword difficulty', 'SERP competitors', 'related keywords', 'backlinks', 'competitor visibility'],
    refresh: 'On demand, per keyword set, with each result cached and dated.', scope: 'Read-only API plan', credential: 'Server-only secret store.', optional: true,
    vendors: ['DataForSEO', 'Semrush', 'Ahrefs'],
  },
  LEADCOMMAND: {
    id: 'LEADCOMMAND', label: 'LeadCommand bridge', role: 'Lead, conversation, offer, contract and close outcomes for attributed sessions',
    grain: ['aggregates by landing page, query cluster and geography (counts only)'], refresh: 'A daily aggregate read through the bridge contract.',
    scope: 'Internal read-only aggregate. No seller records cross the boundary.', credential: 'Internal service boundary. There is no external credential.', optional: true,
  },
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  NOT_CONFIGURED: 'Not connected',
  AWAITING_SITE: 'Awaiting site launch',
  AWAITING_ACCESS: 'Awaiting access',
  VERIFYING: 'Verifying',
  CONNECTED: 'Connected',
  SYNCING: 'Syncing',
  DEGRADED: 'Degraded',
  ERROR: 'Error',
  PAUSED: 'Paused',
  NOT_APPLICABLE: 'Not applicable',
}

export const CONNECTION_TONE: Record<ConnectionState, 'neutral' | 'attn' | 'ok' | 'exec' | 'crit'> = {
  NOT_CONFIGURED: 'neutral', AWAITING_SITE: 'neutral', AWAITING_ACCESS: 'attn', VERIFYING: 'exec', CONNECTED: 'ok', SYNCING: 'exec',
  DEGRADED: 'attn', ERROR: 'crit', PAUSED: 'neutral', NOT_APPLICABLE: 'neutral',
}

/* ── connector contracts (implemented server-side; types only here) ─────── */

export interface SearchAnalyticsRow {
  date: string
  query: string | null
  page: string | null
  device: 'DESKTOP' | 'MOBILE' | 'TABLET' | null
  country: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface SearchConsoleConnector {
  /** properties the credential can read, e.g. sc-domain:reivesti.com */
  listProperties(): Promise<string[]>
  searchAnalytics(params: { property: string; start: string; end: string; dimensions: ReadonlyArray<'date' | 'query' | 'page' | 'device' | 'country'>; startRow?: number; rowLimit?: number }): Promise<{ rows: SearchAnalyticsRow[]; dataThrough: string | null }>
}

export interface AnalyticsConnector {
  report(params: { property: string; start: string; end: string; dimensions: readonly string[]; metrics: readonly string[] }): Promise<{ rows: Array<Record<string, string | number>> }>
  realtime?(params: { property: string }): Promise<{ activeUsers: number; byCity: Array<{ city: string; region: string; activeUsers: number }> }>
}

export interface ResearchConnector {
  vendor: string
  keywordMetrics(params: { keywords: readonly string[]; location: string; language: string }): Promise<Array<{ keyword: string; volume: number | null; difficulty: number | null; fetchedAt: string }>>
}
