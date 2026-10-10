-- ROLLBACK for PROPOSED_20261010121000_s3_s4_natural_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while still inactive.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = 'seller_flow_followups_2026_10_10'
   and is_active = false;
commit;
