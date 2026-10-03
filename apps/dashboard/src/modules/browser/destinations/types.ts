/** Types for the research-destination registry. See index.ts for the contract. */

export type DestinationType =
  | 'WEB_SEARCH'
  | 'ASSESSOR'
  | 'TAX'
  | 'RECORDER'
  | 'GIS'
  | 'PERMITS'
  | 'CODE'
  | 'ZILLOW'
  | 'REDFIN'
  | 'REALTOR'
  | 'GOOGLE_MAPS'
  | 'STREET_VIEW'
  | 'COUNTY_PROPERTY_SEARCH'
  | 'STATE_CORPORATE'

/**
 * Embed capability, PROVEN by the embedding audit (headers + headless iframe test).
 *  EMBEDS        — framing allowed and the page rendered inside a sandboxed iframe.
 *  BLOCKED       — X-Frame-Options / CSP frame-ancestors refuse framing.
 *  AUTH          — site demands its own sign-in / bot challenge before content.
 *  EXTERNAL_ONLY — policy decision: never frame (commercial, popups, fragile) even if headers allow.
 *  UNKNOWN       — not audited; the Browser must treat this as external (open externally by default).
 */
export type EmbedMode = 'EMBEDS' | 'BLOCKED' | 'AUTH' | 'EXTERNAL_ONLY' | 'UNKNOWN'

export type AuthorityClass = 'Official' | 'Commercial' | 'Search' | 'Internal'

/**
 * VERIFIED    — URL pattern fetched and confirmed on last_verified_at.
 * GENERIC     — fallback (search page / web search) — context must be copied by the operator.
 * UNAVAILABLE — known to exist but not reachable (down / blocked to automated checks); disabled.
 */
export type Confidence = 'VERIFIED' | 'GENERIC' | 'UNAVAILABLE'

export type JurisdictionScope =
  | { level: 'national' }
  | { level: 'state'; state: string }
  | { level: 'county'; state: string; county: string }
  | { level: 'city'; state: string; county: string; city: string }

/** Canonical property fields a builder may require. */
export type DestinationField =
  | 'address'
  | 'street'
  | 'city'
  | 'state'
  | 'zip'
  | 'county'
  | 'apn'
  | 'lat_lng'
  | 'owner_name'
  | 'company_name'

/** Minimal sandbox flags proven sufficient for an embeddable site (iframe sandbox attr tokens). */
export type SandboxFlag =
  | 'allow-scripts'
  | 'allow-same-origin'
  | 'allow-forms'
  | 'allow-popups'
  | 'allow-popups-to-escape-sandbox'

/**
 * Declarative URL builder. Every variant is verified against the live site before it is
 * added (see HOW-TO-ADD-A-COUNTY.md). Placeholders are filled with encoded, validated values.
 */
export type UrlSpec =
  /** A fixed page (search page / info page). Context is offered for copy. */
  | { kind: 'static'; href: string }
  /** Parcel deep link. `{apn}` is replaced by the normalized APN, which must match `pattern`. */
  | {
      kind: 'apn'
      template: string
      normalize: 'digits' | 'alnum_upper'
      pattern: string
      /** The official search page used as the fallback when the APN is missing/invalid. */
      search_href: string
    }
  /** Company-name deep link. `{name}` is replaced by encodeURIComponent(name). */
  | { kind: 'company'; template: string }
  /** ZIP-level market page. `{zip}` is replaced by the 5-digit ZIP. */
  | { kind: 'zip'; template: string }
  | { kind: 'zillow_address' }
  | { kind: 'maps_query' }
  | { kind: 'street_view' }
  | { kind: 'web_search'; subject: 'property' | 'company' | 'county_site' }

