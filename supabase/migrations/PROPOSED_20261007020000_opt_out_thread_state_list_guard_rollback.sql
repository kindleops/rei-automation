-- ROLLBACK for PROPOSED_20261007020000_opt_out_thread_state_list_guard.sql
-- Removes the trigger and function. Rows it wrote stay (they are real opt-outs).
begin;
drop trigger if exists trg_opt_out_thread_state_list_guard on public.inbox_thread_state;
drop function if exists public.trg_opt_out_thread_state_list_guard();
commit;
