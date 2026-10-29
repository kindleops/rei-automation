-- =============================================================================
-- PROPOSED_20261029090000_ai_generated_outbound.sql — the AI-message ledger records AGENT-INITIATED outbound messages
-- STATUS: PROPOSED. Nothing is applied or activated by this file existing. Tested on disposable PostgreSQL 17 only
-- (tests/critical/action-gateway-agent-message-pg.test.mjs). Rollback: PROPOSED_20261029090000_ai_generated_outbound_rollback.sql
-- (refuses while any outbound record exists: the ledger is append-only evidence).
-- =============================================================================
-- public.ai_generated_messages (PROPOSED_20261015130000) holds ONE immutable record per AI-written message, and until
-- now every record answered ONE inbound (queue_key 'ai_conversation:<inbound>', idempotency 'inbound_reply:<inbound>',
-- decision_outcome AI_GENERATED_REPLY, a reply category). An agent-initiated message (a first touch, a re-engagement
-- of a quiet thread, a follow-up: Action Gateway queue_agent_message, link #32) answers no inbound. This link adds a
-- DISCRIMINATOR, record_kind ('reply' default | 'agent_outbound'), and makes the four inbound-bound constraints
-- conditional on it:
--   reply           EXACTLY the existing invariants: inbound_message_id present, queue_key = 'ai_conversation:' ||
--                   inbound, idempotency_key = 'inbound_reply:' || inbound, decision_outcome AI_GENERATED_REPLY, the
--                   reply categories (next_missing_fact, identity_answer, not_interested_close, clarification);
--   agent_outbound  NO inbound, queue_key = 'agent_message:<action intent uuid>', idempotency_key =
--                   'agent_message_intent:<the same uuid>' (one record per gateway intent), decision_outcome
--                   AI_GENERATED_OUTBOUND, a category in first_touch / reengage / followup.
-- Every other constraint (validated, policy-authorized, sealed refs, body hash, 320 chars, no dashes, append-only
-- triggers) applies to both kinds unchanged. Existing rows become record_kind 'reply' (a constant default:
-- metadata-only, no rewrite) and satisfy the reply branch exactly as before.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare c record; expected jsonb := jsonb_build_object(
  'ai_generated_messages_check', 'CHECK ((queue_key = (''ai_conversation:''::text || inbound_message_id)))',
  'ai_generated_messages_check1', 'CHECK ((idempotency_key = (''inbound_reply:''::text || inbound_message_id)))',
  'ai_generated_messages_decision_outcome_check', 'CHECK ((decision_outcome = ''AI_GENERATED_REPLY''::text))',
  'ai_generated_messages_authorization_scope_check', 'CHECK (((authorization_scope ? ''policy_hash''::text) AND (authorization_scope ? ''scope_match''::text) AND ((authorization_scope ->> ''category''::text) = ANY (ARRAY[''next_missing_fact''::text, ''identity_answer''::text, ''not_interested_close''::text, ''clarification''::text]))))');
begin
  if to_regclass('public.ai_generated_messages') is null then raise exception 'precondition: PROPOSED_20261015130000 (ai_generated_messages) is not applied'; end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'record_kind' and not attisdropped) then raise exception 'precondition: this link is already applied'; end if;
  for c in select key, value from jsonb_each_text(expected) loop
    if (select pg_get_constraintdef(x.oid) from pg_constraint x where x.conrelid = 'public.ai_generated_messages'::regclass and x.conname = c.key) is distinct from c.value then
      raise exception 'precondition: % is not PROPOSED_20261015130000''s definition', c.key;
    end if;
  end loop;
end $$;

alter table public.ai_generated_messages
  add column record_kind text not null default 'reply',
  add constraint ai_generated_messages_record_kind_check check (record_kind in ('reply', 'agent_outbound')),
  alter column inbound_message_id drop not null,
  drop constraint ai_generated_messages_check,
  add constraint ai_generated_messages_check check (
    (record_kind = 'reply' and inbound_message_id is not null and queue_key = 'ai_conversation:' || inbound_message_id)
    or (record_kind = 'agent_outbound' and inbound_message_id is null and queue_key ~ '^agent_message:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  drop constraint ai_generated_messages_check1,
  add constraint ai_generated_messages_check1 check (
    (record_kind = 'reply' and idempotency_key = 'inbound_reply:' || inbound_message_id)
    or (record_kind = 'agent_outbound' and idempotency_key = 'agent_message_intent:' || substr(queue_key, 15))),
  drop constraint ai_generated_messages_decision_outcome_check,
  add constraint ai_generated_messages_decision_outcome_check check (
    (record_kind = 'reply' and decision_outcome = 'AI_GENERATED_REPLY') or (record_kind = 'agent_outbound' and decision_outcome = 'AI_GENERATED_OUTBOUND')),
  drop constraint ai_generated_messages_authorization_scope_check,
  add constraint ai_generated_messages_authorization_scope_check check (
    authorization_scope ? 'policy_hash' and authorization_scope ? 'scope_match'
    and ((record_kind = 'reply' and authorization_scope ->> 'category' in ('next_missing_fact', 'identity_answer', 'not_interested_close', 'clarification'))
         or (record_kind = 'agent_outbound' and authorization_scope ->> 'category' in ('first_touch', 'reengage', 'followup'))));
comment on column public.ai_generated_messages.record_kind is 'reply = answers one inbound (every original invariant); agent_outbound = an agent-initiated message of one Action Gateway intent (queue_agent_message), no inbound. PROPOSED_20261029090000_ai_generated_outbound.sql';

do $$
begin
  if exists (select 1 from public.ai_generated_messages where record_kind <> 'reply') then raise exception 'postcondition: existing rows are replies'; end if;
end $$;
