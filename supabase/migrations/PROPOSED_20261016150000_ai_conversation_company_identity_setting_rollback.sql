-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql.
-- Removes the setting ONLY while it is still the born-empty value: an owner-approved identity is
-- never deleted by this file.
delete from public.system_control
 where key = 'ai_conversation_company_identity'
   and coalesce(value, '') = '';
