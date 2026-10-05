-- ROLLBACK for PROPOSED_20261005200000_missed_call_templates.sql.
-- Removes only the rows that migration created. If any missed_call text was
-- already queued/sent, prefer deactivating (is_active = false) over deleting so
-- send_queue.template_id keeps resolving for KPIs.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where use_case = 'missed_call'
   and template_id in ('lc-missed-call-en-1','lc-missed-call-en-2','lc-missed-call-es-1','lc-missed-call-es-2')
   and not exists (select 1 from public.send_queue q where q.template_id = sms_templates.template_id);
update public.sms_templates set is_active = false, updated_at = now()
 where use_case = 'missed_call';
delete from public.system_control where key = 'missed_call_autotext_enabled';
commit;
