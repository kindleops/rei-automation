-- ROLLBACK for PROPOSED_20261006090000_seller_autopilot_v2_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while they are still
-- inactive (an approved/activated row is never deleted by this rollback).
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = 'seller_autopilot_v2_2026_10_06'
   and is_active = false;
commit;
