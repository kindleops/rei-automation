-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261015190000_negotiation_authority_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only: the rollback removed every object the migration created.
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.negotiation_envelopes') is not null
     or to_regclass('public.negotiation_envelope_revocations') is not null
     or to_regclass('public.negotiation_offer_events') is not null
     or to_regprocedure('public.negotiation_immutable_guard()') is not null
     or to_regprocedure('public.negotiation_envelope_insert_guard()') is not null
     or to_regprocedure('public.negotiation_offer_event_insert_guard()') is not null then
    raise exception 'rollback posttest(negotiation_authority): an object survived the rollback';
  end if;
  raise notice 'rollback posttest(negotiation_authority): clean';
end
$$;
