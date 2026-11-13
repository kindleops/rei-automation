-- POSTTEST of the rollback of PROPOSED_20261027120000_action_gateway_ohg.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. With the runner's fingerprint comparison it proves the rollback removed
-- exactly this link's objects and registry rows and restored #28's receipts action CHECK.
begin;
do $$
declare problems text[] := '{}'; d text;
begin
  if to_regclass('action_gateway.lead_annotations') is not null then problems := problems || 'annotation ledger remains'::text; end if;
  if to_regclass('action_gateway.ohg_restore') is not null then problems := problems || 'restore table remains'::text; end if;
  if exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261027120000_action_gateway_ohg') then problems := problems || 'this link''s extension rows remain'::text; end if;
  if (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261020110000_action_gateway_t34') <> 10 then problems := problems || '#28''s extension rows were touched'::text; end if;
  if exists (select 1 from pg_proc where proname in ('action_gateway_dw_ohg', 'action_gateway_reply_status', 'action_gateway_annotations', 'lead_annotations_immutable')) then problems := problems || 'an ohg function remains'::text; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%';
  if d is null or d ~ 'set_lead_temperature' or d !~ 'queue_authorized_reply' then problems := problems || ('the receipts action CHECK was not restored: ' || coalesce(d, 'absent')); end if;
  if 'set_lead_temperature' = any (action_gateway.standing_t2_actions()) then problems := problems || 'standing_t2_actions() still lists an ohg action'::text; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then problems := problems || 'the self-check is not ok after the rollback'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only the ohg link''s objects are gone; #26 / #27 / #28 are intact';
end $$;
rollback;
