-- ROLLBACK for PROPOSED_20261007040000_no_response_followup_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while still inactive.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = 'no_response_followup_2026_10_06'
   and is_active = false;
commit;
