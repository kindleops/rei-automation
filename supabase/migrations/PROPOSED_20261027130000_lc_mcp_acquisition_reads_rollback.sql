-- =============================================================================
-- ROLLBACK of PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL only: the runner proves that apply → rollback restores the
-- pre-apply catalog fingerprint exactly.
-- =============================================================================
-- Drops EXACTLY the five functions the apply created (their grants go with them). The 1.0 reader
-- (role, policies, self-check, the operations reads) and the optional 1.1 / 1.2 reads are NOT touched. Idempotent.
--
-- KILL SWITCH without a rollback (stops the acquisition reads only, keeps every other read):
--   revoke execute on function public.lc_mcp_thread_followups(uuid), public.lc_mcp_thread_execution_log(uuid, integer),
--     public.lc_mcp_thread_offers(uuid), public.lc_mcp_thread_contact_eligibility(uuid), public.lc_mcp_operator_tasks(integer)
--     from lc_mcp_reader;
-- The MCP then reports each acquisition tool as not available. The whole credential's kill switch is
-- unchanged: `revoke lc_mcp_reader from authenticator;`.

set local lock_timeout = '5s';

drop function if exists public.lc_mcp_thread_followups(uuid);
drop function if exists public.lc_mcp_thread_execution_log(uuid, integer);
drop function if exists public.lc_mcp_thread_offers(uuid);
drop function if exists public.lc_mcp_thread_contact_eligibility(uuid);
drop function if exists public.lc_mcp_operator_tasks(integer);

notify pgrst, 'reload schema';
