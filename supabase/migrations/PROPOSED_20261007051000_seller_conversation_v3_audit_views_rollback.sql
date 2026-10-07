-- Rollback for PROPOSED_20261007051000 (views only).
begin;
drop view if exists public.v_seller_conversation_v3_research_log;
drop view if exists public.v_seller_conversation_v3_audit;
commit;
