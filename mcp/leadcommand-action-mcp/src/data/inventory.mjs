// The Action MCP's data inventory: the ONLY relations it may read and the ONLY functions it may call over
// PostgREST. Pinned to the migration (supabase/migrations/PROPOSED_20261019160000_action_gateway.sql:
// action_gateway.read_inventory() and the entry points granted to lc_action_gateway) by test/inventory.test.mjs.
export const GATEWAY_ROLE = 'lc_action_gateway'
export const SCHEMA = 'public'

/** Table reads (GET only): the canonical conversation loaders, the send-time guard facts, resource resolution. */
export const RELATIONS = Object.freeze(['acquisition_opportunities', 'automation_holds', 'automation_suppressions', 'campaigns', 'contact_property_resolution',
  'inbox_thread_state', 'message_events', 'phones', 'properties', 'prospects', 'seller_offers', 'send_queue', 'sms_suppression_list', 'system_control'])

/** link #27's RPCs (Tier-2): pinned to that migration by test/inventory.test.mjs. */
export const T2_RPCS = Object.freeze(['action_gateway_dw_deal_action', 'action_gateway_dw_followup_schedule', 'action_gateway_dw_followup_cancel',
  'action_gateway_dw_campaign_pause', 'action_gateway_dw_human_request', 'action_gateway_followup_intents'])

/** link #28's RPCs (T3 / T4): pinned to that migration by test/inventory.test.mjs. */
export const T34_RPCS = Object.freeze(['action_gateway_authorize_envelope', 'action_gateway_receipt_get', 'action_gateway_negotiation_state', 'action_gateway_offer_authority',
  'action_gateway_dw_handoff', 'action_gateway_dw_offer_envelope'])

/** link #29's RPCs (Operation Hidden Gold: the acquisitions domain write, the delivery / annotation reads): pinned to that migration by test/inventory.test.mjs. */
export const OHG_RPCS = Object.freeze(['action_gateway_dw_ohg', 'action_gateway_reply_status', 'action_gateway_annotations'])

/** The Workforce × Agntei RPCs (PROPOSED_20261022110000_workforce_agntei.sql): pinned to that migration by test/inventory.test.mjs. */
export const WF_RPCS = Object.freeze(['action_gateway_workforce_read', 'action_gateway_dw_workforce'])

/** RPCs (POST /rest/v1/rpc/<name>): the gateway's entry points + the hold authority's lookup. */
export const RPCS = Object.freeze(['action_gateway_controls', 'action_gateway_principal', 'action_gateway_intent_open', 'action_gateway_intent_get', 'action_gateway_refuse',
  'action_gateway_expire', 'action_gateway_await_approval', 'action_gateway_authorize', 'action_gateway_claim', 'action_gateway_complete', 'action_gateway_mark_unknown',
  'action_gateway_recoverable', 'action_gateway_audit_append', 'action_gateway_approval_request', 'action_gateway_approval_get', 'action_gateway_pipeline_facts',
  'action_gateway_work_item_get', 'action_gateway_reply_policy', 'action_gateway_self_check',
  'action_gateway_dw_thread_hold_set', 'action_gateway_dw_operator_task', 'action_gateway_dw_runtime_enqueue',
  'automation_hold_for',
  // link #27 (PROPOSED_20261020100000_action_gateway_t2.sql): the Tier-2 writers + the follow-up read
  ...T2_RPCS,
  // link #28 (PROPOSED_20261020110000_action_gateway_t34.sql): envelope authorization, the handoff / envelope writers, the offer reads
  ...T34_RPCS,
  // link #29 (PROPOSED_20261027120000_action_gateway_ohg.sql): the acquisitions writer + the delivery / annotation reads
  ...OHG_RPCS,
  // Workforce × Agntei: the principal-bound read + the ONE Workforce writer
  ...WF_RPCS])
