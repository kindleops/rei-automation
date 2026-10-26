// THE read inventory of LeadCommand MCP live mode: every relation and RPC any
// adapter or reused domain service reads, derived from the code (2026-10-16),
// never from a guess. RE-DERIVED 2026-10-19 against rc-8.5.21 (9bf2e399): the
// static import closure of src/ reaches 64 apps/api modules; since 43650af3 only
// quick-scan/read-client.js changed (an optional rpcAllowlist parameter, default
// unchanged) plus the decisionFreshness extraction, so the 9 tools read the
// same 20 relations and 2 app RPCs. None of them reads the holds registry,
// followup_intents, the ops work items, contact_property_resolution or the
// inbox disposition (declined_unverified is not interpreted by any reused
// projection). The live coverage test proves it, including that NOTHING was
// refused by the guard (a swallowed refusal would hide a gap).
// It is enforced three times:
//
//   1. the database role lc_mcp_reader holds SELECT on exactly RELATIONS and
//      EXECUTE on exactly RPCS + MCP_RPCS (DEFINER_READS lists what the MCP's own
//      definer functions read as their owner; none of it is granted to the role)
//      (supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql; a test
//      asserts the migration's lists equal these);
//   2. the MCP's own transport guard (data/read-fetch.mjs) refuses any request
//      for a relation or function outside it, before the network;
//   3. a test drives the REAL services over the live transport against a fake
//      PostgREST and asserts the relations requested == RELATIONS (nothing read
//      outside it, nothing granted that is never read).
//
// `readers` names the code that reads each relation (adapter or apps/api module).
export const READER_ROLE = 'lc_mcp_reader'

export const RELATIONS = Object.freeze({
  acquisition_opportunities: ['entity-graph-outreach-state#getEntityGraphOutreachState'],
  campaign_target_graph: ['adapters/contact-status', 'entity-graph-outreach-state', 'research-tools#eg.distress_signals'],
  campaign_targets: ['adapters/campaigns', 'entity-graph-outreach-state'],
  campaigns: ['adapters/campaigns', 'entity-graph-outreach-state'],
  census_geo_metrics: ['entity-graph-zip-context#getEntityGraphZipContext'],
  eg_buyer_index: ['entity-graph-zip-context'],
  eg_property_facts: ['adapters/facts-search', 'adapters/leads', 'research-tools#eg.distress_signals'],
  emails: ['entity-graph-service#fetchContactLadder (dossier)'],
  inbox_thread_state: ['entity-graph-service#fetchThreadsForContext (dossier)', 'entity-graph-outreach-state'],
  master_owners: ['entity-graph-service#loadPropertyNeighborhood (dossier)'],
  mi_geo_period_rollup: ['entity-graph-zip-context'],
  mi_rollup_builds: ['entity-graph-zip-context#currentBuild'],
  mv_map_market_sales: ['adapters/comps'],
  phones: ['entity-graph-service#fetchContactLadder (dossier)'],
  preforeclosure_status_v2: ['research-tools#eg.distress_signals'],
  probate_status: ['research-tools#eg.distress_signals'],
  properties: ['adapters/comps', 'adapters/market', 'adapters/scores', 'entity-graph-service (dossier)', 'entity-graph-outreach-state', 'research-tools#eg.property_lookup'],
  property_acquisition_scores: ['adapters/scores', 'entity-graph-service (dossier)'],
  prospects: ['entity-graph-service (dossier)', 'entity-graph-owner-link#prospectsLinkedToProperties'],
  sms_suppression_list: ['compliance/query-active-suppression#queryActiveSuppression'],
})
export const RELATION_NAMES = Object.freeze(Object.keys(RELATIONS).sort())

/** Relations the code tolerates as absent (read errors become "unavailable"); the migration skips them if missing. */
export const OPTIONAL_RELATIONS = Object.freeze(['census_geo_metrics'])

/** Existing STABLE RPCs the reused services call (both SECURITY DEFINER, read-only; verified in the migration). */
export const RPCS = Object.freeze({
  'public.entity_graph_property_records(text)': ['entity-graph-service#loadPropertyNeighborhood (recorded documents)'],
  'public.campaign_entity_contact_review_flags(text[])': ['quick-scan/services#entityContact', 'campaign-recipient-metrics#fetchEntityContactReviewBlocks'],
})

/** RPCs the MCP itself calls, created by the lc_mcp_reader migration. */
export const MCP_RPCS = Object.freeze({
  'public.lc_mcp_reader_self_check(text[],text[],name)': ['data/credential#bootSelfCheck (privilege introspection, SECURITY INVOKER)'],
  'public.lc_mcp_operator_role(uuid,uuid)': ['auth/principal#createRpcMembershipStore (one membership lookup, SECURITY DEFINER)'],
  // rc-8.5.21 operations reads (each tool behind its own scope, none in the default grant)
  'public.lc_mcp_ops_finding(uuid,text)': ['adapters/operations#getOpsSupervisorStatus → ops-intel-capability#opsIntelTool (store.latestFinding)'],
  'public.lc_mcp_ops_research_valuation_snapshot()': ['adapters/operations#getOpsSupervisorStatus → ops-intel-capability#opsIntelTool (source.researchValuationSnapshot)'],
  'public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)': ['adapters/operations#searchActionCenter (operations-store#actionCenterSummary / #listActionStates SQL)'],
  'public.lc_mcp_thread_hold_status(uuid)': ['adapters/operations#getThreadHoldStatus (public.automation_hold_for + automation-hold-core#STATIC_PERMANENT_EXCLUSIONS)'],
  'public.lc_mcp_followup_intent_health()': ['adapters/operations#getFollowupIntentHealth (followup-lifecycle#loadFollowUpLifecycleHealth reads; supervisor-checks#evaluateSupervisor followup_lifecycle rule)'],
})

