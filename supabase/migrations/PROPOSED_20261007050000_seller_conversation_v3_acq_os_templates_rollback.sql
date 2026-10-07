-- Rollback for PROPOSED_20261007050000 (only rows this migration inserted, still inactive).
begin;
delete from public.sms_templates
 where metadata->>'source' = 'PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates'
   and is_active = false;
commit;
