// LeadCommand MCP tool catalog (1.0 + the 1.1 conversation intelligence reads). READ-ONLY by construction:
//   * every tool here is a read with readOnlyHint, one read scope, closed input
//     schema, output schema, limits and an adapter that reuses existing modules;
//   * the catalog is frozen at boot and checked (assertCatalogReadOnly) — a name
//     or scope that looks like a write refuses to boot.
// Tools deliberately NOT implemented are listed in NOT_IMPLEMENTED with the reason.
import { z } from 'zod/v4'
import { PropertyId, Uuid, Zip, State, Label, Day, Limit, Cursor, Prov, Page, N, S, B, loose } from './schemas.mjs'
import { searchLeads, getLead } from '../adapters/leads.mjs'
import { searchProperties, getProperty } from '../adapters/properties.mjs'
import { getAcquisitionScore } from '../adapters/scores.mjs'
import { getMarketIntelligence } from '../adapters/market.mjs'
import { searchComps } from '../adapters/comps.mjs'
import { getCampaignMetrics } from '../adapters/campaigns.mjs'
import { getLeadContactStatus } from '../adapters/contact-status.mjs'
import { getOpsSupervisorStatus, searchActionCenter, getThreadHoldStatus, getFollowupIntentHealth, OPS_INTEL_SECTIONS, ACTION_STATES, HOLD_REASON_CATEGORIES, HOLD_MATCHED_ON, FOLLOWUP_COUNT_FIELDS } from '../adapters/operations.mjs'
import { getLeadConversation, searchConversationWorklist, getPipelineSummary, getOpportunityRanking, WORKLIST_CATEGORIES, PIPELINE_DIMENSIONS, HISTORY_STATES, CONTACT_STATES, INTEREST_STATES } from '../adapters/conversations.mjs'
import { getCorpusCensus, searchLeadScreen, CENSUS_SOURCES, SCREEN_PAGE_MAX, SCREEN_PAGE_DEFAULT } from '../adapters/census.mjs'

const READ_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })

const LeadRow = z.object({
  lead_id: z.string(), property_id: z.string(), market: S, city: S, state: S, zip: S, property_type: S, asset_type: S,
  conversation: z.object({ stage: S, status: S, last_message_at: S }).strict(),
  pipeline: z.object({ stage: S, status: S, deal_linked: z.boolean() }).strict(),
  last_contact: z.object({ at: S, direction: S }).strict(),
  campaigns: z.object({ count: N, latest_name: S }).strict(),
  sms_status: S,
  decision_engine: z.object({ aos_score: N, decision_tier: S, computed_at: S, provenance: Prov }).strict(),
  distress_signal_count: N, signal_labels: z.array(z.string()), equity_class: S, provenance: Prov,
}).strict()

const PropertyRow = z.object({
  property_id: z.string(), address: S, city: S, state: S, zip: S, market: S, property_type: S,
  asset_type: S.optional(), units: N, bedrooms: N.optional(), baths: N.optional(), building_sqft: N.optional(), year_built: N.optional(),
  vendor_estimated_value: N.optional(), equity: z.object({ known_pct: N, class: S, rule: S }).strict().optional(),
  distress_signal_count: N.optional(), signal_labels: z.array(z.string()).optional(), last_sale_on: S.optional(),
  match: loose.optional(),
  provenance: Prov,
}).strict()

const SearchLeadsInput = z.object({
  market: Label(60).optional().describe('anchor: exact LeadCommand market label, e.g. "Minneapolis, MN" (as returned by other tools)'),
  zip: Zip.optional().describe('anchor: property ZIP'),
  conversation_stage: Label(40).optional().describe('anchor: conversation (seller) stage'),
  pipeline_stage: Label(40).optional().describe('anchor: pipeline deal stage'),
  pipeline_status: Label(40).optional().describe('anchor: pipeline deal status'),
  sms_status: Label(40).optional().describe('anchor: SMS status from the read model'),
  state: State.optional(),
  last_contact_after: Day.optional(), last_contact_before: Day.optional(),
  campaign_count_min: z.number().int().min(0).max(1000).optional(),
  distress_signals_min: z.number().int().min(0).max(50).optional(),
  decision_tiers: z.array(Label(20)).min(1).max(5).optional(),
  limit: Limit(25, 10),
  cursor: Cursor.optional(),
}).strict()

const SearchPropertiesInput = z.object({
  address: z.string().min(5).max(120).optional().describe('house number + street (e.g. "1947 Johnson St NE"); returns ≤ 5 candidates, no pagination'),
  market: Label(60).optional().describe('anchor: exact LeadCommand market label, e.g. "Minneapolis, MN" (as returned by other tools)'),
  zip: Zip.optional().describe('anchor (or refines an address lookup)'),
  city: Label(60).optional().describe('anchor (requires state)'),
  county: Label(60).optional().describe('anchor (requires state)'),
  state: State.optional(),
  asset_types: z.array(Label(40)).min(1).max(5).optional(),
  units_min: z.number().int().min(0).max(10000).optional(), units_max: z.number().int().min(0).max(10000).optional(),
  year_built_min: z.number().int().min(1700).max(2100).optional(), year_built_max: z.number().int().min(1700).max(2100).optional(),
  value_min: z.number().min(0).max(1e10).optional(), value_max: z.number().min(0).max(1e10).optional(),
  bedrooms_min: z.number().int().min(0).max(100).optional(),
  distress_signals_min: z.number().int().min(0).max(50).optional(),
  limit: Limit(25, 10),
  cursor: Cursor.optional(),
}).strict()

