-- ROLLBACK for PROPOSED_20261006150200_price_reality_check_templates.sql.
-- Deletes only unused rows; a row already referenced by send_queue is
-- deactivated instead so send_queue.template_id keeps resolving for KPIs.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where use_case = 'price_reality_check'
   and template_id like 'lc-price-reality-check-%'
   and not exists (select 1 from public.send_queue q where q.template_id = sms_templates.template_id);
update public.sms_templates set is_active = false, safe_for_auto_reply = false, updated_at = now()
 where use_case = 'price_reality_check' and template_id like 'lc-price-reality-check-%';
commit;
