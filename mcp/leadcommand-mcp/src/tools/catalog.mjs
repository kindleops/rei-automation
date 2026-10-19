// LeadCommand MCP 1.0 tool catalog. READ-ONLY by construction:
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
    description: 'One lead by property_id: lead state from the Entity Graph read model plus the live outreach state (stage/status WITH source pipeline vs conversation, last contact, campaign membership, contact readiness). Message text is never returned.',
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
])

export const NOT_IMPLEMENTED = Object.freeze([
  { name: 'campaign launch readiness', reason: 'evaluateCampaignLaunchReadiness imports the outbound feeder / sender routing modules; it is outside the read-only import fence. Planned for 1.1 behind a pure readiness core.' },
  { name: 'seller message text / thread read', reason: 'PII minimization + untrusted content: 1.0 returns conversation metadata only.' },
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
