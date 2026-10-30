-- POSTTEST of the rollback of PROPOSED_20261028100000_action_gateway_standing_reply.sql (link #31). DISPOSABLE DATABASE
-- ONLY: run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. With the runner's fingerprint comparison it proves the rollback removed exactly
-- this link's objects and restored #26's per-use authority CHECK and #26 / #28's function bodies.
begin;
do $$
declare problems text[] := '{}';
begin
  if exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname in ('standing_seller_facing', 'standing_basis') and not attisdropped) then problems := problems || 'a standing grant column remains'::text; end if;
  if exists (select 1 from pg_attribute where attrelid = 'action_gateway.action_authorizations'::regclass and attname = 'standing' and not attisdropped) then problems := problems || 'the authorization standing column remains (only allowed while standing authorizations exist, which a disposable test never has)'::text; end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'action_gateway.action_authorizations'::regclass and c.conname = 'action_authorizations_check1')
     is distinct from 'CHECK (((tier <= 2) OR (approval_id IS NOT NULL) OR (envelope_ref IS NOT NULL)))' then problems := problems || '#26''s per-use authority CHECK was not restored'::text; end if;
  if to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null or to_regprocedure('action_gateway.standing_authority()') is not null then problems := problems || 'a standing function remains'::text; end if;
  if exists (select 1 from pg_trigger where tgrelid = 'action_gateway.action_authorizations'::regclass and tgname = 'ab_standing_authority') then problems := problems || 'the standing trigger remains'::text; end if;
  if (select prosrc from pg_proc where oid = 'public.lc_seller_action_load(uuid)'::regprocedure) ~ 'standing_live' then problems := problems || 'the worker load still reports standing_live'::text; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then problems := problems || 'the self-check is not ok after the rollback'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only link #31''s objects are gone; #26 / #28 / #29 are intact';
end $$;
rollback;
