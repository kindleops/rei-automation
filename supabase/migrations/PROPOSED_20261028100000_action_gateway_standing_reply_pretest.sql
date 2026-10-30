-- PRETEST for PROPOSED_20261028100000_action_gateway_standing_reply.sql (link #31). DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace.
-- Asserts the prerequisites the apply relies on:
--   * links #26 (the gateway and its grant verdict), #28 (receipts, the handoff, the worker load) and #29 (OHG) are
--     applied and this link is not;
--   * #26's per-use authority CHECK is exactly where and what the apply replaces;
--   * the four functions the apply redefines exist with the signatures it replaces.
begin;
do $$
declare problems text[] := '{}';
begin
  if to_regprocedure('action_gateway.grant_refusal(action_gateway.capability_grants,action_gateway.action_intents,boolean)') is null then problems := problems || 'link #26 (action_gateway: the grant verdict) is not applied'::text; end if;
  if to_regclass('action_gateway.seller_action_receipts') is null or to_regprocedure('public.lc_seller_action_load(uuid)') is null then problems := problems || 'link #28 (action_gateway_t34: receipts, the worker load) is not applied'::text; end if;
  if to_regprocedure('public.action_gateway_dw_handoff(uuid,uuid)') is null then problems := problems || 'link #28''s handoff is missing'::text; end if;
  if to_regprocedure('public.action_gateway_principal(text)') is null then problems := problems || 'link #26''s principal lookup is missing'::text; end if;
  if to_regclass('action_gateway.lead_annotations') is null then problems := problems || 'link #29 (action_gateway_ohg) is not applied'::text; end if;
  if exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_seller_facing' and not attisdropped) then problems := problems || 'this link is already applied'::text; end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'action_gateway.action_authorizations'::regclass and c.conname = 'action_authorizations_check1')
     is distinct from 'CHECK (((tier <= 2) OR (approval_id IS NOT NULL) OR (envelope_ref IS NOT NULL)))' then
    problems := problems || 'action_authorizations_check1 is not #26''s per-use authority check'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present (#26, #28, #29, the per-use authority CHECK, the four redefined functions)';
end $$;
rollback;