const PropertyIdInput = z.object({ property_id: PropertyId }).strict()

const MarketInput = z.object({ zip: Zip.optional(), property_id: PropertyId.optional() }).strict()
  .refine((v) => Boolean(v.zip) !== Boolean(v.property_id), { message: 'give exactly one of zip or property_id' })

const CompsInput = z.object({
  property_id: PropertyId.describe('subject property'),
  radius_miles: z.number().min(0.25).max(3).default(1),
  months: z.number().int().min(3).max(24).default(12),
  same_lane_only: z.boolean().default(true).describe('SFR vs multifamily lane (canonical-corpus-reads#corpusLaneOf)'),
  limit: Limit(25, 10),
}).strict()

const CampaignInput = z.object({
  campaign_id: Uuid.optional().describe('one campaign (adds exact target status counts); omit to list recent campaigns'),
  status: z.enum(['draft', 'built', 'queued', 'scheduled', 'activating', 'active', 'paused', 'completed', 'failed', 'archived']).optional(),
  limit: Limit(25, 10),
}).strict()

const CampaignShape = z.object({
  campaign_id: z.string(), name: S, status: S, objective: S, candidate_source: S, market: S, state: S, created_at: S, updated_at: S,
  lifecycle: loose, counters: loose, caps: loose, audience: loose,
}).strict()

// ── rc-8.5.21 operations reads (each behind its own OPT-IN scope) ──
const OpsSection = z.object({ available: z.boolean(), code: z.string().optional(), at: S.optional(), job_id: S.optional(), value: z.any().optional(), linkage: z.any().optional(), provenance: Prov }).passthrough()
const OpsSupervisorInput = z.object({
  sections: z.array(z.enum(OPS_INTEL_SECTIONS)).min(1).max(OPS_INTEL_SECTIONS.length).optional().describe(`subset of ${OPS_INTEL_SECTIONS.join(', ')} (default: all)`),
}).strict()
const ActionCenterInput = z.object({
  state: z.enum(ACTION_STATES).optional().describe('one operational state (default: every state)'),
  lost_only: z.boolean().default(true).describe('only LOST conversations (an unanswered seller message nobody picked up); false = every conversation in the state'),
  limit: Limit(25, 10),
  cursor: Cursor.optional(),
}).strict()
const ActionRow = z.object({
  conversation_id: z.string(), state: S, state_label: S, active_queue: B, owner: S, lost: z.boolean(), verified_stage: S, stage_verified: z.boolean(), stage_note: S,
  next_action: S, due_at: S, priority_reason: S, reasons: z.array(z.string()), pending_approvals: N, has_opportunity: z.boolean(),
  last_inbound_at: S, last_outbound_at: S, state_since: S, computed_at: S,
}).strict()
const StateRef = z.object({ id: z.string(), label: z.string(), active: z.boolean() }).strict()
const HoldRow = z.object({
  source: z.enum(['registry', 'static']), hold_type: z.string(), reason_category: z.enum(HOLD_REASON_CATEGORIES), matched_on: z.enum(HOLD_MATCHED_ON),
  blocked_capabilities: z.array(z.string()), set_at: S,
}).strict()
const FollowupCounts = z.object(Object.fromEntries(FOLLOWUP_COUNT_FIELDS.map((k) => [k, N]))).strict()

