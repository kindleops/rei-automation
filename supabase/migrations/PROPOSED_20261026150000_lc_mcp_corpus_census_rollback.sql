-- =============================================================================
-- ROLLBACK of PROPOSED_20261026150000_lc_mcp_corpus_census.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL only: the runner proves that apply → rollback restores the
-- pre-apply catalog fingerprint exactly.
-- =============================================================================
-- Drops EXACTLY the two functions the apply created (their grants go with them). The 1.0 reader and the
-- 1.1 conversation reads are NOT touched. Idempotent.
--
-- KILL SWITCH without a rollback (stops the census reads only):
--   revoke execute on function public.lc_mcp_corpus_census(text), public.lc_mcp_lead_screen(text, integer, text, text) from lc_mcp_reader;
-- The MCP then reports each census tool as not available.

set local lock_timeout = '5s';

drop function if exists public.lc_mcp_corpus_census(text);
drop function if exists public.lc_mcp_lead_screen(text, integer, text, text);

notify pgrst, 'reload schema';
