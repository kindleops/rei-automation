-- POSTTEST of the rollback of PROPOSED_20261029090000_ai_generated_outbound.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- Read-only, ends in ROLLBACK. With the runner's fingerprint comparison it proves the four constraints and the NOT NULL
-- are PROPOSED_20261015130000's again and the discriminator and the author columns are gone.
begin;
do $$
begin
  if exists (select 1 from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname in ('record_kind', 'author_employee', 'author_attribution') and not attisdropped) then raise exception 'rollback posttest: record_kind / an author column remains'; end if;
  if not (select attnotnull from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'inbound_message_id') then raise exception 'rollback posttest: inbound_message_id is nullable'; end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.ai_generated_messages'::regclass and conname = 'ai_generated_messages_decision_outcome_check') <> 'CHECK ((decision_outcome = ''AI_GENERATED_REPLY''::text))' then
    raise exception 'rollback posttest: the decision outcome check was not restored';
  end if;
  raise notice 'rollback posttest: the reply-only ledger is restored';
end $$;
rollback;
