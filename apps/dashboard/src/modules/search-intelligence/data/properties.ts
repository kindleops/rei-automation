/**
 * The portfolio: one row per web property. Adding a brand (SignPro, Biluxr…)
 * is a new row here (and later a `search_properties` row) — no schema or
 * component change. Nothing in the UI enumerates these ids.
 *
 * Lifecycle notes state EVIDENCE found in the source repositories on
 * 2026-10-04. They are not targets.
 */
import type { PropertyConnection, ProviderId, SearchProperty } from '../domain/types'

type PropertyMeta = Omit<SearchProperty, 'expectations' | 'facts' | 'reservedFamilies' | 'sources'> & {
  sources: SearchProperty['sources']
}

const CAPTURED = '2026-10-04'

export const PROPERTY_META: readonly PropertyMeta[] = [
  {
    id: 'prominent',
    brand: 'Prominent Cash Offer',
    domain: 'prominentcashoffer.com',
    origin: 'https://www.prominentcashoffer.com',
    strategy: 'seller-acquisition-nationwide',
    thesis: 'Nationwide direct-sale seller acquisition: national → state → county → city → seller situation.',
    lifecycle: 'BUILDING',
    lifecycleNote: 'The rebuilt site is on branch feat/offer-sequence-cinematic. Its sitemap is empty on staging, and the production cutover checklist is still open. 26 of 217 routes pass the indexability gate, and those still wait for human approval.',
    launchedAt: null,
    accent: 'exec',
    hierarchy: [
      { family: 'market-national', label: 'Nationwide' },
      { family: 'market-state', label: 'State' },
      { family: 'market-county', label: 'County' },
      { family: 'market-city', label: 'City' },
      { family: 'market-situation', label: 'Situation' },
      { family: 'help', label: 'Seller question' },
    ],
    excludedHosts: [],
    sources: [
      { kind: 'repo-registry', label: 'Prominent site repository', repo: '/Users/ryankindle/v0-v0realestatelandingsitemain', branch: 'feat/offer-sequence-cinematic', commit: '7e3e17a9c665', capturedAt: CAPTURED },
    ],
    order: 1,
  },
  {
    id: 'offerr',
    brand: 'Offerr',
    domain: 'offerr.ai',
    origin: 'https://offerr.ai',
    strategy: 'ai-offer-product',
    thesis: 'AI home offers, property intelligence and seller conversion — a product, not a “we buy houses” site.',
    lifecycle: 'BUILDING',
    lifecycleNote: 'The product app has two routes (/ and /offerr/start) on feat/offerr-production-canary-readiness. No SEO registry, sitemap or robots file exists, so the search strategy is not decided yet.',
    launchedAt: null,
    accent: 'flow',
    hierarchy: [
      { family: 'home', label: 'Home' },
      { family: 'product', label: 'Product flow' },
    ],
    excludedHosts: [],
    sources: [
      { kind: 'repo-registry', label: 'Offerr app repository (routes only)', repo: '/Users/ryankindle/offerr-ai-ui-ux', branch: 'feat/offerr-production-canary-readiness', commit: 'd3a28a0', capturedAt: CAPTURED },
    ],
    order: 2,
  },
  {
    id: 'reivesti',
    brand: 'Reivesti',
    domain: 'reivesti.com',
    origin: 'https://reivesti.com',
    strategy: 'investment-platform',
    thesis: 'The intelligence and marketplace layer for investment real estate: markets, roles, products, and preserved legacy authority.',
    lifecycle: 'BUILDING',
    lifecycleNote: 'The new public SEO layer is governed on reivesti main (lib/seo/registry.ts). reivesti.com is still served by the legacy Carrot site: www is a CNAME to carrot.com (docs/seo/CUTOVER.md), and the pre-cutover checklist is open.',
    launchedAt: null,
    accent: 'cobalt',
    hierarchy: [
      { family: 'site-anchor', label: 'Site' },
      { family: 'national', label: 'National category' },
      { family: 'state', label: 'State' },
      { family: 'metro', label: 'Metro' },
      { family: 'wholesale-metro', label: 'Wholesale city' },
      { family: 'audience-hub', label: 'Audience hub' },
      { family: 'role', label: 'Role' },
    ],
    excludedHosts: [],
    sources: [
      { kind: 'repo-registry', label: 'Reivesti repository (main)', repo: '/Users/ryankindle/reivesti-converge', branch: 'main', commit: '96761df98493', capturedAt: CAPTURED },
    ],
    order: 3,
  },
  {
    id: 'leadcommand',
    brand: 'LeadCommand',
    domain: 'leadcommand.ai',
    origin: 'https://leadcommand.ai',
    strategy: 'saas-marketing',
    thesis: 'The public marketing site for LeadCommand. The operator app is not part of this property.',
    lifecycle: 'PLANNED',
    lifecycleNote: 'No marketing-site repository, sitemap or SEO plan was found on this machine. ops.leadcommand.ai is the operator application and is excluded.',
    launchedAt: null,
    accent: 'neutral',
    hierarchy: [{ family: 'home', label: 'Home' }],
    excludedHosts: ['ops.leadcommand.ai'],
    sources: [],
    order: 4,
  },
]

