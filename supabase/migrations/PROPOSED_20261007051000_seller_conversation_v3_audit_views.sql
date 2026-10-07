-- PROPOSED — NOT APPLIED. Read-only views; no table, no index, no data change.
--
-- Acquisition OS v1 §83 (audit trail per autonomous action) and §39 (research
-- log of uncertain classifications) for SELLER CONVERSATION MACHINE v3.
--
-- The v3 orchestrator (flag SELLER_CONVERSATION_V3, default OFF) emits one
-- automation_events row per autonomous turn (event_type
-- SELLER_CONVERSATION_V3_TURN, dedupe_key seller-conversation-v3-turn:<inbound event>)
-- and one per uncertain turn (SELLER_CONVERSATION_V3_UNCERTAIN). Both are
-- idempotent through uq_automation_events_dedupe_key and read through the
-- existing idx_automation_events_event_type / _created_at indexes.
--
-- seller_automation_decisions is NOT used for this: its row is immutable and is
-- written before the v3 plan, the template and the send exist. The view joins
-- the two on the inbound event id so one row answers "what did the seller say,
-- how was it read, what stage, which rule, which template/language, what number,
-- what was sent, what follow-up" without app logs.

begin;
set local lock_timeout = '5s';

create or replace view public.v_seller_conversation_v3_audit as
select
  e.created_at,
  e.payload->>'inbound_event_id'                as inbound_event_id,
  e.conversation_thread_id                      as thread_key,
  e.property_id,
  e.payload->>'seller_said'                     as seller_said,
  e.payload->'classification'->>'intent'        as classifier_intent,
  e.payload->'classification'->>'language'      as language,
  e.payload->>'stage_before'                    as stage_before,
  e.payload->>'stage'                           as stage,
  e.payload->>'stage_after'                     as stage_after,
  e.payload->>'rule'                            as rule,
  e.payload->>'action'                          as action,
  e.payload->>'terminal_action'                 as terminal_action,
  e.payload->'checklist'                        as checklist,
  e.payload->>'next_expected'                   as next_expected,
  e.payload->'template'->>'template_id'         as template_id,
  e.payload->'template'->>'use_case'            as template_use_case,
  e.payload->'template'->>'language'            as template_language,
  e.payload->'quoted_number'                    as quoted_number,
  (e.payload->'send'->>'queued')::boolean       as queued,
  e.payload->'send'->>'queue_row_id'            as queue_row_id,
  e.payload->'send'->>'blocked_reason'          as send_blocked_reason,
  e.payload->'follow_up'                        as follow_up,
  d.decision_id,
  d.action                                      as ledger_action
from public.automation_events e
left join public.seller_automation_decisions d
  on d.event_id = e.payload->>'inbound_event_id'
where e.event_type = 'SELLER_CONVERSATION_V3_TURN';

create or replace view public.v_seller_conversation_v3_research_log as
select
  e.created_at,
  e.payload->>'inbound_event_id'     as inbound_event_id,
  e.conversation_thread_id           as thread_key,
  e.payload->>'raw_reply'            as raw_reply,
  e.payload->>'language'             as language,
  e.payload->>'stage'                as stage,
  e.payload->>'last_question_use_case' as last_question_use_case,
  e.payload->>'classifier_intent'    as classifier_intent,
  e.payload->'candidate_intents'     as candidate_intents,
  e.payload->>'reason'               as reason,
  e.payload->>'action_taken'         as action_taken,
  e.payload->>'replay_status'        as replay_status
from public.automation_events e
where e.event_type = 'SELLER_CONVERSATION_V3_UNCERTAIN';

-- Operator / service-role only (no anon / authenticated grants).
revoke all on public.v_seller_conversation_v3_audit from anon, authenticated;
revoke all on public.v_seller_conversation_v3_research_log from anon, authenticated;

commit;
