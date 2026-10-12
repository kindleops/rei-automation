// THE TOOL-PERMISSION MANIFEST for the read-only research agent (owner 10-10 §4).
//
// Every tool the model can reach, with its tier, side effect and caps. A test
// asserts the live registry equals this manifest exactly (no tool can be added
// without editing this reviewed file) and that every entry is a small T0 read.
// Explicitly NOT available — no tool exists for any of these, the registry is
// read-only + sealed, and T4 rules make them unregistrable:
//   SMS / calls / email · campaign create / status change / launch / queue ·
//   seller-facing offers or quotes · any DB write outside the agent's own
//   audit / run / ledger rows · arbitrary SQL / RPC · URL fetch / web egress ·
//   approvals · changes to its own budget, prompt, models or permissions.
// The one non-data tool, request_deeper_analysis, is loop control: the SERVER
// decides (criteria + caps + pre-call budget); it reads and writes nothing.
export const RESEARCH_PERMISSION_MANIFEST = Object.freeze([
  // reused Quick Scan reads (quick-scan/tools.js) — Entity Graph property evidence
  { name: 'eg.property_core', reads: 'property record (facts, address, market)', rows_to_model: 50 },
  { name: 'eg.ownership', reads: 'owner kind / portfolio counts (never names)', rows_to_model: 50 },
  { name: 'eg.recorded_documents', reads: 'recorded mortgages, liens, foreclosures, parcel snapshot', rows_to_model: 50 },
  { name: 'eg.sales_history', reads: 'recorded sales (buyer kind, never names)', rows_to_model: 50 },
  { name: 'valuation.read', reads: 'vendor value, Decision Engine band, equity rule', rows_to_model: 50 },
  { name: 'eg.outreach_state', reads: 'stage, last contact date/direction, contact readiness (masked)', rows_to_model: 50 },
  { name: 'eg.sms_eligibility', reads: 'campaign target graph SMS verdict', rows_to_model: 50 },
  { name: 'mi.zip_context', reads: 'ZIP market context (MI build)', rows_to_model: 50 },
  { name: 'eg.street_view_availability', reads: 'image reference present (metadata only)', rows_to_model: 50 },
  // research reads (research/research-tools.js)
  { name: 'campaign.list', reads: 'campaigns (status, counters)', rows_to_model: 25 },
  { name: 'campaign.overview', reads: 'one campaign + campaign_targets totals', rows_to_model: 25 },
  { name: 'campaign.targets', reads: 'campaign_targets rows (status / block reasons, no phones)', rows_to_model: 25 },
  { name: 'campaign.audience_top', reads: 'campaign audience ranked from campaign_target_graph', rows_to_model: 25 },
  { name: 'eg.distress_signals', reads: 'graph flags, parcel, probate_status, preforeclosure_status_v2, eg_property_facts + inconsistencies', rows_to_model: 25 },
  { name: 'eg.contact_map', reads: 'people as handles, phones as last-2 masks, eligibility / blockers', rows_to_model: 25 },
  { name: 'eg.facts', reads: 'eg_property_facts (reports "not applied" when absent)', rows_to_model: 1 },
  // R1 10-12: address fragment → ≤ 5 property ids (trigram-indexed ILIKE on properties.property_address_full; 25 rows read, 5 s)
  { name: 'eg.property_lookup', reads: 'properties address parts (id, street address, city, state, zip, market) — no owner fields', rows_to_model: 5, max_rows_per_request: 25, timeout_ms: 5_000 },
// caps default to 200 rows / 30 s; an entry may only TIGHTEN them. Tier, side effect, approval and
// cost class come last so no entry can override them.
].map((e) => Object.freeze({ max_rows_per_request: 200, timeout_ms: 30_000, ...e, tier: 'T0', side_effect: 'read', approval: 'none', cost_class: 'db_light' })))

export const RESEARCH_CONTROL_TOOLS = Object.freeze([
  Object.freeze({ name: 'request_deeper_analysis', kind: 'loop_control', decided_by: 'server', reads: null, writes: null }),
])

export const FORBIDDEN_CAPABILITIES = Object.freeze(['sms_send', 'call', 'email_send', 'campaign_status_change', 'campaign_create_or_launch', 'queue_write', 'seller_offer', 'db_write', 'arbitrary_sql', 'web_egress', 'approval_grant', 'self_modification'])
