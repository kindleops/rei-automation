-- PRETEST for PROPOSED_20261029090000_ai_generated_outbound.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. Asserts: the AI-message ledger (PROPOSED_20261015130000) is applied with its four
-- inbound-bound constraints exactly as that link wrote them, and this link is not applied.
begin;
do $$
declare problems text[] := '{}';
begin
  if to_regclass('public.ai_generated_messages') is null then problems := problems || 'public.ai_generated_messages is missing'::text; end if;
  if exists (select 1 from pg_attribute where attrelid = to_regclass('public.ai_generated_messages') and attname = 'record_kind' and not attisdropped) then problems := problems || 'this link is already applied'::text; end if;
  if (select count(*) from pg_constraint where conrelid = to_regclass('public.ai_generated_messages')
       and conname in ('ai_generated_messages_check', 'ai_generated_messages_check1', 'ai_generated_messages_decision_outcome_check', 'ai_generated_messages_authorization_scope_check')) <> 4 then
    problems := problems || 'the four inbound-bound constraints are not where PROPOSED_20261015130000 put them'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: the ledger and its reply invariants are present';
end $$;
rollback;
