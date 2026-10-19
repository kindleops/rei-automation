// THE read inventory of LeadCommand MCP live mode: every relation and RPC any
// adapter or reused domain service reads, derived from the code (2026-10-16),
// never from a guess. It is enforced three times:
//
//   1. the database role lc_mcp_reader holds SELECT on exactly RELATIONS and
//      EXECUTE on exactly RPCS + MCP_RPCS
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
})

export const RPC_SIGNATURES = Object.freeze([...Object.keys(RPCS), ...Object.keys(MCP_RPCS)].sort())
export const rpcName = (sig) => sig.replace(/^public\./, '').replace(/\(.*$/, '')
export const RPC_NAMES = Object.freeze(RPC_SIGNATURES.map(rpcName))

/** SECURITY DEFINER functions the role may reach although not granted by us: PostGIS metadata (supabase_admin, read-only). Same allowlist as agent/runtime/pg-store.js. */
export const ACCEPTED_REACHABLE_DEFINER = Object.freeze(['st_estimatedextent'])

/** Relations whose write refusal the tests and the live acceptance assert by name, beyond RELATIONS. */
export const WRITE_SENTINELS = Object.freeze(['send_queue', 'sms_templates', 'system_control'])

/** The only PostgREST schema profile live mode may address. */
export const SCHEMA = 'public'
