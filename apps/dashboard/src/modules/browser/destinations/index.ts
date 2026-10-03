/**
 * LeadCommand Browser 1.0 — research-destination registry (PUBLIC CONTRACT).
 *
 * The Browser app consumes ONLY this file. Everything here is pure data + pure
 * functions: no network, no storage, no React. Owned by the destinations agent.
 *
 *   resolveJurisdiction(property)   → which state/county registry applies
 *   destinationsFor(object)         → available destination records (+ confidence, embed mode)
 *   buildDestinationUrl(dest, ctx)  → {ok,url} | {ok:false,reason}
 *   classifyUrl(url)                → embed mode for any typed/foreign URL (domain allowlist)
 *   searchUrl(query, provider)      → web-search URL (privacy-safe query only)
 *   sanitizeUrl(raw)                → http/https only; javascript:/data:/file: rejected
 *   propertySearchQuery(property)   → "street, city, ST" — never phone/notes/scores/owner
 *   resolveTypedInput(text)         → address-bar text → {kind:'url'|'search'|'invalid'}
 *   frameSrcOrigins()               → exact https origins PROVEN embeddable (for an explicit frame-src)
 *
 * Embed modes: anything other than 'EMBEDS' (incl. UNKNOWN) must render the external-required
 * card. `sandbox` on an EMBEDS record/classification is the audited token set to use.
 */

export type {
  DestinationType,
  EmbedMode,
  AuthorityClass,
  Confidence,
  JurisdictionScope,
  DestinationRecord,
  DestinationField,
  ResearchProperty,
  ResearchCompany,
  ResearchObject,
  Jurisdiction,
  BuildContext,
  BuildResult,
  BuildFailureReason,
  AvailableDestination,
  UrlClassification,
  SearchProvider,
  SanitizeResult,
  SandboxFlag,
  UrlSpec,
  TypedInputResolution,
} from './types'

export { resolveJurisdiction, normalizeCountyName, normalizeState } from './jurisdiction'
export { destinationsFor, getDestination, allDestinations, REGISTRY_VERSION } from './registry'
export type { DestinationsForOptions } from './registry'
export { COVERED_COUNTIES } from './registry-data'
export { buildDestinationUrl } from './build'
export { classifyUrl, EMBED_ALLOWLIST, frameSrcOrigins } from './classify'
export { searchUrl, propertySearchQuery, companySearchQuery, streetLine, resolveTypedInput, SEARCH_PROVIDERS, DEFAULT_SEARCH_PROVIDER } from './search'
export { sanitizeUrl, displayHost } from './sanitize'
