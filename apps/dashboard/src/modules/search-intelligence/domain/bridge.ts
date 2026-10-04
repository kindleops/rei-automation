/**
 * Future LeadCommand bridge (§30) — an interface, not a wire.
 *
 * Search Intelligence owns search + website acquisition (query → page →
 * session). LeadCommand owns seller operations and the deal outcome
 * (lead → conversation → offer → contract → close). The bridge passes an
 * opaque attribution token across the boundary; it never copies a seller
 * record into Search Intelligence, and Search Intelligence never reads
 * LeadCommand tables. Nothing implements this interface yet.
 */

export const JOURNEY = [
  { step: 'query', owner: 'search-intelligence', label: 'Query' },
  { step: 'site', owner: 'search-intelligence', label: 'Seller site' },
  { step: 'page', owner: 'search-intelligence', label: 'Landing page' },
  { step: 'session', owner: 'search-intelligence', label: 'Session' },
  { step: 'lead', owner: 'leadcommand', label: 'Lead' },
  { step: 'conversation', owner: 'leadcommand', label: 'LC conversation' },
  { step: 'offer', owner: 'leadcommand', label: 'Offer' },
  { step: 'contract', owner: 'leadcommand', label: 'Contract' },
  { step: 'close', owner: 'leadcommand', label: 'Close' },
] as const
export type JourneyStep = (typeof JOURNEY)[number]['step']

/** The only thing that crosses: an opaque token minted server-side at form_submit. */
export interface AttributionToken {
  token: string
  property_id: string
  landing_path: string
  first_touch_at: string
}

/** Aggregates LeadCommand would return — counts by attribution dimension, never people. */
export interface OutcomeAggregate {
  property_id: string
  landing_path: string | null
  query_cluster_id: string | null
  geography_id: string | null
  window: { start: string; end: string }
  leads: number
  conversations: number
  offers: number
  contracts: number
  closes: number
  /** revenue only when LeadCommand records realised (closed) revenue; never modeled */
  realized_revenue: number | null
}

export interface LeadCommandBridge {
  /** read-only; implemented server-side in apps/api when approved */
  outcomes(params: { propertyId: string; start: string; end: string; groupBy: 'landing_path' | 'query_cluster_id' | 'geography_id' }): Promise<OutcomeAggregate[]>
}

/** V1 has no bridge. Callers must treat null as "not linked" — never as zero outcomes. */
export const LEADCOMMAND_BRIDGE: LeadCommandBridge | null = null
