-- POSTTEST for PROPOSED_20261028100000_action_gateway_standing_reply.sql (link #31). DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. Asserts the link is applied exactly and is born OFF.
begin;
do $$
declare problems text[] := '{}'; d text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_seller_facing' and not attisdropped) then problems := problems || 'standing_seller_facing is missing'::text; end if;
  if not exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_basis' and not attisdropped) then problems := problems || 'standing_basis is missing'::text; end if;
  -- born OFF: no grant carries the flag
  if exists (select 1 from action_gateway.capability_grants where standing_seller_facing) then problems := problems || 'a grant already carries the standing flag'::text; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'action_gateway.capability_grants'::regclass and conname = 'capability_grants_standing_seller_facing_chk';
  if d is null or d !~ 'conversation.queue_reply' or d !~ 'max_tier = 3' then problems := problems || ('the standing flag CHECK is wrong: ' || coalesce(d, 'absent')); end if;
  if exists (select 1 from pg_constraint where conrelid = 'action_gateway.action_authorizations'::regclass and conname = 'action_authorizations_check1') then problems := problems || '#26''s per-use authority CHECK was not replaced'::text; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'action_gateway.action_authorizations'::regclass and conname = 'action_authorizations_per_use_authority_chk';
  if d is null or d !~ 'standing' then problems := problems || ('the per-use authority CHECK does not admit the standing flag: ' || coalesce(d, 'absent')); end if;
  if not exists (select 1 from pg_constraint where conrelid = 'action_gateway.action_authorizations'::regclass and conname = 'action_authorizations_standing_chk') then problems := problems || 'the standing confinement CHECK is missing'::text; end if;
  if to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is null then problems := problems || 'standing_reply_refusal is missing'::text; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'action_gateway.action_authorizations'::regclass and tgname = 'ab_standing_authority' and not tgisinternal) then problems := problems || 'the standing derivation trigger is missing'::text; end if;
  -- the redefined bodies carry the new rule
  if (select prosrc from pg_proc where oid = 'action_gateway.grant_refusal(action_gateway.capability_grants,action_gateway.action_intents,boolean)'::regprocedure) !~ 'standing' then problems := problems || 'grant_refusal does not know the standing grant'::text; end if;
  if (select prosrc from pg_proc where oid = 'public.action_gateway_dw_handoff(uuid,uuid)'::regprocedure) !~ 'standing' then problems := problems || 'the handoff does not re-verify the standing grant'::text; end if;
  if (select prosrc from pg_proc where oid = 'public.lc_seller_action_load(uuid)'::regprocedure) !~ 'standing_live' then problems := problems || 'the worker load does not report standing_live'::text; end if;
  -- privileges: the new internal functions are not callable by the API roles
  if has_function_privilege('anon', 'action_gateway.standing_reply_refusal(uuid,uuid)', 'execute') or has_function_privilege('authenticated', 'action_gateway.standing_reply_refusal(uuid,uuid)', 'execute') then problems := problems || 'standing_reply_refusal is executable by an API role'::text; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then problems := problems || 'the self-check is not ok after the apply'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'posttest: link #31 applied exactly; no grant carries the standing flag (born OFF)';
end $$;
rollback;