// ── 1.1 conversation intelligence (OPT-IN scopes leadcommand.conversations.read / leadcommand.pipeline.read) ──
const Contact = z.object({ state: z.enum(CONTACT_STATES), blockers: z.array(z.string()), unknowns: z.array(z.string()), authoritative: z.literal(false) }).strict()
const Interest = z.object({
  state: z.enum(INTEREST_STATES), basis: z.array(z.object({ message_id: z.string(), signal: z.string(), detail: z.array(z.string()) }).strict()),
  opt_out_message_id: S, possible_opt_out_message_id: S, label_says_interested: B, rule: z.string(),
}).strict()
const MessageRow = z.object({
  id: z.string(), thread: z.string(), direction: S, speaker: z.enum(['seller', 'leadcommand', 'unknown']), event_type: S, at: S,
  text: S, text_truncated: z.boolean(), instruction_like: z.boolean(),
  delivery: z.object({ status: S, provider_status: S, final_failure: B, sent_at: S, delivered_at: S, failed_at: S }).strict().nullable(),
  recorded: z.object({ opt_out: B, intent: S, language: S }).strict(),
  opt_out_reading: z.enum(['confirmed', 'possible', 'none']).nullable(),
  origin: S, attribution: S, property_id: z.string().optional(),
  times: z.object({ event_timestamp: S, received_at: S }).strict(),
}).strict()
const ThreadRow = z.object({
  handle: z.string().regex(/^T[0-9]+$/), thread_id: S, link: S, thread_property_id: z.string().optional(), status: S, automation_state: S, latest_direction: S,
  last_inbound_at: S, last_outbound_at: S, counters: z.object({ inbound: N, outbound: N }).strict(),
  events_on_record: z.object({ inbound: N, outbound: N, capped_at: N }).strict(),
  contact_property: z.object({ role: S, rejected: z.boolean(), suppression_scope: S }).strict().nullable(),
  contact: Contact, inputs: loose,
}).strict()
const LeadConversationInput = z.object({
  property_id: PropertyId.optional().describe('the lead (property) whose seller threads to read'),
  thread_id: Uuid.optional().describe('OR one inbox thread (e.g. a conversation_id from the Action Center / worklist)'),
  window_days: z.number().int().min(1).max(1095).default(365).describe('only messages from the last N days (1–1095, default 365)'),
  limit: Limit(40, 30),
  cursor: Cursor.optional(),
}).strict().refine((v) => Boolean(v.property_id) !== Boolean(v.thread_id), { message: 'give exactly one of property_id or thread_id' })
const WorklistInput = z.object({
  category: z.enum(WORKLIST_CATEGORIES).describe('unanswered_inbound: the seller spoke last (verified against the message log); recent_inbound: any inbound in the window; opted_out; identity_conflict: one seller phone with messages about several properties; suppression_conflict: the opt-out record and the suppression list disagree'),
  window_days: z.number().int().min(1).max(365).default(30),
  market: Label(60).optional().describe('exact LeadCommand market label'),
  limit: Limit(25, 10),
  cursor: Cursor.optional(),
}).strict()
const WorklistRow = z.object({
  thread_id: z.string(), property_id: S, last_inbound_at: S, last_outbound_at: S,
  verified: z.object({ state: z.enum(['unanswered', 'answered', 'not_verifiable']), latest_direction: S, latest_at: S, last_outbound_at: S, source: z.string() }).strict(),
  properties_in_window: N, identity_conflict: z.boolean(),
  inbound: z.array(z.object({ id: z.string(), at: S, text: S, instruction_like: z.boolean(), opt_out_reading: z.enum(['confirmed', 'possible', 'none']), recorded: z.object({ opt_out: B, intent: S, language: S }).strict(), attribution: S }).strict()),
  latest_outbound: z.object({ id: z.string(), at: S, text: S, instruction_like: z.boolean(), delivery_status: S, failed: B, origin: S, commitment: loose.nullable() }).strict().nullable(),
  overdue_response: z.boolean(),
  interest: Interest,
  readings: z.object({ offer_request: z.boolean(), price_mentions: z.array(loose), timeline_mentions: z.array(loose) }).strict(),
  lead: z.object({ market: S, conversation_stage: S, conversation_status: S, pipeline_stage: S, pipeline_status: S, labels_are: z.string() }).strict(),
  decision_engine: z.object({ present: z.boolean(), aos_score: N, decision_tier: S, computed_at: S, age_days: N, stale: B }).strict(),
  contact: Contact,
}).strict()
const RankingInput = z.object({
  window_days: z.number().int().min(1).max(90).default(30).describe('threads with a seller message in the last N days'),
  market: Label(60).optional(),
  max_threads: z.number().int().min(1).max(100).default(100).describe('threads scanned (≤ 4 worklist pages); truncated=true when more exist'),
  top: z.number().int().min(1).max(25).default(10),
  include_blocked: z.boolean().default(true).describe('keep contact-blocked threads in the ranking (they still need a human)'),
}).strict()
const PipelineSummaryInput = z.object({
  dimension: z.enum(PIPELINE_DIMENSIONS).default('market').describe('group lead counts by this field'),
  market: Label(60).optional(), state: State.optional(),
  limit: z.number().int().min(1).max(100).default(25).describe('top N groups (the rest is summed)'),
  window_days: z.number().int().min(1).max(365).default(30).describe('window of the conversation signals'),
}).strict()

/**
 * Tool spec: { name, title, description, scope, min_role, input, output, limits, paged, untrusted, handler }
 * handler(input, services, { after, now, principal }) → payload (+ for paged tools: { rows, has_more, last })
 */
