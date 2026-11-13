-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback_posttest(negotiation_send_authorization): dropped, envelopes intact".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regclass('public.negotiation_send_authorizations') is not null or to_regclass('public.negotiation_send_authorization_revocations') is not null then raise exception 'assert: tables dropped'; end if;
  if to_regprocedure('public.negotiation_send_authorization_insert_guard()') is not null then raise exception 'assert: guard dropped'; end if;
  if to_regclass('public.negotiation_envelopes') is null or to_regprocedure('public.negotiation_immutable_guard()') is null then raise exception 'assert: the 8.5.19 envelope tables are untouched'; end if;
  raise notice 'rollback_posttest(negotiation_send_authorization): dropped, envelopes intact';
end $$;
rollback;