export interface DestinationRecord {
  id: string
  destination_type: DestinationType
  scope: JurisdictionScope
  display_name: string
  /** Host(s) the builder emits — every built URL MUST be on one of these. */
  hosts: readonly string[]
  url: UrlSpec
  required_fields: readonly DestinationField[]
  embed: EmbedMode
  /** Minimal sandbox tokens, only meaningful when embed === 'EMBEDS'. */
  sandbox?: readonly SandboxFlag[]
  authority: AuthorityClass
  confidence: Confidence
  enabled: boolean
  /**
   * 'deep'   — the URL carries the property context (verified parameter).
   * 'search' — opens the official search page; context is offered for copy.
   */
  link_kind: 'deep' | 'search'
  /** Human copy for the context-to-copy chip when link_kind === 'search'. */
  copy_hint?: DestinationField
  notes?: string
  /**
   * How the URL was verified: 'content' = fetched and the property/parcel rendered;
   * 'status' = page fetched 200; 'challenge' = official host answered with a bot challenge
   * (Cloudflare etc.) to automated clients, so only reachability is proven.
   */
  verified_by: 'content' | 'status' | 'challenge' | 'documented'
  last_verified_at: string // ISO date (YYYY-MM-DD)
}

/** Canonical property shape (subset of `properties` columns the registry reads). */
export interface ResearchProperty {
  property_id?: string | null
  property_address_full?: string | null
  /** Canonical street line (properties.property_address). */
  property_address?: string | null
  /** @deprecated alias accepted for early adopters — prefer `property_address` (the canonical column). */
  property_address_street?: string | null
  property_address_city?: string | null
  property_address_state?: string | null
  property_address_zip?: string | null
  property_address_county_name?: string | null
  /** Parcel / APN as stored canonically (properties.apn_parcel_id, county-formatted). */
  apn_parcel_id?: string | null
  latitude?: number | string | null
  longitude?: number | string | null
  market?: string | null
}

export interface ResearchCompany {
  name: string
  state?: string | null
}

export type ResearchObject =
  | { type: 'property'; property: ResearchProperty }
  | { type: 'company'; company: ResearchCompany }
  | { type: 'none' }

export interface Jurisdiction {
  state: string | null // USPS 2-letter
  county: string | null // normalized, e.g. "Hennepin"
  /** registry key "MN:Hennepin" when the county is covered, else null. */
  key: string | null
  covered: boolean
  /** How the county was determined. */
  source: 'county_field' | 'city_lookup' | 'none'
}

export interface BuildContext {
  property?: ResearchProperty
  company?: ResearchCompany
}

export type BuildFailureReason =
  | 'parcel_id_required'
  | 'parcel_id_invalid'
  | 'address_required'
  | 'coordinates_required'
  | 'company_name_required'
  | 'wrong_jurisdiction'
  | 'destination_disabled'
  | 'unsafe_url'

export type BuildResult =
  | {
      ok: true
      url: string
      /** Present for link_kind 'search': text the operator should paste. */
      copy?: { label: string; value: string }
    }
  | {
      ok: false
      reason: BuildFailureReason
      message: string
      /** The jurisdiction's own search page (never a guessed deep link), when one exists. */
      fallback?: { url: string; label: string }
    }

export interface AvailableDestination {
  record: DestinationRecord
  /** Pre-built result for convenience; failures stay listed (e.g. "Parcel ID required"). */
  build: BuildResult
  group: 'official' | 'market' | 'search'
}

export interface UrlClassification {
  ok: boolean
  url?: string
  host?: string
  insecure?: boolean
  embed: EmbedMode
  sandbox?: readonly SandboxFlag[]
  /** Matching registry record id, if the host belongs to a known destination. */
  destination_id?: string
  reason?: 'invalid_url' | 'unsafe_scheme' | 'credentials_in_url'
}

export type SearchProvider = 'google' | 'bing' | 'duckduckgo'

export type TypedInputResolution =
  | { kind: 'url'; url: string; host: string; insecure: boolean }
  | { kind: 'search'; url: string; query: string }
  | { kind: 'invalid'; reason: 'unsafe_scheme' | 'credentials_in_url' | 'invalid_url' | 'empty' }

export type SanitizeResult =
  | { ok: true; url: string; host: string; insecure: boolean }
  | { ok: false; reason: 'invalid_url' | 'unsafe_scheme' | 'credentials_in_url' }