export const TOOLS = Object.freeze([
  {
    name: 'leadcommand_search_leads',
    title: 'Search seller leads',
    description: 'Search LeadCommand seller leads (a lead is anchored on its property). One ANCHOR filter is required: market, zip, conversation_stage, pipeline_stage, pipeline_status or sms_status. Returns lead state only — stage/status, last contact date, campaign membership, Decision Engine tier (missing ≠ 0), distress count. Never names, phones, addresses or message text. Keyset pagination via next_cursor.',
    scope: 'leadcommand.leads.read', min_role: 'operator', paged: true,
    input: SearchLeadsInput,
    output: z.object({ rows: z.array(LeadRow) }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 25, max_response_bytes: 65536 },
    untrusted: ['result.rows[].property_type', 'result.rows[].campaigns.latest_name', 'result.rows[].signal_labels[]'],
    handler: searchLeads,
  },
  {
    name: 'leadcommand_get_lead',
    title: 'Get one seller lead',
    description: 'One lead by property_id: lead state from the Entity Graph read model plus the live outreach state (stage/status WITH source pipeline vs conversation, last contact, campaign membership, contact readiness). Message text is not returned here: read it with leadcommand_get_lead_conversation (opt-in scope).',
    scope: 'leadcommand.leads.read', min_role: 'operator',
    input: PropertyIdInput,
    output: z.object({ lead_id: z.string(), property_id: z.string(), outreach: loose, message_text: z.object({ included: z.literal(false), reason: z.string() }).strict(), provenance: Prov }).passthrough(),
    limits: { per_min: 60, timeout_ms: 8000, max_rows: 1, max_response_bytes: 65536 },
    untrusted: ['result.property_type', 'result.campaigns.latest_name', 'result.signal_labels[]', 'result.outreach.campaigns.latest.block_reason', 'result.outreach.contact_readiness.*'],
    handler: getLead,
  },
  {
    name: 'leadcommand_search_properties',
    title: 'Search properties',
    description: 'Search properties by an address fragment (≤ 5 candidates) OR by one ANCHOR — market, zip, city+state or county+state — with optional asset type, units, year built, vendor value, bedrooms and distress-count ranges. Asset facts only; no owner names or mailing addresses. Keyset pagination via next_cursor (anchor searches).',
    scope: 'leadcommand.properties.read', min_role: 'operator', paged: true,
    input: SearchPropertiesInput,
    output: z.object({ rows: z.array(PropertyRow), mode: z.enum(['keyset', 'address_lookup']), ambiguous: z.boolean().optional() }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 25, max_response_bytes: 65536 },
    untrusted: ['result.rows[].address', 'result.rows[].property_type', 'result.rows[].signal_labels[]'],
    handler: searchProperties,
  },
  {
    name: 'leadcommand_get_property',
    title: 'Get one property',
    description: 'One property by property_id: core facts, ownership SHAPE (owner kind, corporate / out-of-state, years owned — never names), recorded mortgages / liens / foreclosures (private lenders withheld), sales history (buyer kind only), distress evidence side by side (campaign graph, parcel, probate, preforeclosure) and deterministic cross-source inconsistencies.',
    scope: 'leadcommand.properties.read', min_role: 'operator',
    input: PropertyIdInput,
    output: z.object({ property_id: z.string(), address: S, market: S, facts: loose, has_coordinates: z.boolean(), facts_provenance: Prov, ownership: loose, recorded_documents: loose, sales_history: loose, distress: loose }).strict(),
    limits: { per_min: 30, timeout_ms: 10000, max_rows: 1, max_response_bytes: 98304 },
    untrusted: ['result.address', 'result.facts.*', 'result.recorded_documents.*', 'result.sales_history.sales[].doc_type', 'result.sales_history.sales[].price_note', 'result.distress.*'],
    handler: getProperty,
  },
  {
    name: 'leadcommand_get_acquisition_score',
    title: 'Get the Decision Engine result',
    description: 'The persisted Decision Engine output for one property (property_acquisition_scores): valuation band, investor ceiling, recommended cash offer, AOS score / tier / strategy, transaction probabilities, pressure scores — with the freshness verdict (current / stale / not run) from the engine\'s own freshness contract. A property the engine has not run for returns available=false with nulls, never 0.',
    scope: 'leadcommand.scores.read', min_role: 'operator',
    input: PropertyIdInput,
    output: z.object({ property_id: z.string(), available: z.boolean(), status: z.string(), display_state: z.string(), property_record_found: z.boolean(), valuation: loose.nullable(), investor_ceiling: loose.nullable(), offer: loose.nullable(), scores: loose.nullable(), freshness: loose.nullable(), provenance: Prov, note: z.string().optional(), withheld: z.array(z.string()).optional() }).strict(),
    limits: { per_min: 60, timeout_ms: 8000, max_rows: 1, max_response_bytes: 32768 },
    untrusted: [],
    handler: getAcquisitionScore,
  },
  {
    name: 'leadcommand_get_market_intelligence',
    title: 'Get ZIP market intelligence',
    description: 'Market Intelligence for one ZIP (or the ZIP of a property): sales in 90 days / 1 year, investor and cash share (over known buyer types), median price and $/sqft, latest sale date, buyer counts — from the current ready Market Intelligence build.',
    scope: 'leadcommand.market.read', min_role: 'operator',
    input: MarketInput,
    output: z.object({ zip: z.string(), resolved_from: S, available: z.boolean(), build_id: N, metrics: z.object({ sales_90d: N, sales_1y: N, investor_share_1y_pct: N, cash_share_1y_pct: N, median_price_1y: N, median_ppsf_1y: N, median_investor_price_1y: N, latest_sale: S, buyers_in_zip: N, active_buyers_in_zip: N }).strict().nullable(), shares_note: z.string().optional(), demographics_available: z.boolean().optional(), provenance: Prov }).strict(),
    limits: { per_min: 60, timeout_ms: 8000, max_rows: 1, max_response_bytes: 16384 },
    untrusted: [],
    handler: getMarketIntelligence,
  },
  {
    name: 'leadcommand_search_comps',
    title: 'Search recorded sales near a property',
    description: 'Recorded market sales near a subject property (radius ≤ 3 mi, ≤ 24 months, ≤ 25 rows, nearest first), with price, $/sqft, $/door, doc type, arms-length / cash flags and the BUYER EVIDENCE basis (recorded buyer vs not on record; a deed buyer is never asserted to be the current owner; names withheld). Evidence only — not engine-qualified comps and not a valuation.',
    scope: 'leadcommand.comps.read', min_role: 'operator',
    input: CompsInput,
    output: z.object({ subject: loose, search: loose, rows: z.array(loose), not_a_valuation: z.string(), provenance: Prov }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 25, max_response_bytes: 65536 },
    untrusted: ['result.rows[].property_type', 'result.rows[].doc_type', 'result.rows[].price_source'],
    handler: searchComps,
  },
  {
    name: 'leadcommand_get_campaign_metrics',
    title: 'Get campaign metrics',
    description: 'Campaign status, lifecycle dates, synced send / delivery / reply counters (with their caveat), caps and audience build summary; with campaign_id also EXACT campaign_targets counts by status. Omit campaign_id to list recent campaigns. No recipients, phones or names.',
    scope: 'leadcommand.campaigns.read', min_role: 'operator',
    input: CampaignInput,
    output: z.object({ campaigns: z.array(CampaignShape), targets: loose.nullable() }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 25, max_response_bytes: 65536 },
    untrusted: ['result.campaigns[].name', 'result.campaigns[].objective', 'result.campaigns[].candidate_source', 'result.campaigns[].audience.*'],
    handler: getCampaignMetrics,
  },
  {
    name: 'leadcommand_get_lead_contact_status',
    title: 'Get lead contact eligibility + suppression state',
    description: 'SMS eligibility (campaign target graph verdict) and SUPPRESSION STATE per contact for one lead — contacts are handles (C1, P1 …), never phone numbers. A suppression lookup that fails is reported as unknown, never as not suppressed. Read-only: nothing here can send, enroll or unsuppress.',
    scope: 'leadcommand.contact_status.read', min_role: 'operator',
    input: PropertyIdInput,
    output: z.object({ property_id: z.string(), summary: loose, eligibility: loose, readiness: loose.nullable(), contacts: z.array(z.object({ contact: z.string().regex(/^C[0-9]+$/), person: z.string().regex(/^P[0-9]+$/), suppression: z.object({ state: z.enum(['suppressed', 'not_suppressed', 'unknown']), reason: S, types: z.array(z.string()) }).strict() }).passthrough()), suppression_provenance: Prov, policy_notes: z.array(z.string()) }).strict(),
    limits: { per_min: 20, timeout_ms: 8000, max_rows: 10, max_response_bytes: 32768 },
    untrusted: ['result.eligibility.reason', 'result.contacts[].block_reason', 'result.readiness.*'],
    handler: getLeadContactStatus,
  },
  {
    name: 'leadcommand_get_ops_supervisor_status',
    title: 'Get the operations supervisor status',
    description: 'The latest operations supervisor run (check statuses and counts, all-clear, escalations), valuation coverage / overdue offers / negotiation authority, the latest valuation dry run and recovery linkage — the read-only operations intelligence the supervisor and the brief already produced. Counts and record ids only, never contact values. A source that has not run is available=false with a code, never 0. Read-only: nothing here runs a job, decides a work item or sends.',
    scope: 'leadcommand.ops_supervisor.read', min_role: 'operator',
    input: OpsSupervisorInput,
    output: z.object({
      at: z.string(),
      sections: z.object({ supervisor: OpsSection.optional(), research_valuation: OpsSection.optional(), valuation_dry_run: OpsSection.optional(), recovery: OpsSection.optional() }).strict(),
      provenance: z.array(z.object({ section: z.string(), source: z.string() }).strict()),
      read_only: z.literal(true),
      sections_requested: z.array(z.string()),
    }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 1, max_response_bytes: 32768 },
    untrusted: ['result.sections.*.value'],
    handler: getOpsSupervisorStatus,
  },
  {
    name: 'leadcommand_search_action_center',
    title: 'Search the Inbound Action Center (lost conversations)',
    description: 'The Inbound Action Center: conversation counts per operational state (needs attention, AI handling, negotiating, scheduled follow-up …) and a page of conversations — by default the LOST ones (an unanswered seller message nobody picked up). Conversation ids (inbox thread ids), state / next-action codes and dates only: never message text, phones, names, evidence refs or opportunity ids. Keyset pagination via next_cursor. Read-only: acknowledging or resolving a work item is not possible here.',
    scope: 'leadcommand.action_center.read', min_role: 'operator', paged: true,
    input: ActionCenterInput,
    output: z.object({
      rows: z.array(ActionRow), available: z.boolean(), code: z.string().optional(),
      summary: z.object({ counts: z.record(z.string(), z.number()), lost: z.number(), active_queue: z.number(), total: z.number(), computed_at: S }).strict().nullable(),
      filters: z.object({ state: S, lost_only: z.boolean() }).strict().optional(),
      states: z.array(StateRef), provenance: Prov,
    }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 25, max_response_bytes: 65536 },
    untrusted: ['result.rows[].next_action', 'result.rows[].priority_reason', 'result.rows[].reasons[]'],
    handler: searchActionCenter,
  },
  {
    name: 'leadcommand_get_thread_hold_status',
    title: 'Get the automation hold status of one inbox thread',
    description: 'Is this inbox thread under an automation hold? Held / not held / unknown, the reason CATEGORY (operator_hold, ownership_attribution_unresolved, permanent_exclusion), what the hold matched (thread, property, owner, opportunity) and the blocked capabilities — from THE hold authority (public.automation_hold_for) plus the code-level permanent exclusions. Never a hold id, hold key, reason text or phone. A lookup that fails is unknown, never "not held". Read-only: nothing here sets or releases a hold.',
    scope: 'leadcommand.holds.read', min_role: 'operator',
    input: z.object({ thread_id: Uuid.describe('inbox thread id (the conversation_id of the Action Center)') }).strict(),
    output: z.object({
      thread_id: z.string(), thread_found: z.boolean().nullable(), status: z.enum(['held', 'not_held', 'unknown']), held: z.boolean().nullable(),
      reason_categories: z.array(z.enum(HOLD_REASON_CATEGORIES)), holds: z.array(HoldRow), blocked_capabilities: z.array(z.string()),
      provenance: Prov, policy_notes: z.array(z.string()),
    }).strict(),
    limits: { per_min: 60, timeout_ms: 8000, max_rows: 1, max_response_bytes: 16384 },
    untrusted: [],
    handler: getThreadHoldStatus,
  },
  {
    name: 'leadcommand_get_followup_intent_health',
    title: 'Get follow-up intent lifecycle health',
    description: 'Follow-up execution health: intent counts by lifecycle state (scheduled, overdue, stale leases, dispatched without outcome, delivered, failed after provider accept, held, not executable …), the top 20 non-success reason codes with counts, and the ops supervisor\'s own verdict (ok / warn / critical, stuck and needs-review counts). Never thread keys, phones or message text. Read-only: nothing here plans, re-queues or cancels a follow-up.',
    scope: 'leadcommand.followups.read', min_role: 'operator',
    input: z.object({}).strict(),
    output: z.object({
      available: z.boolean(), code: z.string().optional(), counts: FollowupCounts.nullable(), computed_at: S,
      reasons: z.array(z.object({ state: S, kind: S, reason: S, writer: S, n: z.number() }).strict()),
      verdict: z.object({ status: z.string(), stuck: z.number(), needs_review: z.number(), issue: z.object({ severity: S, escalate: z.boolean(), title: S, action: S }).strict().nullable(), rule: z.string() }).strict().nullable(),
      provenance: Prov,
    }).strict(),
    limits: { per_min: 30, timeout_ms: 8000, max_rows: 1, max_response_bytes: 16384 },
    untrusted: ['result.reasons[].kind', 'result.reasons[].reason', 'result.reasons[].writer', 'result.verdict.issue.title'],
    handler: getFollowupIntentHealth,
  },
  {
    name: 'leadcommand_get_lead_conversation',
    title: 'Read one lead\'s seller conversation',
    description: 'The seller conversation for ONE lead (property_id) or ONE inbox thread (thread_id): every seller thread linked to the lead (handles T1…, never phone numbers) with the send-time guard\'s INPUTS read as blockers / unknowns, and a keyset page of messages oldest-first within the page — direction, speaker, the message TEXT (untrusted content; phones / emails masked; instruction_like flags text aimed at an AI), timestamps, delivery states, recorded opt-out / intent / language, attribution. history.state separates present / outside_window / empty / missing (counters say messages exist, none on record) / no_thread. Evidence readings (interest, price candidates, timeline, offer requests) cite message ids and are inferred, never authority. Rows about another property on the same phone are counted, never returned. next_cursor pages BACK in time. Read-only: nothing here can send, queue, approve or change a record.',
    scope: 'leadcommand.conversations.read', min_role: 'operator', paged: true,
    input: LeadConversationInput,
    output: z.object({
      rows: z.array(MessageRow),
      subject: z.object({ property_id: z.string().optional(), thread_id: z.string().optional(), found: z.boolean(), property_on_record: B }).strict(),
      order: z.string().optional(), threads: z.array(ThreadRow), threads_truncated: z.boolean().optional(),
      history: z.object({ state: z.enum(HISTORY_STATES), earliest_at: S, latest_at: S, rows_on_record: N, capped_at: N.optional(), window_days: N }).strict(),
      counts: z.object({ inbound_in_window: N, outbound_in_window: N, other_property_rows_in_window: N, capped_at: N }).strict().nullable(),
      evidence: z.object({
        last_speaker: S, commitment: loose.nullable(), unanswered_inbound: z.boolean(), seller_waiting_since: S, last_outbound_failed: z.boolean(), interest: Interest, interest_by_thread: z.record(z.string(), Interest),
        price_mentions: z.array(loose), timeline_mentions: z.array(loose), offer_requests: z.array(loose), instruction_like_message_ids: z.array(z.string()), scope: z.string(), rule: z.string(),
      }).strict().nullable(),
      contact: z.object({ state: z.enum(CONTACT_STATES), threads_blocked: z.number(), threads_unknown: z.number(), threads_clear: z.number(), authoritative: z.literal(false), note: z.string() }).strict().nullable(),
      sources: z.record(z.string(), z.boolean()), content_policy: z.string(), provenance: Prov,
    }).strict(),
    limits: { per_min: 30, timeout_ms: 10000, max_rows: 40, max_response_bytes: 196608 },
    untrusted: ['result.rows[].text', 'result.rows[].event_type', 'result.rows[].recorded.intent', 'result.threads[].status', 'result.threads[].automation_state', 'result.evidence.price_mentions[].span', 'result.evidence.timeline_mentions[].span'],
    handler: getLeadConversation,
  },
  {
    name: 'leadcommand_search_conversation_worklist',
    title: 'Search the seller conversation worklist',
    description: 'A page of inbox threads in ONE category — unanswered_inbound (the seller spoke last, VERIFIED against the message log, not a label), recent_inbound, opted_out, identity_conflict (one seller phone with messages about several properties) — with the EXACT category total, the seller\'s latest ≤ 3 messages as evidence (untrusted text, masked), an interest reading that requires message evidence (a label alone reads label_only), price / timeline / offer-request readings, the lead\'s pipeline labels (labels, not evidence), Decision Engine presence and age, and suppression / hold inputs. Keyset pagination via next_cursor. Read-only.',
    scope: 'leadcommand.conversations.read', min_role: 'operator', paged: true,
    input: WorklistInput,
    output: z.object({ rows: z.array(WorklistRow), category: z.enum(WORKLIST_CATEGORIES), window_days: N, total: N, content_policy: z.string(), provenance: Prov }).strict(),
    limits: { per_min: 20, timeout_ms: 12000, max_rows: 25, max_response_bytes: 196608 },
    untrusted: ['result.rows[].inbound[].text', 'result.rows[].inbound[].recorded.intent', 'result.rows[].readings.price_mentions[].span', 'result.rows[].readings.timeline_mentions[].span', 'result.rows[].lead.*'],
    handler: searchConversationWorklist,
  },
  {
    name: 'leadcommand_get_pipeline_summary',
    title: 'Get exact pipeline counts and conversation signals',
    description: 'EXACT lead counts grouped by one dimension (market, state, conversation / pipeline stage and status, SMS status; top N groups, the remainder and not-set counted), optionally filtered by market / state, plus conversation and integrity signals over a window: threads with inbound, unanswered inbound, opted out, suppressed, not contactable; inbound / opt-out / unknown-sender messages; phones on several properties; leads in conversation with no or a stale Decision Engine score. Counts only. Read-only.',
    scope: 'leadcommand.pipeline.read', min_role: 'operator',
    input: PipelineSummaryInput,
    output: z.object({ counts: loose, signals: loose }).strict(),
    limits: { per_min: 30, timeout_ms: 12000, max_rows: 1, max_response_bytes: 32768 },
    untrusted: ['result.counts.groups[].value'],
    handler: getPipelineSummary,
  },
  {
    name: 'leadcommand_get_opportunity_ranking',
    title: 'Rank seller conversations by evidence',
    description: 'A bounded batch (≤ 100 threads with a seller message in the window, read through the worklist) ranked by EXPLICIT additive factors, each citing its evidence: interest from the seller\'s words (a label alone scores 5), offer requests, price-ask candidates, timelines, verified unanswered messages and how long the seller has waited, our overdue commitments, Decision Engine tier / staleness, contact blockers and identity conflicts. Opted-out, possible opt-out, not-owner and declined threads are excluded and counted. Each row names a next step for a human (never an automatic action). Plus an attention list: overdue responses, overdue commitments, interest without a Decision Engine score, identity conflicts. Read-only.',
    scope: 'leadcommand.conversations.read', min_role: 'operator',
    input: RankingInput,
    output: z.object({
      window_days: z.number(), market: S, scanned: z.number(), total_with_inbound: N, pages_read: z.number(), truncated: z.boolean(),
      ranked: z.array(z.object({ rank: z.number(), thread_id: z.string(), property_id: S, score: z.number(), next_step: z.string(), factors: z.array(z.object({ factor: z.string(), points: z.number(), evidence: z.string() }).strict()), flags: z.array(z.string()), interest: z.enum(INTEREST_STATES), verified: z.string(), last_inbound_at: S, latest_seller_text: S, decision_engine: loose, contact: Contact }).strict()),
      excluded: z.record(z.string(), z.number()), attention: z.record(z.string(), z.array(z.string())), factors: z.record(z.string(), z.number()), rule: z.string(), content_policy: z.string(), provenance: Prov,
    }).strict(),
    limits: { per_min: 6, timeout_ms: 30000, max_rows: 25, max_response_bytes: 131072 },
    untrusted: ['result.ranked[].latest_seller_text', 'result.ranked[].factors[].evidence'],
    handler: getOpportunityRanking,
  },
  {
    name: 'leadcommand_get_corpus_census',
    title: 'Get the exact corpus census',
    description: 'EXACT populations of every lead-corpus source (properties, eg_property_facts = the lead key, campaign_target_graph, campaign_targets, campaigns, inbox_thread_state, message_events, acquisition_opportunities, property_acquisition_scores, sms_suppression_list, master_owners, prospects, phones), coverage of each over the lead corpus (phones on record, SMS-eligible phone, in a campaign, a thread, inbound, a Decision Engine score and its freshness, stages set, deal linked, last contact, value and equity known), evidence counts (distress, tax, liens, probate, pre-foreclosure, equity ≥ 30 %, portfolio owners, out-of-state, signals never contacted), duplicate identities (one phone on several properties, properties sharing an address, owners with several properties, facts / properties mismatches), contact state (opted-out, wrong-number, suppressed, unanswered threads), pipeline health (unresolved needs_review, interest labels without recent contact, stalled deals, label inconsistencies, contactable phones never contacted) and Decision Engine coverage over leads in conversation. Optionally one market. Counts only; columns the database lacks are named, never guessed.',
    scope: 'leadcommand.pipeline.read', min_role: 'operator',
    input: z.object({ market: Label(60).optional().describe('exact LeadCommand market label (as returned by other tools); omitted = the whole corpus') }).strict(),
    output: z.object({
      market: S, lead_key: z.string(), columns_present: z.array(z.string()), columns_absent: z.array(z.string()),
      sources: z.object(Object.fromEntries(CENSUS_SOURCES.map((k) => [k, z.union([z.number(), loose]).nullable()]))).strict(),
      coverage: loose, evidence: loose, duplicates: loose, contact: loose, pipeline_health: loose, decision_engine: loose,
      notes: z.array(z.string()), rule: z.string(), provenance: Prov,
    }).strict(),
    limits: { per_min: 6, timeout_ms: 30000, max_rows: 1, max_response_bytes: 32768 },
    untrusted: [],
    handler: getCorpusCensus,
  },
  {
    name: 'leadcommand_search_lead_screen',
    title: 'Page through every lead for screening',
    description: `A keyset page (property_id ascending, ≤ ${SCREEN_PAGE_MAX} rows, default ${SCREEN_PAGE_DEFAULT}) of SCREENING rows over the whole lead corpus (eg_property_facts), optionally one market / state: property basics (type, units, year, sqft, estimated value), equity, distress flags, owner portfolio size, phones ON RECORD as counts and SMS eligibility (never a number), outreach counts, last contact, conversation / pipeline labels, Decision Engine presence and age, and thread state (unanswered, opted out, wrong number, suppressed). Built for a restartable batch screen of every lead (scripts/corpus-screen.mjs): cheap and exhaustive, so only candidates go to the expensive reads. Labels are labels, not seller intent; thread flags are records, not contact eligibility.`,
    scope: 'leadcommand.pipeline.read', min_role: 'operator', paged: true,
    input: z.object({
      market: Label(60).optional().describe('exact LeadCommand market label'),
      state: State.optional(),
      after_property_id: PropertyId.optional().describe('resume AFTER this property_id (the last id of a page you already hold) — a durable alternative to cursor for restartable batch jobs; not with cursor'),
      limit: Limit(SCREEN_PAGE_MAX, SCREEN_PAGE_DEFAULT),
      cursor: Cursor.optional(),
    }).strict(),
    output: z.object({
      rows: z.array(z.object({
        property_id: z.string(), market: S, state: S, zip: S, property_type: S, asset_type: S, units: N, year_built: N, building_sqft: N, estimated_value: N,
        equity: z.object({ known_pct: N, class: S }).strict(),
        distress: z.object({ signal_count: N, tax_delinquent: B, active_lien: B, probate: B, preforeclosure: B, lien_count: N }).strict(),
        owner: z.object({ property_count: N, type_guess: S, out_of_state: B }).strict(),
        contact: z.object({ phones_on_graph: z.number(), sms_eligible_phones: z.number(), candidate_phones: N, sms_status: S }).strict(),
        outreach: z.object({ campaign_count: N, campaign_targets: z.number() }).strict(),
        last_contact: z.object({ at: S, direction: S }).strict(),
        conversation: z.object({ stage: S, status: S }).strict(),
        pipeline: z.object({ stage: S, status: S, deal_linked: z.boolean() }).strict(),
        decision_engine: z.object({ present: z.boolean(), aos_score: N, tier: S, computed_at: S }).strict(),
        threads: z.object({ n: z.number(), last_inbound_at: S, last_outbound_at: S, unanswered: z.boolean(), opted_out: z.boolean(), wrong_number: z.boolean(), suppressed: z.boolean(), contactability: S }).strict(),
      }).strict()),
      order: z.string(), filters: z.object({ market: S, state: S }).strict(), labels_are: z.string(), rule: z.string(), provenance: Prov,
    }).strict(),
    limits: { per_min: 60, timeout_ms: 15000, max_rows: SCREEN_PAGE_MAX, max_response_bytes: 1048576 },
    untrusted: ['result.rows[].conversation.*', 'result.rows[].pipeline.stage', 'result.rows[].pipeline.status', 'result.rows[].contact.sms_status', 'result.rows[].owner.type_guess', 'result.rows[].equity.class', 'result.rows[].threads.contactability', 'result.rows[].property_type', 'result.rows[].asset_type'],
    handler: searchLeadScreen,
  },
])

