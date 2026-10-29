-- =============================================================================
-- ROLLBACK of PROPOSED_20261029090000_ai_generated_outbound.sql
-- REFUSES while any agent_outbound / agent_text record exists (the ledger is append-only evidence: export it first and
-- decide). Then restores PROPOSED_20261015130000's four constraints verbatim, inbound_message_id NOT NULL, and drops the
-- discriminator and the author columns.
-- =============================================================================
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (select 1 from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'record_kind' and not attisdropped) then raise exception 'rollback precondition: the link is not applied'; end if;
  if exists (select 1 from public.ai_generated_messages where record_kind <> 'reply') then raise exception 'refused: agent_outbound / agent_text records exist (append-only evidence); the ledger cannot be narrowed under them'; end if;
end $$;

alter table public.ai_generated_messages
  drop constraint ai_generated_messages_check,
  add constraint ai_generated_messages_check check (queue_key = 'ai_conversation:' || inbound_message_id),
  drop constraint ai_generated_messages_check1,
  add constraint ai_generated_messages_check1 check (idempotency_key = 'inbound_reply:' || inbound_message_id),
  drop constraint ai_generated_messages_decision_outcome_check,
  add constraint ai_generated_messages_decision_outcome_check check (decision_outcome = 'AI_GENERATED_REPLY'),
  drop constraint ai_generated_messages_authorization_scope_check,
  add constraint ai_generated_messages_authorization_scope_check check (
    authorization_scope ? 'policy_hash' and authorization_scope ? 'scope_match'
    and authorization_scope->>'category' in ('next_missing_fact', 'identity_answer', 'not_interested_close', 'clarification')),
  alter column inbound_message_id set not null,
  drop constraint ai_generated_messages_author_check,
  drop column author_attribution,
  drop column author_employee,
  drop constraint ai_generated_messages_record_kind_check,
  drop column record_kind;
