/**
 * First-party telemetry DESIGN (§17). Nothing here is deployed; there is no
 * tracker, no endpoint and no event in any database. This is the contract a
 * future site-side collector must satisfy, and the validator that enforces
 * its privacy rules.
 *
 * Division of truth:
 *   Search Console   → search acquisition (query, page, impressions, clicks)
 *   first-party      → on-site behaviour (these events)
 *   LeadCommand      → lead / conversation / offer / contract / close
 * Outcome events below are RECEIVED from LeadCommand through the bridge; a
 * site never emits them itself.
 */

export const TELEMETRY_EVENTS = [
  'page_view', 'cta_click', 'form_start', 'form_submit', 'address_entered', 'valuation_started', 'valuation_completed',
  'offer_presented', 'lead_created', 'conversation_started', 'offer_created', 'contract_created', 'deal_closed',
] as const
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number]

export type EventOrigin = 'site' | 'leadcommand-bridge'

export const EVENT_SPEC: Record<TelemetryEventName, { origin: EventOrigin; meaning: string; fields: readonly string[] }> = {
  page_view: { origin: 'site', meaning: 'A page rendered for a visitor.', fields: ['path', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign', 'landing'] },
  cta_click: { origin: 'site', meaning: 'A primary call to action was clicked.', fields: ['path', 'cta_id'] },
  form_start: { origin: 'site', meaning: 'The first field of a form received input.', fields: ['path', 'form_id'] },
  form_submit: { origin: 'site', meaning: 'A form was submitted and accepted by the server.', fields: ['path', 'form_id'] },
  address_entered: { origin: 'site', meaning: 'A property address was entered (stored only as a server-side keyed hash plus coarse geography).', fields: ['path', 'address_token', 'state_code', 'county_fips'] },
  valuation_started: { origin: 'site', meaning: 'A property analysis began.', fields: ['path', 'address_token'] },
  valuation_completed: { origin: 'site', meaning: 'A property analysis returned to the visitor.', fields: ['path', 'address_token'] },
  offer_presented: { origin: 'site', meaning: 'An offer range or decision was shown to the visitor.', fields: ['path', 'address_token'] },
  lead_created: { origin: 'leadcommand-bridge', meaning: 'LeadCommand created a lead attributed to this visitor.', fields: ['lead_ref'] },
  conversation_started: { origin: 'leadcommand-bridge', meaning: 'LeadCommand recorded the first two-way conversation.', fields: ['lead_ref'] },
  offer_created: { origin: 'leadcommand-bridge', meaning: 'LeadCommand recorded an offer.', fields: ['lead_ref'] },
  contract_created: { origin: 'leadcommand-bridge', meaning: 'LeadCommand recorded a contract.', fields: ['lead_ref'] },
  deal_closed: { origin: 'leadcommand-bridge', meaning: 'LeadCommand recorded a closing.', fields: ['lead_ref'] },
}

/** Envelope every event carries. IDs are random first-party identifiers — never a person's identity. */
export interface TelemetryEnvelope {
  event: TelemetryEventName
  property_id: string
  /** random, first-party, rotates on consent withdrawal */
  anonymous_id: string
  session_id: string
  occurred_at: string
  props: Record<string, string | number | boolean | null>
}

/** Fields that must never appear in an event, under any name variant. */
export const FORBIDDEN_FIELD = /(^|_)(email|e_mail|phone|tel|mobile|first_?name|last_?name|full_?name|name|street|address_line|address$|raw_address|ssn|dob|birth|ip|ip_address|lat|lng|latitude|longitude|user_agent)($|_)/i

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/

export type TelemetryViolation = { field: string; problem: string }

export function validateEvent(e: TelemetryEnvelope): TelemetryViolation[] {
  const v: TelemetryViolation[] = []
  const spec = EVENT_SPEC[e.event]
  if (!spec) return [{ field: 'event', problem: 'unknown event' }]
  if (!OPAQUE_ID.test(e.anonymous_id)) v.push({ field: 'anonymous_id', problem: 'must be an opaque random id' })
  if (!OPAQUE_ID.test(e.session_id)) v.push({ field: 'session_id', problem: 'must be an opaque random id' })
  for (const [k, val] of Object.entries(e.props)) {
    if (FORBIDDEN_FIELD.test(k)) v.push({ field: k, problem: 'sensitive field is not allowed' })
    else if (!spec.fields.includes(k)) v.push({ field: k, problem: `not part of the ${e.event} contract` })
    if (typeof val === 'string' && /@|\+?\d[\d\s().-]{8,}\d/.test(val) && k !== 'path' && k !== 'utm_campaign') v.push({ field: k, problem: 'value looks like contact data' })
  }
  if (spec.fields.includes('address_token') && typeof e.props.address_token === 'string' && !OPAQUE_ID.test(e.props.address_token)) {
    v.push({ field: 'address_token', problem: 'must be a server-side keyed hash, never the address' })
  }
  return v
}

/** The Offerr attribution path (§14): placeholders for a funnel no site emits yet. */
export const OFFERR_FUNNEL = [
  { step: 'query', source: 'SEARCH_CONSOLE', label: 'Search query' },
  { step: 'landing', source: 'FIRST_PARTY', label: 'Landing page' },
  { step: 'address_entered', source: 'FIRST_PARTY', label: 'Address entry' },
  { step: 'valuation_completed', source: 'FIRST_PARTY', label: 'Property analysis' },
  { step: 'offer_presented', source: 'FIRST_PARTY', label: 'Offer shown' },
  { step: 'form_submit', source: 'FIRST_PARTY', label: 'Seller continues' },
  { step: 'lead_created', source: 'LEADCOMMAND', label: 'LeadCommand lead' },
  { step: 'deal_closed', source: 'LEADCOMMAND', label: 'Deal outcome' },
] as const