export const NOT_IMPLEMENTED = Object.freeze([
  { name: 'campaign launch readiness', reason: 'evaluateCampaignLaunchReadiness imports the outbound feeder / sender routing modules; it is outside the read-only import fence. Planned for 1.1 behind a pure readiness core.' },
  { name: 'raw thread keys, phone numbers, provider payloads in conversation reads', reason: 'PII minimization: 1.1 returns message text (masked, untrusted) by thread handle; the phone is never needed to read a conversation.' },
  { name: 'truthful campaign reply counts', reason: 'needs message_events pairing (seller → sender after send); no bounded, indexed read path in the guarded transport yet.' },
  { name: 'engine-qualified comps / valuations', reason: 'evaluateCompEligibility lives in acquisitionDecisionEngine.js (the engine write path); 1.0 exposes recorded sales as evidence and the persisted engine result separately.' },
  { name: 'operations mutations (work item acknowledge / resolve / dismiss / reopen, setting or releasing a hold, planning / re-queueing / cancelling a follow-up, running a supervisor / recovery job)', reason: 'The operations tools are reads of what the jobs already produced; every mutation stays in the authenticated operations API and the lease-bound database writers.' },
  { name: 'any write (SMS, campaign, routing, suppression, enrollment, record edits, SQL/shell/HTTP/RPC)', reason: 'Phase One is READ-ONLY by owner directive.' },
])

const WRITE_WORDS = /(send|launch|activate|enqueue|enroll|unsuppress|suppress_|update|delete|insert|upsert|write|create|edit|patch|execute|sql|shell|http|rpc|dispatch)/i

/** Boot-time invariant: every registered tool is a read. Throws (refuse to boot) otherwise. */
export function assertCatalogReadOnly(tools = TOOLS) {
  const names = new Set()
  for (const t of tools) {
    if (!/^leadcommand_(search|get)_[a-z_]+$/.test(t.name)) throw new Error(`tool ${t.name}: only leadcommand_search_* / leadcommand_get_* reads are registrable`)
    if (WRITE_WORDS.test(t.name.replace(/^leadcommand_(search|get)_/, ''))) throw new Error(`tool ${t.name}: write-shaped name`)
    if (!/\.read$/.test(t.scope)) throw new Error(`tool ${t.name}: scope must be a .read scope`)
    if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`)
    names.add(t.name)
    for (const k of ['title', 'description', 'scope', 'input', 'output', 'limits', 'handler']) if (!t[k]) throw new Error(`tool ${t.name}: ${k} required`)
  }
  return true
}

export { READ_ANNOTATIONS, Page }
