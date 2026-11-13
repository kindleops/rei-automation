-- =============================================================================
-- ROLLBACK of PROPOSED_20261026120000_lc_mcp_conversation_intel.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL only: the runner proves that apply → rollback restores the
-- pre-apply catalog fingerprint exactly.
-- =============================================================================
-- Drops EXACTLY the four functions the apply created (their grants go with them). The 1.0 reader
-- (role, policies, self-check, the operations reads) is NOT touched. Idempotent.
--
-- KILL SWITCH without a rollback (stops the conversation reads only, keeps the 1.0 reads):
--   revoke execute on function public.lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer),
--     public.lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer),
--     public.lc_mcp_pipeline_counts(text, text, text, integer),
--     public.lc_mcp_conversation_signals(integer, text) from lc_mcp_reader;
-- The MCP then reports each conversation tool as not available. The whole credential's kill switch is
-- unchanged: `revoke lc_mcp_reader from authenticator;`.

set local lock_timeout = '5s';

drop function if exists public.lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer);
drop function if exists public.lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer);
drop function if exists public.lc_mcp_pipeline_counts(text, text, text, integer);
drop function if exists public.lc_mcp_conversation_signals(integer, text);

notify pgrst, 'reload schema';
