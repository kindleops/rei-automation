-- POSTTEST of the rollback of PROPOSED_20261020110000_action_gateway_t34.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. With the runner's fingerprint comparison it proves the rollback removed
-- exactly this link's objects and restored #26's self-check and authorization guard.
begin;
do $$
declare problems text[] := '{}';
begin
  if to_regclass('action_gateway.seller_action_receipts') is not null then problems := problems || 'receipts table remains'::text; end if;
  if to_regclass('public.negotiation_send_authorization_uses') is not null then problems := problems || 'uses table remains'::text; end if;
  if to_regprocedure('action_gateway.self_check_pre_t34(name)') is not null then problems := problems || 'the renamed self-check remains'::text; end if;
  if to_regprocedure('action_gateway.self_check(name)') is null then problems := problems || '#26 self-check missing'::text; end if;
  if exists (select 1 from pg_trigger where tgname = 'seller_offers_ceiling_guard') then problems := problems || 'R4 trigger remains'::text; end if;
  if exists (select 1 from pg_policy where polname = 'lc_action_gateway_select_t34') then problems := problems || 'system_control t34 policy remains'::text; end if;
  if exists (select 1 from pg_proc where proname in ('action_gateway_dw_handoff', 'action_gateway_dw_offer_envelope', 'action_gateway_authorize_envelope', 'action_gateway_receipt_get',
      'action_gateway_negotiation_state', 'action_gateway_offer_authority', 'lc_seller_action_receipt_record', 'lc_seller_action_load', 'lc_seller_action_open_receipts',
      'negotiation_send_authorization_consume', 'seller_offers_ceiling_guard', 'envelope_ref_refusal', 't34_self_check_allow')) then
    problems := problems || 'a t34 function remains'::text;
  end if;
  if pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) ~ 'envelope_ref_refusal' then problems := problems || 'authorization_guard still has the envelope branch'::text; end if;
  if pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) !~ 'ENVELOPE_AUTHORIZATION_NOT_IMPLEMENTED' then problems := problems || '#26 authorization_guard not restored'::text; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then problems := problems || '#26 self-check not ok after the rollback'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only the t34 link''s objects are gone; #26 is intact';
end $$;
rollback;