/**
 * Connection states. Every connector is NOT_CONFIGURED: no credentials
 * exist and none were created. Notes record what exists outside the app.
 */
const NONE = (propertyId: string, provider: ProviderId, note: string | null = null, state: PropertyConnection['state'] = 'NOT_CONFIGURED'): PropertyConnection => ({
  propertyId, provider, state, vendor: null, lastSyncAt: null, dataThrough: null, note,
})

export const CONNECTIONS: readonly PropertyConnection[] = [
  NONE('prominent', 'SEARCH_CONSOLE', 'No connector configured. The new site has not cut over.'),
  NONE('prominent', 'GA4'),
  NONE('prominent', 'FIRST_PARTY', 'Event schema designed in Search Intelligence. Nothing is deployed.'),
  NONE('prominent', 'CLOUDFLARE'),
  NONE('prominent', 'EXTERNAL_RESEARCH', 'Optional. The keyword universe source marks volume as not validated.'),
  NONE('prominent', 'LEADCOMMAND', 'The bridge contract is defined. It is not wired.'),

  NONE('offerr', 'SEARCH_CONSOLE'),
  NONE('offerr', 'GA4'),
  NONE('offerr', 'FIRST_PARTY', 'The Offerr funnel events (address → analysis → offer) are designed. Nothing is deployed.'),
  NONE('offerr', 'CLOUDFLARE'),
  NONE('offerr', 'EXTERNAL_RESEARCH'),
  NONE('offerr', 'LEADCOMMAND', 'The bridge contract is defined. It is not wired.'),

  NONE('reivesti', 'SEARCH_CONSOLE', 'A legacy Search Console property exists, and its exports were ingested once by the Reivesti SEO lane. No connector exists here.'),
  NONE('reivesti', 'GA4', 'A legacy GA4 property is referenced in docs/seo/CUTOVER.md. It is not connected.'),
  NONE('reivesti', 'FIRST_PARTY'),
  NONE('reivesti', 'CLOUDFLARE'),
  NONE('reivesti', 'EXTERNAL_RESEARCH', 'The Keyword Planner exports are listed as missing inputs in the Reivesti roadmap.'),
  NONE('reivesti', 'LEADCOMMAND', 'This is an investment platform, not seller acquisition.', 'NOT_APPLICABLE'),

  NONE('leadcommand', 'SEARCH_CONSOLE'),
  NONE('leadcommand', 'GA4'),
  NONE('leadcommand', 'FIRST_PARTY'),
  NONE('leadcommand', 'CLOUDFLARE'),
  NONE('leadcommand', 'EXTERNAL_RESEARCH'),
  NONE('leadcommand', 'LEADCOMMAND', 'This is the marketing site of LeadCommand itself.', 'NOT_APPLICABLE'),
]
