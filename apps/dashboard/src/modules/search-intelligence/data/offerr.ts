/**
 * Offerr — what exists, and nothing more.
 *
 * Two built routes from the Offerr app repository, and the intent families
 * the owner named for Offerr in the Search Intelligence brief (§14). No
 * keyword research exists for any family, so each has no primary keyword and
 * no owner page: the Keyword Universe shows them as families awaiting
 * research, and the Opportunities engine reports each as a cluster with no
 * destination page. The final strategy is deliberately not assumed.
 */
import type { KeywordCluster, Provenance, SearchPage } from '../domain/types'

const APP: Provenance = { kind: 'repo-registry', label: 'Offerr app routes', repo: '/Users/ryankindle/offerr-ai-ui-ux', branch: 'feat/offerr-production-canary-readiness', commit: 'd3a28a0', path: 'app/', capturedAt: '2026-10-04' }
const BRIEF: Provenance = { kind: 'operator', label: 'Owner brief — Search Intelligence OS V1 §14 (Offerr intent families)', path: '/Users/ryankindle/.claude/jobs/c39b0175/tmp/briefs/search-intelligence-os-v1.md', capturedAt: '2026-10-04' }

const page = (id: string, path: string, family: string, parentId: string | null, title: string | null): SearchPage => ({
  id, propertyId: 'offerr', path, family, parentId, geographyIds: [], intent: null, primaryClusterId: null, secondaryClusterIds: [],
  secondaryKeywords: [], primaryKeyword: null,
  copy: { title, h1: null, meta: null, state: title ? 'SOURCE_UNAPPROVED' : 'NOT_WRITTEN', source: APP },
  canonical: null, schemaTypes: [], indexability: 'UNDECIDED', robots: null, inSitemap: null, launchWaveId: null, status: 'BUILDING',
  stage: { planned: true, builtRoute: true, published: false, indexed: null }, thesis: null,
  notes: 'This is a product app route. There is no SEO registry, sitemap or robots file in the repository.', aliases: [], source: APP,
})

export const OFFERR_PAGES: readonly SearchPage[] = [
  page('offerr:home', '/', 'home', null, 'Offerr.ai - Instant AI Cash Offers for Real Estate'),
  page('offerr:start', '/offerr/start', 'product', 'offerr:home', null),
]

const family = (id: string, label: string, parentTopic: string, geoLevel: KeywordCluster['geoLevel'] = null): KeywordCluster => ({
  id: `offerr:c:${id}`, propertyId: 'offerr', label, primaryKeyword: null, parentTopic, intent: null, geoLevel,
  ownerPageId: null, ownerRef: null, priority: null, wave: null, source: 'OPERATOR', provenance: BRIEF,
  notes: 'The owner named this intent family. No keyword research exists for it, and no strategy has been chosen.',
})

export const OFFERR_CLUSTERS: readonly KeywordCluster[] = [
  family('ai-home-offers', 'AI home offers', 'Offers'),
  family('instant-offers', 'Instant offers', 'Offers'),
  family('online-selling', 'Online selling', 'Selling'),
  family('home-value', 'Home-value queries', 'Valuation'),
  family('valuation', 'Valuation', 'Valuation'),
  family('offer-calculators', 'Offer calculators', 'Tools'),
  family('address-analysis', 'Address / property analysis', 'Tools'),
  family('seller-decision', 'Seller decision queries', 'Selling'),
  family('geographic-variants', 'Geographic versions of these families', 'Geography', 'CITY'),
]
