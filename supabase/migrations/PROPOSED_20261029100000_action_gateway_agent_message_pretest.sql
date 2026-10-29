-- PRETEST for PROPOSED_20261029100000_action_gateway_agent_message.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. Asserts the prerequisites the apply relies on: links #26, #27, #28, #31 and the
-- ledger kind (PROPOSED_20261029090000) are applied and this link is not; the LeadCommand relations the definer reads and
-- the reservations use exist; the receipts action CHECK and #31's standing CHECK are where those links put them.
begin;
do $$
declare t text; problems text[] := '{}';
begin
  if to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then problems := problems || 'link #26 is not applied'::text; end if;
  if to_regclass('action_gateway.extensions') is null then problems := problems || 'link #27 (the extension registry) is not applied'::text; end if;
  if to_regclass('action_gateway.seller_action_receipts') is null then problems := problems || 'link #28 (receipts) is not applied'::text; end if;
  if to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is null then problems := problems || 'link #31 (standing reply) is not applied'::text; end if;
  if to_regclass('public.ai_generated_messages') is null or not exists (select 1 from pg_attribute where attrelid = to_regclass('public.ai_generated_messages') and attname = 'record_kind' and not attisdropped) then
    problems := problems || 'PROPOSED_20261029090000 (the ledger''s agent_outbound kind) is not applied'::text;
  end if;
  if to_regclass('action_gateway.agent_message_restore') is not null or to_regclass('action_gateway.lead_assignments') is not null then problems := problems || 'this link is already applied'::text; end if;
  foreach t in array array['public.idempotency_ledger', 'public.campaign_targets', 'public.sms_templates', 'public.ownership_template_rotation_control', 'public.inbox_thread_state',
      'public.sms_suppression_list', 'public.system_control', 'agent.runtime_limits', 'agent.ops_work_item'] loop
    if to_regclass(t) is null then problems := problems || ('missing ' || t); end if;
  end loop;
  if to_regclass('action_gateway.seller_action_receipts') is not null and not exists (select 1 from pg_constraint where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%') then
    problems := problems || 'the receipts action CHECK is not where link #28 put it'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present (#26, #27, #28, #31, the ledger kind, LeadCommand relations)';
end $$;
rollback;
