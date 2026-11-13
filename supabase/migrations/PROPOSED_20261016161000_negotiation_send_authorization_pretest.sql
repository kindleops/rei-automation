-- PROPOSED ONLY — PRETEST for PROPOSED_20261016161000_negotiation_send_authorization.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id negotiation_send_authorization
-- Expected last notice: "pretest(negotiation_send_authorization): prerequisites OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regclass('public.negotiation_envelopes') is null or to_regclass('public.negotiation_envelope_revocations') is null
     or to_regprocedure('public.negotiation_immutable_guard()') is null then
    raise exception 'pretest(negotiation_send_authorization): apply PROPOSED_20261015190000_negotiation_authority.sql first';
  end if;
  if to_regclass('public.negotiation_send_authorizations') is not null or to_regclass('public.negotiation_send_authorization_revocations') is not null then
    raise exception 'pretest(negotiation_send_authorization): already applied';
  end if;
  raise notice 'pretest(negotiation_send_authorization): prerequisites OK';
end $$;
rollback;