/**
 * OPTIONAL MCP RPCs (1.1 conversation intelligence, PROPOSED_20261026120000_lc_mcp_conversation_intel.sql,
 * separately approved): passed to the self-check like every other function, so an APPLIED one is judged
 * (STABLE, executable, an expected definer). One NOT applied is no finding: its tools answer
 * data_unavailable / SOURCE_NOT_APPLIED and every 1.0 tool keeps working.
 */
export const OPTIONAL_MCP_RPCS = Object.freeze({
  'public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)': ['adapters/conversations#getLeadConversation'],
  'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)': ['adapters/conversations#searchConversationWorklist'],
  'public.lc_mcp_pipeline_counts(text,text,text,integer)': ['adapters/conversations#getPipelineSummary'],
  'public.lc_mcp_conversation_signals(integer,text)': ['adapters/conversations#getPipelineSummary'],
})

/**
 * What each MCP SECURITY DEFINER function reads AS ITS OWNER. lc_mcp_reader holds NO privilege on
 * any of these (the posttest proves SELECT / EXECUTE on them is refused, and the boot self-check
 * reports any direct SELECT in an exposed schema): the role sees only the function's projection.
 * Why definer projections and not table grants: schema agent is not exposed through PostgREST;
 * automation_holds / followup_intents carry thread keys (phones) and free-text reasons; the
 * follow-up views are security_invoker (a grant on them needs a grant on followup_intents).
 */
export const DEFINER_READS = Object.freeze({
  'public.lc_mcp_operator_role(uuid,uuid)': ['agent.operator_membership'],
  'public.lc_mcp_ops_finding(uuid,text)': ['agent.finding (types supervisor.summary, valuation.refresh_batch, recovery.batch, recovery.linkage only)'],
  'public.lc_mcp_ops_research_valuation_snapshot()': ['agent.ops_research_valuation_snapshot(timestamptz) → public.acquisition_opportunities, public.property_acquisition_scores, public.seller_offers, public.message_events, public.negotiation_* (counts and ids)'],
  'public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)': ['agent.conversation_action_state'],
  'public.lc_mcp_thread_hold_status(uuid)': ['public.inbox_thread_state (one row by id)', 'public.acquisition_opportunities (primary_thread_key → id, ≤ 10)', 'public.automation_hold_for(text,uuid,text,uuid,text,text) → public.automation_holds'],
  'public.lc_mcp_followup_intent_health()': ['public.v_followup_intent_health → public.followup_intents', 'public.v_followup_intent_reasons → public.followup_intents'],
  'public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)': ['public.message_events (by property_id / thread_key / from_phone_number, keyset on created_at, id)', 'public.inbox_thread_state', 'public.campaign_target_graph', 'public.contact_property_resolution (if present)', 'public.sms_suppression_list', 'public.phones', 'public.automation_hold_for(…) → public.automation_holds (if present)', 'public.properties / public.eg_property_facts (existence)'],
  'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)': ['public.inbox_thread_state', 'public.message_events', 'public.eg_property_facts', 'public.property_acquisition_scores', 'public.sms_suppression_list', 'public.automation_hold_for(…) (if present)'],
  'public.lc_mcp_pipeline_counts(text,text,text,integer)': ['public.eg_property_facts'],
  'public.lc_mcp_conversation_signals(integer,text)': ['public.inbox_thread_state', 'public.message_events', 'public.eg_property_facts', 'public.campaign_target_graph', 'public.property_acquisition_scores'],
})

/** Relations / functions the MCP reaches ONLY through a definer projection (never granted to the role). */
export const DEFINER_ONLY_SOURCES = Object.freeze([
  'agent.finding', 'agent.conversation_action_state', 'agent.ops_research_valuation_snapshot(timestamptz)',
  'public.automation_holds', 'public.automation_hold_for(text,uuid,text,uuid,text,text)',
  'public.followup_intents', 'public.v_followup_intent_health', 'public.v_followup_intent_reasons',
  'public.message_events', 'public.contact_property_resolution',
])

/** The REQUIRED functions (the 1.0 reader migration's list). */
export const RPC_SIGNATURES = Object.freeze([...Object.keys(RPCS), ...Object.keys(MCP_RPCS)].sort())
export const OPTIONAL_RPC_SIGNATURES = Object.freeze(Object.keys(OPTIONAL_MCP_RPCS).sort())
/** Every function the self-check judges and the transport may call (required + optional). */
export const ALL_RPC_SIGNATURES = Object.freeze([...RPC_SIGNATURES, ...OPTIONAL_RPC_SIGNATURES].sort())
export const rpcName = (sig) => sig.replace(/^public\./, '').replace(/\(.*$/, '')
export const RPC_NAMES = Object.freeze(ALL_RPC_SIGNATURES.map(rpcName))
/** Functions the MCP itself created (called on the raw transport after the inventory checks). */
export const MCP_RPC_NAMES = Object.freeze([...Object.keys(MCP_RPCS), ...OPTIONAL_RPC_SIGNATURES].map(rpcName))

/** SECURITY DEFINER functions the role may reach although not granted by us: PostGIS metadata (supabase_admin, read-only). Same allowlist as agent/runtime/pg-store.js. */
export const ACCEPTED_REACHABLE_DEFINER = Object.freeze(['st_estimatedextent'])

/** Relations whose write refusal the tests and the live acceptance assert by name, beyond RELATIONS. */
export const WRITE_SENTINELS = Object.freeze(['send_queue', 'sms_templates', 'system_control'])

/** The only PostgREST schema profile live mode may address. */
export const SCHEMA = 'public'
