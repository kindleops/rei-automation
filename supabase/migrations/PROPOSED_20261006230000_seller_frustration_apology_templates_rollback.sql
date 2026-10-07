-- ROLLBACK for PROPOSED_20261006230000_seller_frustration_apology_templates.sql.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where use_case = 'seller_frustration_apology'
   and template_id like 'lc-seller-frustration-apology-%'
   and not exists (select 1 from public.send_queue q where q.template_id = sms_templates.template_id);
update public.sms_templates set is_active = false, safe_for_auto_reply = false, updated_at = now()
 where use_case = 'seller_frustration_apology' and template_id like 'lc-seller-frustration-apology-%';
commit;
