-- PRETEST for PROPOSED_20261020110000_action_gateway_t34.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace.
-- Asserts the prerequisites the apply relies on:
--   * links #26 and #27 (the extension registry) are applied and this link is not;
--   * the negotiation authority + send authorization tables (PROPOSED_20261015190000 / _20261016161000) exist;
--   * public.seller_offers carries the columns the R4 guard reads; public.property_acquisition_scores exists.
begin;
do $$
declare t text; problems text[] := '{}';
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.self_check(name)') is null then problems := problems || 'link #26 (action_gateway) is not applied'::text; end if;
  if to_regclass('action_gateway.extensions') is null then problems := problems || 'link #27 (action_gateway_t2: the extension registry) is not applied'::text; end if;
  if to_regclass('action_gateway.seller_action_receipts') is not null then problems := problems || 'this link is already applied'::text; end if;
  foreach t in array array['public.negotiation_envelopes','public.negotiation_envelope_revocations','public.negotiation_offer_events','public.negotiation_send_authorizations',
      'public.negotiation_send_authorization_revocations','public.seller_offers','public.property_acquisition_scores','public.inbox_thread_state','public.sms_suppression_list'] loop
    if to_regclass(t) is null then problems := problems || ('missing ' || t); end if;
  end loop;
  foreach t in array array['purchase_price','authorized_ceiling','status','direction','metadata','thread_key','property_id'] loop
    if to_regclass('public.seller_offers') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'seller_offers' and column_name = t) then
      problems := problems || ('missing column public.seller_offers.' || t);
    end if;
  end loop;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present (#26, negotiation authority + send authorization, seller_offers, engine scores)';
end $$;
rollback;
